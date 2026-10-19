import { createMosaicError, getEnv } from './env'
import type { NormalizedArticle } from './types'

// ── Logging ──────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().slice(11, 23) }
function log(msg: string, extra?: unknown) {
  const line = `[News][${ts()}] ${msg}`
  if (extra !== undefined) console.log(line, typeof extra === 'object' ? JSON.stringify(extra) : extra)
  else console.log(line)
}
function logErr(msg: string, err?: unknown) {
  console.error(`[News][${ts()}] ERROR: ${msg}`, err ?? '')
}

type ProviderResult = {
  provider: string
  articles: NormalizedArticle[]
  error?: string
}

const USER_AGENT = 'MosaicNewsComparison/0.1'
const GENERAL_QUERY = 'world'

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeBody(...values: unknown[]) {
  return values.map(asText).find(Boolean) ?? ''
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`HTTP_${response.status}`)
  }

  return response.json()
}

export async function fetchGNews(): Promise<ProviderResult> {
  const key = getEnv('GNEWS_API_KEY')
  const url = `https://gnews.io/api/v4/top-headlines?category=general&lang=en&max=10&apikey=${key}`
  log('GNews → fetching')
  const t0 = Date.now()

  const data = await fetchJson(url)
  const articles = Array.isArray((data as { articles?: unknown }).articles) ? (data as { articles: Record<string, unknown>[] }).articles : []
  const normalized = articles
    .map((item) => ({
      source: asText((item.source as { name?: unknown } | undefined)?.name) || 'GNews',
      headline: asText(item.title),
      author: null,
      published_at: asText(item.publishedAt) || null,
      body: normalizeBody(item.content, item.description),
      url: asText(item.url),
    }))
    .filter((article) => article.headline && article.url && article.body)

  log(`GNews → ${normalized.length} articles in ${Date.now() - t0}ms`)
  return { provider: 'gnews', articles: normalized }
}

export async function fetchNewsData(): Promise<ProviderResult> {
  const key = getEnv('NEWSDATA_API_KEY')
  const url = `https://newsdata.io/api/1/news?apikey=${key}&language=en&q=${encodeURIComponent(GENERAL_QUERY)}`
  log('NewsData → fetching')
  const t0 = Date.now()

  const data = await fetchJson(url)
  const results = Array.isArray((data as { results?: unknown }).results) ? (data as { results: Record<string, unknown>[] }).results : []
  const normalized = results
    .map((item) => ({
      source: asText(item.source_id) || asText(item.source_name) || 'NewsData.io',
      headline: asText(item.title),
      author: asText(Array.isArray(item.creator) ? item.creator.join(', ') : item.creator) || null,
      published_at: asText(item.pubDate) || null,
      body: normalizeBody(item.content, item.description),
      url: asText(item.link),
    }))
    .filter((article) => article.headline && article.url && article.body)

  log(`NewsData → ${normalized.length} articles in ${Date.now() - t0}ms`)
  return { provider: 'newsdata', articles: normalized }
}

export async function fetchCurrents(): Promise<ProviderResult> {
  const key = getEnv('CURRENTS_API_KEY')
  const url = `https://api.currentsapi.services/v1/search?apiKey=${key}&language=en&keywords=${encodeURIComponent(GENERAL_QUERY)}`
  log('Currents → fetching')
  const t0 = Date.now()

  const data = await fetchJson(url)
  const results = Array.isArray((data as { news?: unknown }).news) ? (data as { news: Record<string, unknown>[] }).news : []
  const normalized = results
    .map((item) => ({
      source: asText(item.author) || asText(item.source) || 'Currents News',
      headline: asText(item.title),
      author: asText(item.author) || null,
      published_at: asText(item.published) || null,
      body: normalizeBody(item.description),
      url: asText(item.url),
    }))
    .filter((article) => article.headline && article.url && article.body)

  log(`Currents → ${normalized.length} articles in ${Date.now() - t0}ms`)
  return { provider: 'currents', articles: normalized }
}

export async function fetchAllNews() {
  log('fetchAllNews → launching all 3 providers in parallel')
  const t0 = Date.now()
  const providers = await Promise.allSettled([fetchGNews(), fetchNewsData(), fetchCurrents()])
  const results = providers.map((result, index): ProviderResult => {
    const provider = ['gnews', 'newsdata', 'currents'][index]
    if (result.status === 'fulfilled') return result.value
    const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason)
    logErr(`Provider "${provider}" failed: ${errMsg}`)
    return { provider, articles: [], error: errMsg }
  })

  const rawArticles = results.flatMap((result) => result.articles)
  const articles = dedupeArticles(rawArticles)
  const succeeded = results.filter((result) => !result.error).map((result) => result.provider)
  const failed = results.filter((result) => result.error).map((result) => ({ provider: result.provider, error: result.error }))

  log(`fetchAllNews → ${rawArticles.length} raw → ${articles.length} deduplicated in ${Date.now() - t0}ms`, { succeeded, failed: failed.map(f => f.provider) })

  if (!articles.length) {
    throw createMosaicError('NEWS_ALL_PROVIDERS_FAILED', 'No news articles were fetched from GNews.io, NewsData.io, or Currents News.', { failed })
  }

  return { articles, succeeded, failed }
}

export function dedupeArticles(articles: NormalizedArticle[]) {
  const seenByUrl = new Map<string, NormalizedArticle>()
  const seenByHeadline = new Map<string, NormalizedArticle>()

  for (const article of articles) {
    const urlKey = article.url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '').toLowerCase()
    const headlineKey = article.headline.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 90)
    const existing = seenByUrl.get(urlKey) ?? seenByHeadline.get(headlineKey)

    if (!existing || article.body.length > existing.body.length) {
      if (existing) {
        const oldUrlKey = existing.url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '').toLowerCase()
        const oldHeadlineKey = existing.headline.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 90)
        seenByUrl.delete(oldUrlKey)
        seenByHeadline.delete(oldHeadlineKey)
      }
      seenByUrl.set(urlKey, article)
      seenByHeadline.set(headlineKey, article)
    }
  }

  return Array.from(new Set(seenByUrl.values()))
}
