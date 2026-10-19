import { NextResponse } from 'next/server'
import { toMosaicError } from '@/lib/mosaic/env'
import { getTopicMeta } from '@/lib/mosaic/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ topicId: string }> }) {
  let resolvedTopicId = 'unknown'
  try {
    const { topicId } = await params
    resolvedTopicId = topicId
    const topic = await getTopicMeta(topicId)
    const res = NextResponse.json({ topic })
    res.headers.set('Cache-Control', 's-maxage=60, stale-while-revalidate=300, stale-if-error=600')
    return res
  } catch (error) {
    console.error(`[API Error] /api/topics/${resolvedTopicId} failed:`, error)
    return NextResponse.json({ error: toMosaicError(error, 'TOPIC_META_FAILED') }, { status: 500 })
  }
}
