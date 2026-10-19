import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/mosaic/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    // If no CRON_SECRET configured, only allow in local development
    return process.env.NODE_ENV !== 'production'
  }
  const authHeader = request.headers.get('authorization')
  const cronHeader = request.headers.get('x-cron-secret')
  return authHeader === `Bearer ${secret}` || cronHeader === secret
}

/**
 * POST /api/maintenance/flush-cache
 *
 * Flushes stale entries from cache tables (`homepage_story_cache`,
 * `narrative_cache`, `comparison_cache`, and `article_extractions`)
 * when the newest cache entry is older than 24 hours.
 * Uses date-bounded filtering rather than blanket deletes.
 * Requires bearer authorization via CRON_SECRET in production.
 */
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ flushed: false, error: 'Unauthorized' }, { status: 401 })
  }

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
        reason: `Newest cache entry is only ${cacheAgeSeconds}s old (threshold: ${ONE_DAY_MS / 1000}s). Not flushing.`,
        cacheAgeSeconds,
      })
    }

    const cutoff = new Date(Date.now() - ONE_DAY_MS).toISOString()

    // Cache is stale (> 24h) — safely flush entries older than cutoff across all cache tables
    await Promise.allSettled([
      supabase.from('homepage_story_cache').delete().lt('updated_at', cutoff),
      supabase.from('narrative_cache').delete().lt('updated_at', cutoff),
      supabase.from('comparison_cache').delete().lt('updated_at', cutoff),
      supabase.from('article_extractions').delete().lt('updated_at', cutoff),
    ])

    return NextResponse.json({
      flushed: true,
      reason: `Cache was ${cacheAgeSeconds}s old (>${ONE_DAY_MS / 1000}s threshold). Flushed stale cache entries.`,
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
