import { NextResponse } from 'next/server'
import { toMosaicError } from '@/lib/mosaic/env'
import { getOrCreateComparison } from '@/lib/mosaic/pipeline'
import { checkRateLimit, getClientIp } from '@/lib/mosaic/rateLimit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ topicId: string }> }) {
  let resolvedTopicId = 'unknown'
  try {
    const { topicId } = await params
    resolvedTopicId = topicId

    const ip = getClientIp(request)
    const rateLimitKey = `comparison:${ip}`
    if (!checkRateLimit(rateLimitKey, 5, 60_000)) {
      return NextResponse.json(
        { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait before retrying.' } },
        {
          status: 429,
          headers: {
            'Retry-After': '60',
            'X-RateLimit-Limit': '5',
            'X-RateLimit-Window': '60s',
          },
        },
      )
    }

    const comparison = await getOrCreateComparison(topicId)
    return NextResponse.json({ comparison })
  } catch (error) {
    console.error(`[API Error] /api/topics/${resolvedTopicId}/comparison failed:`, error)
    const mosaicError = toMosaicError(error, 'COMPARISON_FAILED')
    const status = mosaicError.code === 'INSUFFICIENT_TOPIC_SOURCES' ? 400 : 500
    return NextResponse.json({ error: mosaicError }, { status })
  }
}
