import { after, NextResponse } from 'next/server'
import { toMosaicError } from '@/lib/mosaic/env'
import { getCachedHomepage, refreshSegment } from '@/lib/mosaic/pipeline'
import { getLastIngestionAt } from '@/lib/mosaic/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STALE_MS = 15 * 60 * 1000

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const segmentParam = searchParams.get('segment') || 'all'
    const segment = (segmentParam === 'initial' ? 'initial' : segmentParam === 'rest' ? 'rest' : 'all') as 'initial' | 'rest' | 'all'

    let stories = await getCachedHomepage().catch(() => [] as Awaited<ReturnType<typeof getCachedHomepage>>)
    const lastFetch = await getLastIngestionAt()
    const isStale = !lastFetch || Date.now() - lastFetch.getTime() > STALE_MS || stories.length < 5

    if (stories.length < 5 || isStale) {
      if (segment === 'initial' || stories.length === 0) {
        await refreshSegment('initial').catch((err) => {
          console.error('[Pipeline Error] Initial segment refresh failed:', err)
        })
        stories = await getCachedHomepage().catch(() => [])
      }

      after(async () => {
        await refreshSegment(segment === 'initial' ? 'rest' : segment).catch((err) => {
          console.error('[Pipeline Error] Background refresh failed:', err)
        })
      })
    }

    const status = stories.length === 0 ? 'processing' : isStale ? 'refreshing' : 'ready'

    return NextResponse.json({ stories, status })
  } catch (error) {
    console.error('[API Error] /api/home failed:', error)
    return NextResponse.json({ error: toMosaicError(error, 'HOME_FEED_FAILED') }, { status: 500 })
  }
}
