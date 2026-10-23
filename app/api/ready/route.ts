import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/mosaic/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

let lastDatabaseCheck = 0
const CHECK_INTERVAL_MS = 30_000

export async function GET() {
  try {
    if (Date.now() - lastDatabaseCheck >= CHECK_INTERVAL_MS) {
      const { error } = await getSupabaseAdmin().from('ingestion_runs').select('id').limit(1)
      if (error) throw error
      lastDatabaseCheck = Date.now()
    }
    return NextResponse.json({ status: 'ready' }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
