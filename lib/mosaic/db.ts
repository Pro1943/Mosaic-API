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

const ONE_HOUR_MS = 60 * 60 * 1000

type TopicRow = {
  id: string
  title_hint: string
  created_at: string
  updated_at: string
}

type ArticleRow = {
  id: string
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

  if (error) throw createMosaicError('SUPABASE_SELECT_FAILED', 'Could not read ingestion status from Supabase.', error)
  return data?.finished_at ? new Date(data.finished_at) : null
}

export async function needsIngestion() {
  const last = await getLastIngestionAt()
  return !last || Date.now() - last.getTime() > ONE_HOUR_MS
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
    return false
  }

  const { error } = await supabase.from('ingestion_runs').insert({
    status: 'failed',
    details: { lock: true, started_at: now.toISOString() },
    finished_at: now.toISOString(),
  })

  return !error
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
  }
}

export async function recordIngestionRun(status: 'success' | 'failed', details: unknown) {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase.from('ingestion_runs').insert({
    status,
    details,
    finished_at: new Date().toISOString(),
  })

  if (error) throw createMosaicError('SUPABASE_INSERT_FAILED', 'Could not record ingestion status in Supabase.', error)
}

export async function upsertArticlesAndTopics(articles: NormalizedArticle[]) {
  const supabase = getSupabaseAdmin()
  const articleRows = articles.map((article) => ({
    id: stableHash(article.url),
    source: article.source,
    headline: article.headline,
    author: article.author,
    published_at: article.published_at,
    body: article.body,
    url: article.url,
  }))

  const { error: articleError } = await supabase.from('news_articles').upsert(articleRows, { onConflict: 'url' })
  if (articleError) throw createMosaicError('SUPABASE_ARTICLE_UPSERT_FAILED', 'Could not store fetched news articles.', articleError)

  const clusters = clusterArticles(articles)
  for (const cluster of clusters) {
    if (!isValidCluster(cluster)) continue

    const titleHint = cluster[0].headline
    const topicId = `${slugify(titleHint)}-${stableHash(cluster.map((article) => article.headline).sort().join('|'))}`
    const now = new Date().toISOString()

    const { error: topicError } = await supabase.from('topics').upsert(
      {
        id: topicId,
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
}

function clusterArticles(articles: NormalizedArticle[]) {
  const validArticles = articles.filter(isNewsLikeArticle)
  const clusters: NormalizedArticle[][] = []

  for (const article of validArticles) {
    const tokens = headlineTokens(article.headline)
    const match = clusters.find((cluster) => {
      const primaryTokens = headlineTokens(cluster[0].headline)
      const shared = sharedTokenCount(tokens, primaryTokens)
      const jaccardScore = jaccard(tokens, primaryTokens)
      return jaccardScore >= 0.25 || shared >= 2
    })

    if (match) {
      match.push(article)
    } else {
      clusters.push([article])
    }
  }

  return clusters.filter(isValidCluster).sort((a, b) => b.length - a.length)
}

function sharedTokenCount(a: Set<string>, b: Set<string>) {
  return [...a].filter((token) => b.has(token)).length
}

function headlineTokens(headline: string) {
  const stop = new Set([
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
  return new Set(
    headline
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2 && !stop.has(token)),
  )
}

function jaccard(a: Set<string>, b: Set<string>) {
  const intersection = [...a].filter((token) => b.has(token)).length
  const union = new Set([...a, ...b]).size
  return union ? intersection / union : 0
}

function isValidCluster(articles: NormalizedArticle[] | ArticleRow[]) {
  const newsArticles = articles.filter(isNewsLikeArticle)
  return newsArticles.length >= 1
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

export async function deleteInvalidTopics() {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase.from('topics').select('id')
  if (error) throw createMosaicError('SUPABASE_TOPICS_SELECT_FAILED', 'Could not read topics for validation.', error)

  for (const topic of data ?? []) {
    const articles = await getArticlesForTopic(topic.id)
    if (!isValidCluster(articles)) {
      const { error: deleteError } = await supabase.from('topics').delete().eq('id', topic.id)
      if (deleteError) throw createMosaicError('SUPABASE_TOPIC_DELETE_FAILED', 'Could not delete an invalid topic cluster.', deleteError)
    }
  }
}

export async function getTopicsNeedingHomepageCards() {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('topics')
    .select('id, title_hint, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(8)

  if (error) throw createMosaicError('SUPABASE_TOPICS_SELECT_FAILED', 'Could not read topics from Supabase.', error)
  return (data ?? []) as TopicRow[]
}

export async function getHomeStories(limit = 6, offset = 0): Promise<HomeStory[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('homepage_story_cache')
    .select('topic_id, neutral_headline, snippet, source_count, sources_preview, updated_at')
    .order('updated_at', { ascending: false })
    .order('source_count', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) throw createMosaicError('SUPABASE_HOME_STORIES_SELECT_FAILED', 'Could not read homepage stories from Supabase.', error)
  return (data ?? []) as HomeStory[]
}

export async function deleteOldStories(days = 5) {
  const supabase = getSupabaseAdmin()
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  await supabase.from('homepage_story_cache').delete().lt('updated_at', cutoff)
  await supabase.from('topics').delete().lt('updated_at', cutoff)
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
  const { error } = await supabase.from('homepage_story_cache').upsert(stories, { onConflict: 'topic_id' })
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

  const articles = await getArticlesForTopic(topicId)
  const published = articles
    .map((article) => article.published_at)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null

  return {
    topic_id: topicId,
    neutral_headline: homepageStory.neutral_headline,
    snippet: homepageStory.snippet,
    published_at: published,
    source_count: articles.length,
    sources: articles.map<TopicSource>((article) => ({
      name: article.source,
      url: article.url,
      headline: article.headline,
      framing: article.headline,
    })),
  }
}

export async function getCachedExtractions(topicId: string): Promise<ArticleExtraction[] | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase.from('article_extractions').select('extractions').eq('topic_id', topicId).maybeSingle()
  if (error) throw createMosaicError('SUPABASE_SOURCE_CLAIMS_SELECT_FAILED', 'Could not read cached source claim extraction.', error)
  return (data?.extractions as ArticleExtraction[] | undefined) ?? null
}

export async function upsertExtractions(topicId: string, extractions: ArticleExtraction[]) {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase.from('article_extractions').upsert(
    {
      topic_id: topicId,
      extractions,
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
  return (data?.analysis as ComparisonAnalysis | undefined) ?? null
}

export async function upsertComparison(topicId: string, comparison: ComparisonAnalysis) {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase.from('comparison_cache').upsert(
    {
      topic_id: topicId,
      analysis: comparison,
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
  return (data?.analysis as NarrativeAnalysis | undefined) ?? null
}

export async function upsertNarrative(topicId: string, narrative: NarrativeAnalysis) {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase.from('narrative_cache').upsert(
    {
      topic_id: topicId,
      analysis: narrative,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'topic_id' },
  )
  if (error) throw createMosaicError('SUPABASE_NARRATIVE_UPSERT_FAILED', 'Could not cache narrative analysis.', error)
}
