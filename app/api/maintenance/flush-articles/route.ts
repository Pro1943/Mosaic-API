import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/mosaic/supabase'
import { deleteInvalidTopics } from '@/lib/mosaic/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000

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
 * POST /api/maintenance/flush-articles
 *
 * Safely prunes `news_articles` published 31 or more days ago,
 * cascading deletions to topic links and pruning orphaned topics.
 * Does NOT wipe active/recent news articles.
 * Requires bearer authorization via CRON_SECRET in production.
 */
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ flushed: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabaseAdmin()
    const cutoffDate = new Date(Date.now() - THIRTY_ONE_DAYS_MS).toISOString()

    // 1. Select only articles older than 31 days
    const { data: expiredArticles, error: selectError } = await supabase
      .from('news_articles')
      .select('id')
      .lt('published_at', cutoffDate)
      .limit(500)

    if (selectError) {
      return NextResponse.json(
        { flushed: false, reason: 'Could not query news_articles: ' + selectError.message },
        { status: 500 },
      )
    }

    if (!expiredArticles || expiredArticles.length === 0) {
      return NextResponse.json({
        flushed: false,
        reason: 'No articles older than 31 days found.',
        deletedCount: 0,
      })
    }

    const expiredIds = expiredArticles.map((a) => a.id)

    // 2. Delete ONLY expired articles (topic_articles cascades via FK on article_id)
    const { error: articlesError } = await supabase
      .from('news_articles')
      .delete()
      .in('id', expiredIds)

    if (articlesError) {
      return NextResponse.json(
        { flushed: false, reason: 'Failed to delete expired news_articles: ' + articlesError.message },
        { status: 500 },
      )
    }

    // 3. Clean up any topics that no longer have valid clusters
    await deleteInvalidTopics().catch((err) => {
      console.warn('[Maintenance] deleteInvalidTopics warning after flush:', err)
    })

    return NextResponse.json({
      flushed: true,
      reason: `Successfully deleted ${expiredIds.length} articles older than 31 days and pruned orphaned topics.`,
      deletedCount: expiredIds.length,
    })
  } catch (error) {
    console.error('[API Error] /api/maintenance/flush-articles failed:', error)
    return NextResponse.json(
      { flushed: false, reason: 'Unexpected error.' },
      { status: 500 },
    )
  }
}
