import {
  acquireIngestionLease,
  deleteInvalidTopics,
  deleteOldStories,
  getArticlesForTopic,
  getCachedComparison,
  getCachedExtractions,
  getCachedNarrative,
  getHomeStories,
  getTopicsNeedingHomepageCards,
  getUncachedTopics,
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
import { extractArticleClaims, generateHomepageCardForTopic, synthesizeComparison, writeNarrative } from './gemini'
import { fetchAllNews, fetchGNews, fetchNewsData, fetchCurrents } from './news'
import type { ComparisonAnalysis, HomeStory, NarrativeAnalysis, NormalizedArticle } from './types'

type TopicArticleRow = Awaited<ReturnType<typeof getArticlesForTopic>>[number]

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
    await upsertArticlesAndTopics(result.articles)
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
  const stories = await getHomeStories(limit, offset)

  if (!stories.length && offset === 0) {
    throw createMosaicError('NO_HOME_STORIES', 'No homepage stories are cached yet.')
  }

  return stories
}

// ── Generate more cards on demand ─────────────────────────────────────────────

export async function generateMoreHomepageCards(count = 3): Promise<HomeStory[]> {
  log('generateMore', `Requesting ${count} additional uncached topic cards`)
  const topics = await getUncachedTopics(count)
  if (!topics.length) {
    log('generateMore', 'No uncached topics found — nothing to generate')
    return []
  }
  log('generateMore', `Found ${topics.length} uncached topics, generating cards (concurrency 4)`)

  const generated = await mapWithConcurrency(topics, 4, async (topic) => {
    const articles = await getArticlesForTopic(topic.id)
    if (articles.length < 2) {
      log('generateMore', `Skipping topic ${topic.id} — only ${articles.length} article(s)`)
      return null
    }
    log('generateMore', `Generating card for topic "${topic.title_hint}" (${articles.length} articles)`)
    const t0 = Date.now()
    const card = await generateHomepageCardForTopic({
      topic_id: topic.id,
      articles: articles.map(articleRowToNormalized),
    })
    log('generateMore', `Card done for "${topic.title_hint}" in ${Date.now() - t0}ms`)
    return card
  })

  const stories = generated.filter(Boolean) as HomeStory[]
  if (stories.length > 0) {
    await upsertHomepageCards(stories)
    log('generateMore', `Cached ${stories.length} new cards`)
  }
  return stories
}

// ── Segment refresh ────────────────────────────────────────────────────────────

export async function refreshSegment(segment: 'initial' | 'rest' | 'all' = 'all') {
  log('refreshSegment', `Starting segment="${segment}"`)

  const acquired = await acquireIngestionLease()
  if (!acquired) {
    log('refreshSegment', 'Could not acquire lease — another refresh is running')
    const stale = await needsIngestion()
    if (!stale) {
      const existing = await getHomeStories()
      log('refreshSegment', `Lease busy but data is fresh — ${existing.length} stories available`)
      return { story_count: existing.length }
    }
    log('refreshSegment', 'Lease busy and data is stale — releasing stale lock and retrying')
    await releaseIngestionLease().catch(() => undefined)
  }

  try {
    const stale = await needsIngestion()
    log('refreshSegment', `needsIngestion=${stale}`)

    if (stale) {
      log('refreshSegment', 'Data is stale — running cleanup and fetch')
      await deleteOldStories(5)
      log('refreshSegment', 'Deleted stories older than 5 days')

      if (segment === 'initial') {
        // ── Initial segment: GNews only → generate first 3 cards fast ─────
        log('initial', 'Fetching GNews articles')
        const t0 = Date.now()
        const p1 = await fetchGNews().catch((err) => {
          logErr('initial', 'GNews fetch failed', err)
          return null
        })

        if (p1 && p1.articles.length) {
          log('initial', `GNews returned ${p1.articles.length} articles in ${Date.now() - t0}ms`)
          await upsertArticlesAndTopics(p1.articles)
          log('initial', 'GNews articles upserted to Supabase')
          await deleteInvalidTopics()
          log('initial', 'Invalid topics pruned')

          // Only generate the FIRST 3 topic cards so status becomes 'ready' fast
          log('initial', 'Generating first 3 homepage cards (concurrency 3)')
          await regenerateHomepageCards(3)
          log('initial', 'Initial card generation complete')

          await recordIngestionRun('success', {
            segment: 'initial',
            provider: 'gnews',
            article_count: p1.articles.length,
          }).catch(() => undefined)
          log('initial', 'Ingestion run recorded')
        } else {
          log('initial', 'GNews returned 0 articles — no cards generated this segment')
        }

      } else if (segment === 'rest') {
        // ── Rest segment: NewsData + Currents concurrently → remaining cards ─
        log('rest', 'Fetching NewsData + Currents in parallel')
        const t0 = Date.now()
        const [res2, res3] = await Promise.all([
          fetchNewsData().catch((err) => { logErr('rest', 'NewsData fetch failed', err); return null }),
          fetchCurrents().catch((err) => { logErr('rest', 'Currents fetch failed', err); return null }),
        ])
        log('rest', `Parallel fetch done in ${Date.now() - t0}ms — NewsData:${res2?.articles.length ?? 'failed'} Currents:${res3?.articles.length ?? 'failed'}`)

        let newArticlesCount = 0
        if (res2 && res2.articles.length) {
          await upsertArticlesAndTopics(res2.articles)
          newArticlesCount += res2.articles.length
          log('rest', `Upserted ${res2.articles.length} NewsData articles`)
        }
        if (res3 && res3.articles.length) {
          await upsertArticlesAndTopics(res3.articles)
          newArticlesCount += res3.articles.length
          log('rest', `Upserted ${res3.articles.length} Currents articles`)
        }

        if (newArticlesCount > 0) {
          log('rest', `Total new articles: ${newArticlesCount} — pruning invalid topics`)
          await deleteInvalidTopics()
          // Generate ALL remaining uncached topics (higher concurrency since Render has more time)
          log('rest', 'Generating remaining homepage cards (concurrency 4, no limit)')
          await regenerateHomepageCards() // no limit — generate all
          log('rest', 'Rest card generation complete')
          await recordIngestionRun('success', {
            segment: 'rest',
            providers: ['newsdata', 'currents'],
            article_count: newArticlesCount,
          }).catch(() => undefined)
          log('rest', 'Ingestion run recorded')
        } else {
          log('rest', 'Both NewsData and Currents returned 0 articles')
        }

      } else {
        // ── Full refresh: all providers, safe (no pre-clear) ──────────────
        log('all', 'Running full ingest across all providers')
        await ingest()
        log('all', 'Full ingest complete — pruning invalid topics')
        await deleteInvalidTopics()
        log('all', 'Generating all homepage cards (concurrency 4)')
        await regenerateHomepageCards()
        log('all', 'Full card regeneration complete')
      }
    } else {
      log('refreshSegment', 'Data is still fresh — no action needed')
    }

    const stories = await getHomeStories()
    log('refreshSegment', `Segment="${segment}" done — ${stories.length} stories in cache`)
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
  return refreshSegment('all')
}

// ── Homepage card generation ───────────────────────────────────────────────────

/**
 * Regenerate homepage cards.
 * @param limit  Max number of topics to process. Pass undefined for all.
 */
export async function regenerateHomepageCards(limit?: number) {
  log('regen', `Loading topics to generate cards for${limit !== undefined ? ` (limit ${limit})` : ' (all)'}`)
  const topics = await getTopicsNeedingHomepageCards(limit)
  log('regen', `${topics.length} topics to process`)

  if (!topics.length) {
    log('regen', 'No topics found — nothing to generate')
    return []
  }

  const generated = await mapWithConcurrency(topics, 4, async (topic) => {
    const articles = await getArticlesForTopic(topic.id)
    if (articles.length < 2) {
      log('regen', `Skipping "${topic.title_hint}" — ${articles.length} article(s) (need ≥2)`)
      return null
    }
    log('regen', `→ Generating card for "${topic.title_hint}" (${articles.length} articles)`)
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
  log('regen', `Generated ${stories.length}/${topics.length} cards successfully — upserting to cache`)
  await upsertHomepageCards(stories)
  log('regen', 'Cache upsert complete')
  return stories
}

// ── Article page helpers ───────────────────────────────────────────────────────

export async function getOrCreateComparison(topicId: string): Promise<ComparisonAnalysis> {
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
    source: article.source,
    headline: article.headline,
    author: article.author,
    published_at: article.published_at,
    body: article.body,
    url: article.url,
  }
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
