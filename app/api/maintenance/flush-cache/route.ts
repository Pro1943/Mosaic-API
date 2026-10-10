import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/mosaic/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * POST /api/maintenance/flush-cache
 *
 * Clears `homepage_story_cache` and `narrative_cache` when the most
 * recently updated cache entry is older than 24 hours.
 *
 * Designed to be called by the frontend before triggering a new ingestion
 * cycle when it detects the displayed stories are more than one day old.
 * It does NOT flush if the cache is still fresh — this prevents accidentally
 * wiping valid data.
 *
 * Response: { flushed: boolean, reason: string, cacheAgeSeconds?: number }
 */
export async function POST() {
  try {
    const supabase = getSupabaseAdmin()

    // Find the most recently updated row in homepage_story_cache
    const { data: newest, error: selectError } = await supabase
      .from('homepage_story_cache')
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (selectError) {
      return NextResponse.json(
        { flushed: false, reason: 'Could not query homepage_story_cache: ' + selectError.message },
        { status: 500 },
      )
    }

    // If the cache is empty there is nothing to flush
    if (!newest) {
      return NextResponse.json({ flushed: false, reason: 'Cache is already empty.' })
    }

    const cacheAge = Date.now() - new Date(newest.updated_at).getTime()
    const cacheAgeSeconds = Math.round(cacheAge / 1000)

    if (cacheAge < ONE_DAY_MS) {
      return NextResponse.json({
        flushed: false,
        reason: `Cache is only ${cacheAgeSeconds}s old (threshold: ${ONE_DAY_MS / 1000}s). Not flushing.`,
        cacheAgeSeconds,
      })
    }

    // Cache is stale — delete both homepage_story_cache and narrative_cache
    const { error: homeDeleteError } = await supabase
      .from('homepage_story_cache')
      .delete()
      .neq('topic_id', '')

    if (homeDeleteError) {
      return NextResponse.json(
        { flushed: false, reason: 'Failed to delete homepage_story_cache: ' + homeDeleteError.message },
        { status: 500 },
      )
    }

    const { error: narrativeDeleteError } = await supabase
      .from('narrative_cache')
      .delete()
      .neq('topic_id', '')

    if (narrativeDeleteError) {
      // Non-fatal: homepage was already cleared; log but continue
      console.warn('[Maintenance] Failed to clear narrative_cache:', narrativeDeleteError.message)
    }

    return NextResponse.json({
      flushed: true,
      reason: `Cache was ${cacheAgeSeconds}s old (>${ONE_DAY_MS / 1000}s threshold). Flushed homepage_story_cache and narrative_cache.`,
      cacheAgeSeconds,
    })
  } catch (error) {
    console.error('[API Error] /api/maintenance/flush-cache failed:', error)
    return NextResponse.json(
      { flushed: false, reason: 'Unexpected error.' },
      { status: 500 },
    )
  }
}
