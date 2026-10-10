import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/mosaic/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000

/**
 * POST /api/maintenance/flush-articles
 *
 * Clears `news_articles`, `topic_articles`, and `topics` when the oldest
 * article in `news_articles` is 31 or more days old.
 *
 * This is a periodic deep-clean to prevent unbounded table growth.
 * It cascades through: topics → topic_articles → news_articles (in order,
 * to avoid FK constraint failures depending on your Supabase cascade config).
 *
 * Response: { flushed: boolean, reason: string, oldestArticleAgeSeconds?: number }
 */
export async function POST() {
  try {
    const supabase = getSupabaseAdmin()

    // Find the oldest article by published_at (fall back to created_at if needed)
    const { data: oldest, error: selectError } = await supabase
      .from('news_articles')
      .select('published_at')
      .order('published_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (selectError) {
      return NextResponse.json(
        { flushed: false, reason: 'Could not query news_articles: ' + selectError.message },
        { status: 500 },
      )
    }

    if (!oldest) {
      return NextResponse.json({ flushed: false, reason: 'news_articles is already empty.' })
    }

    const oldestDate = oldest.published_at ? new Date(oldest.published_at) : null
    if (!oldestDate || isNaN(oldestDate.getTime())) {
      return NextResponse.json({ flushed: false, reason: 'Oldest article has no valid published_at timestamp.' })
    }

    const articleAge = Date.now() - oldestDate.getTime()
    const oldestArticleAgeSeconds = Math.round(articleAge / 1000)

    if (articleAge < THIRTY_ONE_DAYS_MS) {
      return NextResponse.json({
        flushed: false,
        reason: `Oldest article is only ${oldestArticleAgeSeconds}s old (threshold: ${THIRTY_ONE_DAYS_MS / 1000}s). Not flushing.`,
        oldestArticleAgeSeconds,
      })
    }

    // ── Delete in dependency order ─────────────────────────────────────────
    // 1. topic_articles (references both topics and news_articles)
    const { error: topicArticlesError } = await supabase
      .from('topic_articles')
      .delete()
      .neq('topic_id', '')

    if (topicArticlesError) {
      return NextResponse.json(
        { flushed: false, reason: 'Failed to delete topic_articles: ' + topicArticlesError.message },
        { status: 500 },
      )
    }

    // 2. topics
    const { error: topicsError } = await supabase
      .from('topics')
      .delete()
      .neq('id', '')

    if (topicsError) {
      return NextResponse.json(
        { flushed: false, reason: 'Failed to delete topics: ' + topicsError.message },
        { status: 500 },
      )
    }

    // 3. news_articles
    const { error: articlesError } = await supabase
      .from('news_articles')
      .delete()
      .neq('id', '')

    if (articlesError) {
      return NextResponse.json(
        { flushed: false, reason: 'Failed to delete news_articles: ' + articlesError.message },
        { status: 500 },
      )
    }

    return NextResponse.json({
      flushed: true,
      reason: `Oldest article was ${oldestArticleAgeSeconds}s old (>=${THIRTY_ONE_DAYS_MS / 1000}s threshold). Flushed topic_articles, topics, and news_articles.`,
      oldestArticleAgeSeconds,
    })
  } catch (error) {
    console.error('[API Error] /api/maintenance/flush-articles failed:', error)
    return NextResponse.json(
      { flushed: false, reason: 'Unexpected error.' },
      { status: 500 },
    )
  }
}
