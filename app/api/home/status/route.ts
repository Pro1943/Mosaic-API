import { after, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/mosaic/supabase'
import { acquireIngestionLease, getLastIngestionAt, getHomeStories } from '@/lib/mosaic/db'
import { refreshSegment } from '@/lib/mosaic/pipeline'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Cache is considered stale after 1 hour (matches ONE_HOUR_MS in db.ts)
const FRESHNESS_THRESHOLD_MS = 60 * 60 * 1000

/**
 * GET /api/home/status
 *
 * Returns the current freshness state of the news pipeline without
 * returning the actual stories. The frontend polls this endpoint to
 * know whether it is safe to render the homepage feed.
 *
 * Response shape:
 *   { status: 'ready' | 'refreshing' | 'stale' | 'error',
 *     lastUpdated: string | null,
 *     ageSeconds: number | null,
 *     refreshStartedAt: string | null,
 *     storyCount: number }
 */
export async function GET() {
  try {
    const supabase = getSupabaseAdmin()
    const now = Date.now()

    // ── 1. Check for an active ingestion lock ──────────────────────────────
    const lockThreshold = new Date(now - 5 * 60 * 1000).toISOString()
    const { data: lockRows } = await supabase
      .from('ingestion_runs')
      .select('id, details, finished_at')
      .eq('status', 'failed')
      .gte('finished_at', lockThreshold)
      .order('finished_at', { ascending: false })
      .limit(10)

    const activeLock = (lockRows ?? []).find((row) => {
      const details = row.details as { lock?: boolean; started_at?: string } | null
      return details?.lock === true
    })

    const refreshStartedAt =
      activeLock && (activeLock.details as { started_at?: string } | null)?.started_at
        ? (activeLock.details as { started_at: string }).started_at
        : null

    // ── 2. Last successful ingestion timestamp ─────────────────────────────
    const lastIngestion = await getLastIngestionAt().catch(() => null)
    const ageMs = lastIngestion ? now - lastIngestion.getTime() : null
    const ageSeconds = ageMs !== null ? Math.round(ageMs / 1000) : null

    // ── 3. Current story count in homepage_story_cache ─────────────────────
    const stories = await getHomeStories(20, 0).catch(() => [])
    const storyCount = stories.length

    // ── 4. Derive status ───────────────────────────────────────────────────
    let status: 'ready' | 'refreshing' | 'stale' | 'error'

    if (activeLock) {
      // A refresh is in flight
      status = 'refreshing'
    } else if (!lastIngestion || ageMs === null || ageMs > FRESHNESS_THRESHOLD_MS || storyCount === 0) {
      // No recent success — stale or never run
      status = 'stale'

      // Kick off a background refresh so the next poll will find data
      after(async () => {
        await refreshSegment('all').catch((err) => {
          console.error('[Status] Background refresh triggered by /api/home/status failed:', err)
        })
      })
    } else {
      status = 'ready'
    }

    return NextResponse.json({
      status,
      lastUpdated: lastIngestion?.toISOString() ?? null,
      ageSeconds,
      refreshStartedAt,
      storyCount,
    })
  } catch (error) {
    console.error('[API Error] /api/home/status failed:', error)
    return NextResponse.json(
      {
        status: 'error',
        lastUpdated: null,
        ageSeconds: null,
        refreshStartedAt: null,
        storyCount: 0,
      },
      { status: 500 },
    )
  }
}
