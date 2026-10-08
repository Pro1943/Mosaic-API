import { NextResponse } from 'next/server'
import { toMosaicError } from '@/lib/mosaic/env'
import { getTopicMeta } from '@/lib/mosaic/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const { topicId } = await params
    const topic = await getTopicMeta(topicId)
    return NextResponse.json({ topic })
  } catch (error) {
    console.error(`[API Error] /api/topics/${(await params).topicId} failed:`, error)
    return NextResponse.json({ error: toMosaicError(error, 'TOPIC_META_FAILED') }, { status: 500 })
  }
}
