import { after, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/mosaic/supabase'
import { getLastIngestionAt, getPreferredHomeStories, FRESHNESS_THRESHOLD_MS } from '@/lib/mosaic/db'
import { refreshSegment } from '@/lib/mosaic/pipeline'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Minimum cached stories required to declare the feed "ready"
const MIN_STORIES_FOR_READY = 1

// In-memory debounce so rapid client polling doesn't spawn concurrent refreshSegment calls
let lastRefreshTriggerTime = 0
const REFRESH_TRIGGER_COOLDOWN_MS = 60 * 1000

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
  const t0 = Date.now()
  console.log(`[Status][${new Date().toISOString().slice(11, 23)}] GET /api/home/status called`)
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

    console.log(`[Status][${new Date().toISOString().slice(11, 23)}] Lock check: activeLock=${!!activeLock} refreshStartedAt=${refreshStartedAt ?? 'none'}`)

    // ── 2. Last successful ingestion timestamp ─────────────────────────────
    const lastIngestion = await getLastIngestionAt().catch(() => null)
    const ageMs = lastIngestion ? now - lastIngestion.getTime() : null
    const ageSeconds = ageMs !== null ? Math.round(ageMs / 1000) : null

    console.log(`[Status][${new Date().toISOString().slice(11, 23)}] Last ingestion: ${lastIngestion?.toISOString() ?? 'never'} (age: ${ageSeconds ?? 'n/a'}s)`)

    // ── 3. Current story count in homepage_story_cache ─────────────────────
    const stories = await getPreferredHomeStories(20, 0).catch(() => [])
    const storyCount = stories.length

    console.log(`[Status][${new Date().toISOString().slice(11, 23)}] Story count in cache: ${storyCount}`)

    // ── 4. Derive status & trigger background refresh safely ───────────────
    let status: 'ready' | 'refreshing' | 'stale' | 'error'
    const isDataStale = !lastIngestion || ageMs === null || ageMs > FRESHNESS_THRESHOLD_MS || storyCount < MIN_STORIES_FOR_READY

    if (activeLock) {
      status = storyCount >= MIN_STORIES_FOR_READY ? 'ready' : 'refreshing'
    } else if (isDataStale) {
      const timeSinceLastTrigger = now - lastRefreshTriggerTime
      if (timeSinceLastTrigger < REFRESH_TRIGGER_COOLDOWN_MS) {
        // A refresh was already scheduled recently; report refreshing to client and prevent duplicate task
        console.log(`[Status][${new Date().toISOString().slice(11, 23)}] Refresh already scheduled ${Math.round(timeSinceLastTrigger / 1000)}s ago — reporting refreshing`)
        status = storyCount >= MIN_STORIES_FOR_READY ? 'ready' : 'refreshing'
      } else {
        lastRefreshTriggerTime = now
        status = storyCount >= MIN_STORIES_FOR_READY ? 'ready' : 'refreshing'
        console.log(`[Status][${new Date().toISOString().slice(11, 23)}] Data is stale — scheduling single background refresh`)
        after(async () => {
          await refreshSegment('initial').catch((err) => {
            console.error(`[Status][${new Date().toISOString().slice(11, 23)}] Background refresh failed:`, err)
          })
        })
      }
    } else {
      status = 'ready'
    }

    console.log(`[Status][${new Date().toISOString().slice(11, 23)}] Response: status=${status} storyCount=${storyCount} ageSeconds=${ageSeconds ?? 'n/a'} (took ${Date.now() - t0}ms)`)

    return NextResponse.json({
      status,
      lastUpdated: lastIngestion?.toISOString() ?? null,
      ageSeconds,
      refreshStartedAt,
      storyCount,
    })
  } catch (error) {
    console.error(`[Status][${new Date().toISOString().slice(11, 23)}] GET /api/home/status threw:`, error)
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
