import { NextResponse } from 'next/server'
import { toMosaicError } from '@/lib/mosaic/env'
import { getOrCreateComparison } from '@/lib/mosaic/pipeline'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const { topicId } = await params
    const comparison = await getOrCreateComparison(topicId)
    return NextResponse.json({ comparison })
  } catch (error) {
    console.error(`[API Error] /api/topics/${(await params).topicId}/comparison failed:`, error)
    return NextResponse.json({ error: toMosaicError(error, 'COMPARISON_FAILED') }, { status: 500 })
  }
}
