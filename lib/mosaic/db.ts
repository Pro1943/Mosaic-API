import { getSupabaseAdmin } from './supabase'
import { stableHash, slugify } from './hash'
import type {
  ArticleExtraction,
  HomeStory,
  NormalizedArticle,
  ComparisonAnalysis,
  NarrativeAnalysis,
  TopicMeta,
  TopicSource,
} from './types'
import { createMosaicError } from './env'

export const FRESHNESS_THRESHOLD_MS = 60 * 60 * 1000
export const FRESH_NEWS_WINDOW_MS = 24 * 60 * 60 * 1000
export const RETENTION_NEWS_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
const ONE_HOUR_MS = FRESHNESS_THRESHOLD_MS
const AI_ANALYSIS_CACHE_VERSION = 2

// ── Logging ──────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().slice(11, 23) }
function log(msg: string, extra?: unknown) {
  const line = `[DB][${ts()}] ${msg}`
  if (extra !== undefined) console.log(line, typeof extra === 'object' ? JSON.stringify(extra) : extra)
  else console.log(line)
}
function logErr(msg: string, err?: unknown) {
  console.error(`[DB][${ts()}] ERROR: ${msg}`, err ?? '')
}

type TopicRow = {
  id: string
  title_hint: string
  created_at: string
  updated_at: string
}

type ArticleRow = {
  id: string
  provider: NormalizedArticle['provider']
  source: string
  headline: string
  author: string | null
  published_at: string | null
  body: string
  url: string
}

export async function getLastIngestionAt() {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('ingestion_runs')
    .select('finished_at')
    .eq('status', 'success')
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    logErr('getLastIngestionAt failed', error)
    throw createMosaicError('SUPABASE_SELECT_FAILED', 'Could not read ingestion status from Supabase.', error)
  }
  const result = data?.finished_at ? new Date(data.finished_at) : null
  log(`getLastIngestionAt → ${result?.toISOString() ?? 'null (never run)'}`)
  return result
}

export async function needsIngestion() {
  const last = await getLastIngestionAt()
  const { data: cached, error } = await getSupabaseAdmin()
    .from('homepage_story_cache')
    .select('topic_id')
    .limit(1)

  const hasStories = !error && (cached ?? []).length > 0
  const isStale = !last || Date.now() - last.getTime() > ONE_HOUR_MS
  const needs = !hasStories || isStale
  log(`needsIngestion → ${needs} (hasStories: ${hasStories}, isStale: ${isStale}, last: ${last?.toISOString() ?? 'never'})`)
  return needs
}

export async function acquireIngestionLease(leaseTimeoutMs = 5 * 60 * 1000): Promise<boolean> {
  const supabase = getSupabaseAdmin()
  const now = new Date()
  const lockThreshold = new Date(now.getTime() - leaseTimeoutMs).toISOString()

  const { data: recentRunning } = await supabase
    .from('ingestion_runs')
    .select('id, details, finished_at')
    .eq('status', 'failed')
    .gte('finished_at', lockThreshold)
    .order('finished_at', { ascending: false })
    .limit(10)

  const activeLock = recentRunning?.find((run) => {
    const details = run.details as { lock?: boolean } | null
    return details && details.lock === true
  })

  if (activeLock) {
    log(`acquireIngestionLease → DENIED (active lock id=${activeLock.id})`)
    return false
  }

  const { error } = await supabase.from('ingestion_runs').insert({
    category: 'world',
    status: 'failed',
    details: { lock: true, started_at: now.toISOString() },
    finished_at: now.toISOString(),
  })

  if (error) {
    logErr('acquireIngestionLease insert failed', error)
    return false
  }
  log('acquireIngestionLease → ACQUIRED')
  return true
}

export async function releaseIngestionLease() {
  const supabase = getSupabaseAdmin()
  const lockThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { data: activeLocks } = await supabase
    .from('ingestion_runs')
    .select('id, details')
    .eq('status', 'failed')
    .gte('finished_at', lockThreshold)

  const lockIds = (activeLocks ?? [])
    .filter((run) => (run.details as { lock?: boolean } | null)?.lock === true)
    .map((run) => run.id)

  if (lockIds.length > 0) {
    await supabase.from('ingestion_runs').delete().in('id', lockIds)
    log(`releaseIngestionLease → deleted ${lockIds.length} lock row(s)`)
  } else {
    log('releaseIngestionLease → no lock rows found to delete')
  }
}

export async function recordIngestionRun(status: 'success' | 'failed', details: unknown) {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase.from('ingestion_runs').insert({
    category: 'world',
    status,
    details,
    finished_at: new Date().toISOString(),
  })

  if (error) {
    logErr(`recordIngestionRun(${status}) insert failed`, error)
    throw createMosaicError('SUPABASE_INSERT_FAILED', 'Could not record ingestion status in Supabase.', error)
  }
  log(`recordIngestionRun → status=${status}`, details)
}

export async function upsertArticlesAndTopics(articles: NormalizedArticle[]) {
  const retainedArticles = articles.filter(isRetainedArticle)
  log(`upsertArticlesAndTopics → ${retainedArticles.length} retained of ${articles.length} articles`)
  if (!retainedArticles.length) return []
  const supabase = getSupabaseAdmin()
  const articleRows = retainedArticles.map((article) => ({
    id: stableHash(article.url),
    category: 'world',
    provider: article.provider,
    source: article.source,
    headline: article.headline,
    author: article.author,
    published_at: article.published_at,
    body: article.body,
    url: article.url,
  }))

  const { error: articleError } = await supabase.from('news_articles').upsert(articleRows, { onConflict: 'url' })
  if (articleError) throw createMosaicError('SUPABASE_ARTICLE_UPSERT_FAILED', 'Could not store fetched news articles.', articleError)

  const cutoff = new Date(Date.now() - RETENTION_NEWS_WINDOW_MS).toISOString()
  const { data: recentDbArticles } = await supabase
    .from('news_articles')
    .select('provider, source, headline, author, published_at, body, url')
    .gte('published_at', cutoff)
    .limit(100)

  const combinedMap = new Map<string, NormalizedArticle>()
  for (const art of retainedArticles) combinedMap.set(art.url, art)
  for (const row of (recentDbArticles ?? []) as ArticleRow[]) {
    if (!combinedMap.has(row.url)) {
      combinedMap.set(row.url, {
        provider: row.provider ?? 'unknown',
        source: row.source,
        headline: row.headline,
        author: row.author,
        published_at: row.published_at,
        body: row.body,
        url: row.url,
      })
    }
  }

  const allArticles = Array.from(combinedMap.values())
  const clusters = clusterArticles(allArticles)
  const topicIds: string[] = []
  log(`upsertArticlesAndTopics → formed ${clusters.length} valid multi-source clusters from ${allArticles.length} pooled articles`)

  for (const cluster of clusters) {
    if (!isValidCluster(cluster)) continue

    const titleHint = cluster[0].headline
    const topicId = `${slugify(titleHint)}-${stableHash(cluster.map((article) => article.headline).sort().join('|'))}`
    topicIds.push(topicId)
    const now = new Date().toISOString()

    const { error: topicError } = await supabase.from('topics').upsert(
      {
        id: topicId,
        category: 'world',
        title_hint: titleHint,
        updated_at: now,
      },
      { onConflict: 'id' },
    )
    if (topicError) throw createMosaicError('SUPABASE_TOPIC_UPSERT_FAILED', 'Could not store article topic clusters.', topicError)

    const links = cluster.map((article) => ({
      topic_id: topicId,
      article_id: stableHash(article.url),
    }))

    const { error: linkError } = await supabase.from('topic_articles').upsert(links, { onConflict: 'topic_id,article_id' })
    if (linkError) throw createMosaicError('SUPABASE_TOPIC_LINK_FAILED', 'Could not link articles to topics.', linkError)
  }
  if (topicIds.length > 0) {
    await Promise.all([
      supabase.from('article_extractions').delete().in('topic_id', topicIds),
      supabase.from('comparison_cache').delete().in('topic_id', topicIds),
      supabase.from('narrative_cache').delete().in('topic_id', topicIds),
    ])
  }
  return topicIds
}

function clusterArticles(articles: NormalizedArticle[]) {
  const validArticles = articles.filter(isNewsLikeArticle)
  const clusters: NormalizedArticle[][] = []

  for (const article of validArticles) {
    const tokens = headlineTokens(article.headline)
    let bestCluster: NormalizedArticle[] | null = null
    let bestScore = 0

    for (const cluster of clusters) {
      for (const member of cluster) {
        const memberTokens = headlineTokens(member.headline)
        const shared = sharedTokenCount(tokens, memberTokens)
        const jaccardScore = jaccard(tokens, memberTokens)

        if (jaccardScore >= 0.35 || (jaccardScore >= 0.2 && shared >= 3)) {
          const score = jaccardScore + (shared * 0.25)
          if (score > bestScore) {
            bestScore = score
            bestCluster = cluster
          }
        }
      }
    }

    if (bestCluster && bestScore > 0) {
      bestCluster.push(article)
    } else {
      clusters.push([article])
    }
  }

  return clusters.filter(isValidCluster).sort((a, b) => b.length - a.length)
}

function sharedTokenCount(a: Set<string>, b: Set<string>) {
  return [...a].filter((token) => b.has(token)).length
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'are',
  'has',
  'have',
  'into',
  'over',
  'after',
  'before',
  'news',
  'daily',
  'today',
  'report',
  'reports',
  'says',
  'said',
  'new',
  'first',
  'latest',
  'top',
  'best',
  'global',
  'world',
  'major',
  'market',
  'launch',
  'launches',
  'unveils',
  'announces',
  'deal',
  'plan',
  'rules',
  'system',
  'full',
  'episode',
  'guide',
  'watch',
  'live',
  'update',
  'updates',
  'video',
  'star',
  'sign',
  'horoscope',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  '2024',
  '2025',
  '2026',
  '2027',
  '2028',
])

function cleanHeadline(headline: string): string {
  // Strip publisher branding suffixes like " - Reuters", " | CNN", " — BBC News", " / AP"
  return headline.replace(/\s*[-–—|/]\s*[^–—|-|/]{2,}$/g, '').trim()
}

function headlineTokens(headline: string) {
  const cleaned = cleanHeadline(headline)
  return new Set(
    cleaned
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
      .map((token) => (token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token)),
  )
}

function jaccard(a: Set<string>, b: Set<string>) {
  const intersection = [...a].filter((token) => b.has(token)).length
  const union = new Set([...a, ...b]).size
  return union ? intersection / union : 0
}

export function isRetainedArticle(article: Pick<NormalizedArticle, 'published_at'>) {
  if (!article.published_at) return false
  const publishedAt = new Date(article.published_at).getTime()
  if (Number.isNaN(publishedAt)) return false
  const now = Date.now()
  return publishedAt >= now - RETENTION_NEWS_WINDOW_MS && publishedAt <= now + 15 * 60 * 1000
}

function isValidCluster(articles: NormalizedArticle[] | ArticleRow[]) {
  const newsArticles = articles.filter(isNewsLikeArticle)
  if (newsArticles.length < 2) return false
  const uniqueSources = new Set(newsArticles.map((a) => a.source.toLowerCase().trim()))
  return uniqueSources.size >= 2
}

function isNewsLikeArticle(article: Pick<NormalizedArticle, 'headline' | 'url' | 'body'>) {
  if (!article.headline || !article.url || !article.body) return false

  let url: URL
  try {
    url = new URL(article.url)
  } catch {
    return false
  }

  const host = url.hostname.toLowerCase()
  const path = url.pathname.toLowerCase()
  const blockedHostPatterns = [/\.ac\.uk$/, /\.edu$/, /(^|\.)reddit\.com$/]
  const blockedPathPatterns = [
    /\/courses?\//,
    /postgraduate/,
    /undergraduate/,
    /phd/,
    /supervisor/,
    /program/,
    /programme/,
    /degree/,
    /prospectus/,
    /horoscope/,
    /lottery/,
    /puzzles/,
    /crosswords/,
  ]
  const blockedHeadlinePatterns = [
    /find a phd/i,
    /\bmsc\b/i,
    /\bpgdip\b/i,
    /money, banking and finance/i,
    /social research/i,
    /horoscope/i,
    /star sign/i,
    /mystic meg/i,
    /astrology/i,
    /zodiac/i,
    /lottery/i,
    /lotto/i,
    /powerball/i,
    /mega millions/i,
    /winning numbers/i,
    /jackpot/i,
    /full episode/i,
    /tv guide/i,
    /where to watch/i,
    /crossword/i,
    /wordle/i,
    /sudoku/i,
  ]

  return (
    !blockedHostPatterns.some((pattern) => pattern.test(host)) &&
    !blockedPathPatterns.some((pattern) => pattern.test(path)) &&
    !blockedHeadlinePatterns.some((pattern) => pattern.test(article.headline))
  )
}

export async function deleteInvalidTopics(topicIds?: string[]) {
  if (topicIds && topicIds.length === 0) return
  const supabase = getSupabaseAdmin()
  let query = supabase.from('topics').select('id')
  if (topicIds?.length) query = query.in('id', topicIds)
  const { data, error } = await query
  if (error) throw createMosaicError('SUPABASE_TOPICS_SELECT_FAILED', 'Could not read topics for validation.', error)

  // 4.3 fix: collect all invalid IDs first, then issue a single batch delete.
  // This replaces the previous N+1 pattern (one DELETE per topic).
  const invalidIds: string[] = []
  for (const topic of data ?? []) {
    const articles = await getArticlesForTopic(topic.id)
    if (!isValidCluster(articles)) {
      invalidIds.push(topic.id)
    }
  }

  if (invalidIds.length > 0) {
    // Purge cached cards for invalid topics so single-source stories never show on homepage
    await supabase.from('homepage_story_cache').delete().in('topic_id', invalidIds)
    const { error: deleteError } = await supabase.from('topics').delete().in('id', invalidIds)
    if (deleteError) throw createMosaicError('SUPABASE_TOPIC_DELETE_FAILED', 'Could not delete invalid topic clusters.', deleteError)
    log(`deleteInvalidTopics → deleted ${invalidIds.length} invalid topic(s) and their cached homepage cards`)
  } else {
    log('deleteInvalidTopics → no invalid topics found')
  }
}

export async function getTopicsNeedingHomepageCards(limit = 8) {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('topics')
    .select('id, title_hint, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (error) throw createMosaicError('SUPABASE_TOPICS_SELECT_FAILED', 'Could not read topics from Supabase.', error)
  log(`getTopicsNeedingHomepageCards(limit=${limit}) → ${(data ?? []).length} topics`)
  return (data ?? []) as TopicRow[]
}

export async function getHomeStories(limit = 3, offset = 0): Promise<HomeStory[]> {
  return queryHomeStories(limit, offset)
}

export async function getPreferredHomeStories(limit = 3, offset = 0): Promise<HomeStory[]> {
  const freshStories = await queryHomeStories(1, 0, new Date(Date.now() - FRESH_NEWS_WINDOW_MS).toISOString())
  if (freshStories.length > 0) {
    return queryHomeStories(limit, offset, new Date(Date.now() - FRESH_NEWS_WINDOW_MS).toISOString())
  }
  return queryHomeStories(limit, offset, new Date(Date.now() - RETENTION_NEWS_WINDOW_MS).toISOString())
}

async function queryHomeStories(limit: number, offset: number, publishedSince?: string): Promise<HomeStory[]> {
  const supabase = getSupabaseAdmin()
  let query = supabase
    .from('homepage_story_cache')
    .select('topic_id, neutral_headline, snippet, source_count, sources_preview, latest_published_at, updated_at')
    .order('latest_published_at', { ascending: false })
    .order('source_count', { ascending: false })
    .range(offset, offset + limit - 1)

  if (publishedSince) query = query.gte('latest_published_at', publishedSince)

  const { data, error } = await query

  if (error) {
    logErr('getHomeStories failed', error)
    throw createMosaicError('SUPABASE_HOME_STORIES_SELECT_FAILED', 'Could not read homepage stories from Supabase.', error)
  }
  log(`queryHomeStories(limit=${limit}, offset=${offset}, publishedSince=${publishedSince ?? 'none'}) → ${(data ?? []).length} stories`)
  return (data ?? []) as HomeStory[]
}

export async function deleteOldStories(days = 3) {
  const supabase = getSupabaseAdmin()
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  await supabase.from('homepage_story_cache').delete().lt('latest_published_at', cutoff)
  await supabase.from('topics').delete().lt('updated_at', cutoff)
  await supabase.from('news_articles').delete().lt('published_at', cutoff)
}

export async function getUncachedTopics(limit = 3): Promise<TopicRow[]> {
  const supabase = getSupabaseAdmin()
  const { data: cached } = await supabase
    .from('homepage_story_cache')
    .select('topic_id')

  const cachedIds = (cached ?? []).map((row) => row.topic_id)

  let query = supabase
    .from('topics')
    .select('id, title_hint, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (cachedIds.length > 0) {
    query = query.not('id', 'in', `(${cachedIds.join(',')})`)
  }

  const { data, error } = await query
  if (error) return []
  return (data ?? []) as TopicRow[]
}

export async function upsertHomepageCards(stories: HomeStory[]) {
  if (!stories.length) return

  const supabase = getSupabaseAdmin()
  const rows = stories.map((story) => ({
    ...story,
    category: 'world',
  }))
  const { error } = await supabase.from('homepage_story_cache').upsert(rows, { onConflict: 'topic_id' })
  if (error) throw createMosaicError('SUPABASE_HOME_STORIES_UPSERT_FAILED', 'Could not cache homepage stories.', error)
}

export async function clearHomepageCache() {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase.from('homepage_story_cache').delete().neq('topic_id', '')
  if (error) throw createMosaicError('SUPABASE_HOME_STORIES_DELETE_FAILED', 'Could not clear stale homepage cache.', error)
}

export async function getArticlesForTopic(topicId: string): Promise<ArticleRow[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('topic_articles')
    .select('news_articles(id, source, headline, author, published_at, body, url)')
    .eq('topic_id', topicId)

  if (error) throw createMosaicError('SUPABASE_TOPIC_ARTICLES_FAILED', 'Could not read source articles for this topic.', error)

  return (data ?? [])
    .map((row) => (row as { news_articles?: ArticleRow | ArticleRow[] }).news_articles)
    .flat()
    .filter(Boolean) as ArticleRow[]
}

export async function getTopicMeta(topicId: string): Promise<TopicMeta> {
  const supabase = getSupabaseAdmin()
  const { data: homepageStory, error: homepageStoryError } = await supabase
    .from('homepage_story_cache')
    .select('topic_id, neutral_headline, snippet, source_count')
    .eq('topic_id', topicId)
    .maybeSingle()

  if (homepageStoryError) throw createMosaicError('SUPABASE_TOPIC_SELECT_FAILED', 'Could not read topic summary from Supabase.', homepageStoryError)
  if (!homepageStory) throw createMosaicError('TOPIC_NOT_FOUND', 'No cached topic was found for this article route.', { topicId })

  const articles = (await getArticlesForTopic(topicId)).filter(isRetainedArticle)
  const published = articles
    .map((article) => article.published_at)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null

  const uniqueSourceCount = new Set(articles.map((a) => a.source.toLowerCase().trim())).size

  return {
    topic_id: topicId,
    neutral_headline: homepageStory.neutral_headline,
    snippet: homepageStory.snippet,
    published_at: published,
    source_count: uniqueSourceCount,
    sources: articles.map<TopicSource>((article) => ({
      name: article.source,
      url: article.url,
      headline: article.headline,
      framing: article.body?.trim().slice(0, 200) ?? article.headline,
    })),
  }
}

export async function getCachedExtractions(topicId: string): Promise<ArticleExtraction[] | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase.from('article_extractions').select('extractions').eq('topic_id', topicId).maybeSingle()
  if (error) throw createMosaicError('SUPABASE_SOURCE_CLAIMS_SELECT_FAILED', 'Could not read cached source claim extraction.', error)
  const cached = data?.extractions
  if (
    !cached ||
    typeof cached !== 'object' ||
    Array.isArray(cached) ||
    cached.prompt_version !== AI_ANALYSIS_CACHE_VERSION ||
    !Array.isArray(cached.items)
  ) {
    return null
  }
  return cached.items as ArticleExtraction[]
}

export async function upsertExtractions(topicId: string, extractions: ArticleExtraction[]) {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase.from('article_extractions').upsert(
    {
      topic_id: topicId,
      extractions: {
        prompt_version: AI_ANALYSIS_CACHE_VERSION,
        items: extractions,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'topic_id' },
  )
  if (error) throw createMosaicError('SUPABASE_SOURCE_CLAIMS_UPSERT_FAILED', 'Could not cache source claim extraction.', error)
}

export async function getCachedComparison(topicId: string): Promise<ComparisonAnalysis | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase.from('comparison_cache').select('analysis').eq('topic_id', topicId).maybeSingle()
  if (error) throw createMosaicError('SUPABASE_COMPARISON_SELECT_FAILED', 'Could not read cached comparison analysis.', error)
  const cached = data?.analysis
  if (!cached || typeof cached !== 'object' || Array.isArray(cached) || cached.prompt_version !== AI_ANALYSIS_CACHE_VERSION) {
    return null
  }
  const { prompt_version: _, ...comparison } = cached
  return comparison as ComparisonAnalysis
}

export async function upsertComparison(topicId: string, comparison: ComparisonAnalysis) {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase.from('comparison_cache').upsert(
    {
      topic_id: topicId,
      analysis: {
        ...comparison,
        prompt_version: AI_ANALYSIS_CACHE_VERSION,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'topic_id' },
  )
  if (error) throw createMosaicError('SUPABASE_COMPARISON_UPSERT_FAILED', 'Could not cache comparison analysis.', error)
}

export async function getCachedNarrative(topicId: string): Promise<NarrativeAnalysis | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase.from('narrative_cache').select('analysis').eq('topic_id', topicId).maybeSingle()
  if (error) throw createMosaicError('SUPABASE_NARRATIVE_SELECT_FAILED', 'Could not read cached narrative analysis.', error)
  const cached = data?.analysis
  if (!cached || typeof cached !== 'object' || Array.isArray(cached) || cached.prompt_version !== AI_ANALYSIS_CACHE_VERSION) {
    return null
  }
  const { prompt_version: _, ...narrative } = cached
  return narrative as NarrativeAnalysis
}

export async function upsertNarrative(topicId: string, narrative: NarrativeAnalysis) {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase.from('narrative_cache').upsert(
    {
      topic_id: topicId,
      analysis: {
        ...narrative,
        prompt_version: AI_ANALYSIS_CACHE_VERSION,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'topic_id' },
  )
  if (error) throw createMosaicError('SUPABASE_NARRATIVE_UPSERT_FAILED', 'Could not cache narrative analysis.', error)
}
