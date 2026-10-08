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

export async function ingest() {
  try {
    const result = await fetchAllNews()
    await upsertArticlesAndTopics(result.articles)
    await recordIngestionRun('success', {
      succeeded: result.succeeded,
      failed: result.failed,
      article_count: result.articles.length,
    })
    return result
  } catch (error) {
    await recordIngestionRun('failed', error instanceof Error ? { message: error.message } : error).catch(() => undefined)
    throw error
  }
}

export async function getCachedHomepage(limit = 6, offset = 0): Promise<HomeStory[]> {
  const stories = await getHomeStories(limit, offset)

  if (!stories.length && offset === 0) {
    throw createMosaicError('NO_HOME_STORIES', 'No homepage stories are cached yet.')
  }

  return stories
}

export async function generateMoreHomepageCards(count = 3): Promise<HomeStory[]> {
  const topics = await getUncachedTopics(count)
  if (!topics.length) return []

  const generated = await mapWithConcurrency(topics, 2, async (topic) => {
    const articles = await getArticlesForTopic(topic.id)
    if (articles.length < 2) return null

    return generateHomepageCardForTopic({
      topic_id: topic.id,
      articles: articles.map(articleRowToNormalized),
    })
  })

  const stories = generated.filter(Boolean) as HomeStory[]
  if (stories.length > 0) {
    await upsertHomepageCards(stories)
  }
  return stories
}

export async function refreshSegment(segment: 'initial' | 'rest' | 'all' = 'all') {
  const acquired = await acquireIngestionLease()
  if (!acquired) {
    const stale = await needsIngestion()
    if (!stale) {
      const existing = await getHomeStories()
      return { story_count: existing.length }
    }
    await releaseIngestionLease().catch(() => undefined)
  }

  try {
    const stale = await needsIngestion()

    if (stale) {
      await deleteOldStories(5)
      if (segment === 'initial') {
        const p1 = await fetchGNews().catch(() => null)
        if (p1 && p1.articles.length) {
          await upsertArticlesAndTopics(p1.articles)
          await deleteInvalidTopics()
          await regenerateHomepageCards()
          await recordIngestionRun('success', {
            segment: 'initial',
            provider: 'gnews',
            article_count: p1.articles.length,
          }).catch(() => undefined)
        }
      } else if (segment === 'rest') {
        const [res2, res3] = await Promise.all([
          fetchNewsData().catch(() => null),
          fetchCurrents().catch(() => null),
        ])

        let newArticlesCount = 0
        if (res2 && res2.articles.length) {
          await upsertArticlesAndTopics(res2.articles)
          newArticlesCount += res2.articles.length
        }

        if (res3 && res3.articles.length) {
          await upsertArticlesAndTopics(res3.articles)
          newArticlesCount += res3.articles.length
        }

        if (newArticlesCount > 0) {
          await deleteInvalidTopics()
          await regenerateHomepageCards()
          await recordIngestionRun('success', {
            segment: 'rest',
            providers: ['newsdata', 'currents'],
            article_count: newArticlesCount,
          }).catch(() => undefined)
        }
      } else {
        // Safe refresh: do NOT clear existing cache before new data is generated
        await ingest()
        await deleteInvalidTopics()
        await regenerateHomepageCards()
      }
    }

    const stories = await getHomeStories()
    return { story_count: stories.length }
  } finally {
    await releaseIngestionLease().catch(() => undefined)
  }
}

export async function refreshHomepageCategory() {
  return refreshSegment('all')
}

export async function regenerateHomepageCards() {
  const topics = await getTopicsNeedingHomepageCards()
  const generated = await mapWithConcurrency(topics, 2, async (topic) => {
    const articles = await getArticlesForTopic(topic.id)
    if (articles.length < 2) return null

    return generateHomepageCardForTopic({
      topic_id: topic.id,
      articles: articles.map(articleRowToNormalized),
    })
  })

  const stories = generated.filter(Boolean) as HomeStory[]
  await upsertHomepageCards(stories)
  return stories
}

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
