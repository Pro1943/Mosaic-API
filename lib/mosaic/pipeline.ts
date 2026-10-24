import {
  acquireIngestionLease,
  deleteInvalidTopics,
  deleteOldStories,
  getArticlesForTopic,
  getCachedComparison,
  getCachedExtractions,
  getCachedNarrative,
  getHomeStories,
  getPreferredHomeStories,
  getTopicsNeedingHomepageCards,
  getUncachedTopics,
  isRetainedArticle,
  needsIngestion,
  recordIngestionRun,
  releaseIngestionLease,
  upsertArticlesAndTopics,
  upsertComparison,
  upsertExtractions,
  upsertNarrative,
  upsertHomepageCards,
} from './db'
import { createMosaicError } from './env'
import { extractArticleClaims, generateHomepageCardForTopic, synthesizeComparison, writeNarrative } from './ai'
import { fetchAllNews, fetchGNews, fetchNewsData, fetchCurrents } from './news'
import type { ComparisonAnalysis, HomeStory, NarrativeAnalysis, NormalizedArticle } from './types'

type TopicArticleRow = Awaited<ReturnType<typeof getArticlesForTopic>>[number]

const comparisonFlights = new Map<string, Promise<ComparisonAnalysis>>()
const narrativeFlights = new Map<string, Promise<NarrativeAnalysis>>()

// ── Logging ────────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
}

function log(tag: string, msg: string, extra?: unknown) {
  const line = `[Pipeline][${ts()}] [${tag}] ${msg}`
  if (extra !== undefined) {
    console.log(line, typeof extra === 'object' ? JSON.stringify(extra) : extra)
  } else {
    console.log(line)
  }
}

function logErr(tag: string, msg: string, err?: unknown) {
  console.error(`[Pipeline][${ts()}] [${tag}] ERROR: ${msg}`, err ?? '')
}

// ── Core ingest ────────────────────────────────────────────────────────────────

export async function ingest() {
  log('ingest', 'Starting full news fetch from all providers')
  try {
    const result = await fetchAllNews()
    log('ingest', `Fetch complete — ${result.articles.length} deduplicated articles`, {
      succeeded: result.succeeded,
      failed: result.failed.map((f) => f.provider),
    })
    const topicIds = await upsertArticlesAndTopics(result.articles)
    await deleteInvalidTopics(topicIds)
    log('ingest', 'Articles and topics upserted to Supabase')
    await recordIngestionRun('success', {
      succeeded: result.succeeded,
      failed: result.failed,
      article_count: result.articles.length,
    })
    log('ingest', 'Ingestion run recorded as success')
    return result
  } catch (error) {
    logErr('ingest', 'Ingestion failed', error)
    await recordIngestionRun('failed', error instanceof Error ? { message: error.message } : error).catch(() => undefined)
    throw error
  }
}

// ── Cached homepage ────────────────────────────────────────────────────────────

export async function getCachedHomepage(limit = 3, offset = 0): Promise<HomeStory[]> {
  const stories = await getPreferredHomeStories(limit, offset)

  if (!stories.length && offset === 0) {
    throw createMosaicError('NO_HOME_STORIES', 'No homepage stories are cached yet.')
  }

  return stories
}

// ── Generate more cards on demand ─────────────────────────────────────────────

export async function generateMoreHomepageCards(count = 3): Promise<HomeStory[]> {
  log('generateMore', `Requesting ${count} additional uncached topic cards`)
  const topics = await getUncachedTopics(count * 2)
  if (!topics.length) {
    log('generateMore', 'No uncached topics found — nothing to generate')
    return []
  }
  log('generateMore', `Found ${topics.length} candidate uncached topics, checking articles`)

  const topicArticles = await Promise.all(
    topics.map(async (topic) => ({
      topic,
      articles: (await getArticlesForTopic(topic.id)).filter(isRetainedArticle),
    })),
  )

  // Only select topics with >= 2 distinct sources (Mosaic comparison requires multi-source)
  const multiSource = topicArticles.filter((t) => {
    const uniqueSources = new Set(t.articles.map((a) => a.source.toLowerCase().trim()))
    return t.articles.length >= 2 && uniqueSources.size >= 2
  }).sort((a, b) => topicQuality(b.articles) - topicQuality(a.articles))
  const selected = multiSource.slice(0, count)

  log('generateMore', `Selected ${selected.length} multi-source topics for cards`)

  const generated = await mapWithConcurrency(selected, 4, async ({ topic, articles }) => {
    if (articles.length === 0) return null
    log('generateMore', `Generating card for topic "${topic.title_hint}" (${articles.length} articles)`)
    const t0 = Date.now()
    try {
      const card = await generateHomepageCardForTopic({
        topic_id: topic.id,
        articles: articles.map(articleRowToNormalized),
      })
      log('generateMore', `Card done for "${topic.title_hint}" in ${Date.now() - t0}ms`)
      return card
    } catch (err) {
      logErr('generateMore', `Card failed for "${topic.title_hint}"`, err)
      return null
    }
  })

  const stories = generated.filter(Boolean) as HomeStory[]
  if (stories.length > 0) {
    await upsertHomepageCards(stories)
    log('generateMore', `Cached ${stories.length} new cards`)
  }
  return stories
}

// ── Segment refresh ────────────────────────────────────────────────────────────

export async function refreshSegment(segment: 'initial' | 'rest' | 'all' = 'initial') {
  log('refreshSegment', `Starting segment="${segment}"`)

  const acquired = await acquireIngestionLease()
  if (!acquired) {
    log('refreshSegment', 'Could not acquire lease — another refresh is running')
    const existing = await getHomeStories(3, 0).catch(() => [])
    log('refreshSegment', `Lease busy — returning ${existing.length} existing stories`)
    return { story_count: existing.length }
  }

  try {
    const stale = await needsIngestion()
    log('refreshSegment', `needsIngestion=${stale}`)

    if (stale) {
      log('refreshSegment', 'Data is stale or cache is empty — running cleanup and fetch')
      await deleteOldStories(3)

      if (segment === 'initial') {
        // ── Chunk 1: GNews + NewsData in parallel (~20 articles, fast) ─────
        log('initial', 'Fetching Chunk 1 (GNews + NewsData in parallel)')
        const t0 = Date.now()
        const [p1, p2] = await Promise.all([
          fetchGNews().catch((err) => { logErr('initial', 'GNews fetch failed', err); return null }),
          fetchNewsData().catch((err) => { logErr('initial', 'NewsData fetch failed', err); return null }),
        ])
        const chunk1Articles = [...(p1?.articles ?? []), ...(p2?.articles ?? [])]
        log('initial', `Chunk 1 returned ${chunk1Articles.length} articles in ${Date.now() - t0}ms`)

        if (chunk1Articles.length > 0) {
          const topicIds = await upsertArticlesAndTopics(chunk1Articles)
          log('initial', 'Articles upserted to Supabase')
          await deleteInvalidTopics(topicIds)
          log('initial', 'Invalid topics pruned')

          // Generate first 3 cards in parallel
          log('initial', 'Generating first 3 homepage cards (concurrency 4)')
          await regenerateHomepageCards(3)
          log('initial', 'Initial card generation complete')

          await recordIngestionRun('success', {
            segment: 'initial',
            providers: ['gnews', 'newsdata'],
            article_count: chunk1Articles.length,
          }).catch(() => undefined)
          log('initial', 'Ingestion run recorded')
        } else {
          log('initial', 'Both GNews and NewsData returned 0 articles')
        }

      } else if (segment === 'rest') {
        // ── Chunk 2: Currents News (fetched on-demand when user clicks fetch more) ─
        log('rest', 'Fetching Chunk 2 (Currents News)')
        const t0 = Date.now()
        const p3 = await fetchCurrents().catch((err) => { logErr('rest', 'Currents fetch failed', err); return null })
        const chunk2Articles = p3?.articles ?? []
        log('rest', `Chunk 2 returned ${chunk2Articles.length} articles in ${Date.now() - t0}ms`)

        if (chunk2Articles.length > 0) {
          const topicIds = await upsertArticlesAndTopics(chunk2Articles)
          await deleteInvalidTopics(topicIds)
          log('rest', 'Generating next homepage cards')
          await generateMoreHomepageCards(3)
          await recordIngestionRun('success', {
            segment: 'rest',
            providers: ['currents'],
            article_count: chunk2Articles.length,
          }).catch(() => undefined)
          log('rest', 'Ingestion run recorded')
        } else {
          log('rest', 'Currents returned 0 articles')
        }

      } else {
        // ── Full / Initial Chunk: GNews + NewsData first so cards are ready fast ─
        log('all', 'Running Chunk 1 (GNews + NewsData in parallel)')
        const [p1, p2] = await Promise.all([
          fetchGNews().catch(() => null),
          fetchNewsData().catch(() => null),
        ])
        const chunk1Articles = [...(p1?.articles ?? []), ...(p2?.articles ?? [])]
        if (chunk1Articles.length > 0) {
          const topicIds = await upsertArticlesAndTopics(chunk1Articles)
          await deleteInvalidTopics(topicIds)
          await regenerateHomepageCards(3)
          await recordIngestionRun('success', {
            segment: 'initial',
            providers: ['gnews', 'newsdata'],
            article_count: chunk1Articles.length,
          }).catch(() => undefined)
        }
      }
    } else {
      // Data is fresh, but verify cache has at least 3 stories:
      const existing = await getHomeStories(3, 0)
      if (existing.length < 3) {
        log('refreshSegment', `Cache has only ${existing.length} stories — generating cards from existing topics in DB`)
        await regenerateHomepageCards(3)
      } else {
        log('refreshSegment', `Data is still fresh and cache has ${existing.length} stories — no action needed`)
      }
    }

    const stories = await getPreferredHomeStories(10, 0)
    log('refreshSegment', `Segment="${segment}" complete — ${stories.length} stories in cache`)
    return { story_count: stories.length }
  } catch (err) {
    logErr('refreshSegment', `Segment="${segment}" threw`, err)
    throw err
  } finally {
    await releaseIngestionLease().catch(() => undefined)
    log('refreshSegment', `Lease released for segment="${segment}"`)
  }
}

export async function refreshHomepageCategory() {
  return refreshSegment('initial')
}

// ── Homepage card generation ───────────────────────────────────────────────────

/**
 * Regenerate homepage cards.
 * @param limit  Max number of cards to generate. Defaults to 3.
 */
export async function regenerateHomepageCards(limit = 3) {
  log('regen', `Loading topics to generate cards for (limit ${limit})`)
  const candidateTopics = await getTopicsNeedingHomepageCards(limit * 3)
  log('regen', `${candidateTopics.length} candidate topics to check`)

  if (!candidateTopics.length) {
    log('regen', 'No topics found in DB — nothing to generate')
    return []
  }

  // Load articles for all candidate topics in parallel
  const topicArticles = await Promise.all(
    candidateTopics.map(async (topic) => ({
      topic,
      articles: (await getArticlesForTopic(topic.id)).filter(isRetainedArticle),
    })),
  )

  // Only select topics with >= 2 distinct sources (Mosaic comparison requires multi-source)
  const multiSource = topicArticles.filter((t) => {
    const uniqueSources = new Set(t.articles.map((a) => a.source.toLowerCase().trim()))
    return t.articles.length >= 2 && uniqueSources.size >= 2
  }).sort((a, b) => topicQuality(b.articles) - topicQuality(a.articles))
  const selected = multiSource.slice(0, limit)

  log('regen', `Selected ${selected.length} multi-source topics for cards`)

  const generated = await mapWithConcurrency(selected, 4, async ({ topic, articles }) => {
    if (articles.length === 0) return null
    log('regen', `→ Generating card for "${topic.title_hint}" (${articles.length} article(s))`)
    const t0 = Date.now()
    try {
      const card = await generateHomepageCardForTopic({
        topic_id: topic.id,
        articles: articles.map(articleRowToNormalized),
      })
      log('regen', `✓ Card done for "${topic.title_hint}" in ${Date.now() - t0}ms`)
      return card
    } catch (err) {
      logErr('regen', `✗ Card failed for "${topic.title_hint}"`, err)
      return null
    }
  })

  const stories = generated.filter(Boolean) as HomeStory[]
  log('regen', `Generated ${stories.length}/${selected.length} cards — upserting to cache`)
  if (stories.length > 0) {
    await upsertHomepageCards(stories)
    log('regen', 'Cache upsert complete')
  }
  return stories
}

// ── Article page helpers ───────────────────────────────────────────────────────

export async function getOrCreateComparison(topicId: string): Promise<ComparisonAnalysis> {
  const active = comparisonFlights.get(topicId)
  if (active) return active

  const work = createComparison(topicId).finally(() => comparisonFlights.delete(topicId))
  comparisonFlights.set(topicId, work)
  return work
}

async function createComparison(topicId: string): Promise<ComparisonAnalysis> {
  const cached = await getCachedComparison(topicId)
  if (cached && cached.claims.length > 0) return cached

  const extractions = await getOrCreateSourceClaims(topicId)
  const comparison = await synthesizeComparison(extractions)
  if (!comparison.claims.length) {
    throw createMosaicError('COMPARISON_EMPTY_CLAIMS', 'The comparison analysis produced no claims for this topic.', { topicId })
  }
  await upsertComparison(topicId, comparison)
  return comparison
}

export async function getOrCreateNarrative(topicId: string): Promise<NarrativeAnalysis> {
  const active = narrativeFlights.get(topicId)
  if (active) return active

  const work = createNarrative(topicId).finally(() => narrativeFlights.delete(topicId))
  narrativeFlights.set(topicId, work)
  return work
}

async function createNarrative(topicId: string): Promise<NarrativeAnalysis> {
  const comparison = await getOrCreateComparison(topicId)
  const cached = await getCachedNarrative(topicId)
  if (cached && cached.sections.length > 0 && cached.differs_on.trim().toLowerCase() !== 'none') return cached

  const narrative = await writeNarrative(comparison)
  if (!narrative.sections.length || narrative.differs_on.trim().toLowerCase() === 'none') {
    throw createMosaicError('NARRATIVE_EMPTY_DIFFERENCES', 'The narrative analysis produced no usable differences for this topic.', { topicId })
  }
  await upsertNarrative(topicId, narrative)
  return narrative
}

async function getOrCreateSourceClaims(topicId: string) {
  const cached = await getCachedExtractions(topicId)
  if (cached && cached.some((extraction) => extraction.claims.length > 0)) return cached

  const articles = await getArticlesForTopic(topicId)
  if (articles.length < 2) {
    throw createMosaicError('INSUFFICIENT_TOPIC_SOURCES', 'A comparison requires at least two source articles for this topic.', {
      topicId,
      articleCount: articles.length,
    })
  }

  const extractions = await extractArticleClaims(articles.map(articleRowToNormalized))
  if (!extractions.some((extraction) => extraction.claims.length > 0)) {
    throw createMosaicError('SOURCE_CLAIMS_EMPTY', 'No source claims were extracted for this topic.', {
      topicId,
      articleCount: articles.length,
      sources: articles.map((article) => article.source),
      headlines: articles.map((article) => article.headline),
    })
  }
  await upsertExtractions(topicId, extractions)
  return extractions
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function articleRowToNormalized(article: TopicArticleRow): NormalizedArticle {
  return {
    provider: article.provider ?? 'unknown',
    source: article.source,
    headline: article.headline,
    author: article.author,
    published_at: article.published_at,
    body: article.body,
    url: article.url,
  }
}

function topicQuality(articles: TopicArticleRow[]) {
  const sources = new Set(articles.map((article) => article.source.toLowerCase().trim())).size
  const providers = new Set(articles.map((article) => article.provider).filter((provider) => provider && provider !== 'unknown')).size
  return providers * 100 + sources * 10 + articles.length
}

async function mapWithConcurrency<Input, Output>(items: Input[], limit: number, worker: (item: Input) => Promise<Output>) {
  const results: Output[] = []
  let index = 0

  async function run() {
    while (index < items.length) {
      const currentIndex = index
      index += 1
      results[currentIndex] = await worker(items[currentIndex])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}
