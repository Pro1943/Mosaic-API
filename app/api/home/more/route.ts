import { after, NextResponse } from 'next/server'
import { toMosaicError } from '@/lib/mosaic/env'
import { generateMoreHomepageCards, getCachedHomepage, refreshSegment } from '@/lib/mosaic/pipeline'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CHUNK_SIZE = 3

function ts() { return new Date().toISOString().slice(11, 23) }

export async function GET(request: Request) {
  const t0 = Date.now()
  try {
    const url = new URL(request.url)
    const offsetParam = url.searchParams.get('offset')
    const offset = Math.max(0, parseInt(offsetParam ?? '0', 10) || 0)

    console.log(`[HomeMore][${ts()}] GET /api/home/more?offset=${offset}`)

    const stories = await getCachedHomepage(CHUNK_SIZE, offset).catch(() => [])
    console.log(`[HomeMore][${ts()}] Cache read at offset=${offset}: ${stories.length} stories`)

    if (stories.length === 0) {
      console.log(`[HomeMore][${ts()}] No cached stories at offset=${offset} — scheduling background generation`)
      after(async () => {
        console.log(`[HomeMore][${ts()}] Background: generating ${CHUNK_SIZE} more homepage cards`)
        const generated = await generateMoreHomepageCards(CHUNK_SIZE).catch((err) => {
          console.error(`[HomeMore][${ts()}] Generating more homepage cards failed:`, err)
          return []
        })
        if (generated.length === 0) {
          console.log(`[HomeMore][${ts()}] No uncached topics left — fetching Chunk 2 (Currents News)`)
          await refreshSegment('rest').catch((err) => {
            console.error(`[HomeMore][${ts()}] Rest segment refresh failed:`, err)
          })
        }
      })
      return NextResponse.json({ stories: [], status: 'processing' })
    }

    console.log(`[HomeMore][${ts()}] Responding with ${stories.length} stories (took ${Date.now() - t0}ms)`)
    const res = NextResponse.json({ stories, status: 'ready' })
    res.headers.set('Cache-Control', 's-maxage=30, stale-while-revalidate=60, stale-if-error=300')
    return res
  } catch (error) {
    console.error(`[HomeMore][${ts()}] GET /api/home/more threw:`, error)
    return NextResponse.json({ error: toMosaicError(error, 'HOME_MORE_FAILED') }, { status: 500 })
  }
}
