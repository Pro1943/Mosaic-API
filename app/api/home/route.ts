import { after, NextResponse } from 'next/server'
import { toMosaicError } from '@/lib/mosaic/env'
import { getCachedHomepage, refreshSegment } from '@/lib/mosaic/pipeline'
import { getLastIngestionAt } from '@/lib/mosaic/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Stories are stale if the last ingestion success was more than 15 minutes ago
const STALE_MS = 15 * 60 * 1000
// Number of stories to return in the initial/rest response (user sees these first)
const INITIAL_CHUNK = 3

function ts() { return new Date().toISOString().slice(11, 23) }

export async function GET(request: Request) {
  const t0 = Date.now()
  const { searchParams } = new URL(request.url)
  const segmentParam = searchParams.get('segment') || 'all'
  const segment = (segmentParam === 'initial' ? 'initial' : segmentParam === 'rest' ? 'rest' : 'all') as 'initial' | 'rest' | 'all'

  console.log(`[Home][${ts()}] GET /api/home?segment=${segment}`)

  try {
    // Fetch only the initial chunk — do NOT dump all stories at once
    let stories = await getCachedHomepage(INITIAL_CHUNK, 0).catch(() => [] as Awaited<ReturnType<typeof getCachedHomepage>>)
    console.log(`[Home][${ts()}] Cache read: ${stories.length} stories (chunk size ${INITIAL_CHUNK})`)

    const lastFetch = await getLastIngestionAt()
    const isStale = !lastFetch || Date.now() - lastFetch.getTime() > STALE_MS || stories.length < INITIAL_CHUNK
    console.log(`[Home][${ts()}] isStale=${isStale} lastFetch=${lastFetch?.toISOString() ?? 'never'} storyCount=${stories.length}`)

    if (stories.length < INITIAL_CHUNK || isStale) {
      if (segment === 'initial' || stories.length === 0) {
        console.log(`[Home][${ts()}] Insufficient/stale stories — running initial refresh synchronously`)
        await refreshSegment('initial').catch((err) => {
          console.error(`[Home][${ts()}] Initial segment refresh failed:`, err)
        })
        stories = await getCachedHomepage(INITIAL_CHUNK, 0).catch(() => [])
        console.log(`[Home][${ts()}] After initial refresh: ${stories.length} stories`)
      }

      after(async () => {
        const bgSeg = segment === 'initial' ? 'rest' : segment
        console.log(`[Home][${ts()}] Scheduling background refresh segment="${bgSeg}"`)
        await refreshSegment(bgSeg).catch((err) => {
          console.error(`[Home][${ts()}] Background refresh segment="${bgSeg}" failed:`, err)
        })
      })
    }

    const status = stories.length === 0 ? 'processing' : isStale ? 'refreshing' : 'ready'
    console.log(`[Home][${ts()}] Responding: status=${status} stories=${stories.length} (took ${Date.now() - t0}ms)`)

    return NextResponse.json({ stories, status })
  } catch (error) {
    console.error(`[Home][${ts()}] GET /api/home threw:`, error)
    return NextResponse.json({ error: toMosaicError(error, 'HOME_FEED_FAILED') }, { status: 500 })
  }
}
