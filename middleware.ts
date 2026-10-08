import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true // Allow same-origin or non-browser server-to-server requests

  // Allow localhost for local development
  if (/^http:\/\/localhost(:\d+)?$/.test(origin) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
    return true
  }

  // Allow Vercel preview/production deployments
  if (/^https:\/\/[a-zA-Z0-9_-]+\.vercel\.app$/.test(origin) || /^https:\/\/mosaic[a-zA-Z0-9_-]*\.vercel\.app$/.test(origin)) {
    return true
  }

  // Allow origins configured via environment variable
  const configured = process.env.ALLOWED_ORIGINS
  if (configured) {
    const allowed = configured.split(',').map((o) => o.trim().toLowerCase())
    if (allowed.includes(origin.toLowerCase()) || allowed.includes('*')) {
      return true
    }
  }

  return false
}

function setCorsHeaders(response: NextResponse, origin: string | null) {
  if (origin && isAllowedOrigin(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin)
  } else if (!origin) {
    // No origin (e.g. curl / server-to-server)
    response.headers.set('Access-Control-Allow-Origin', '*')
  }
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept')
  response.headers.set('Access-Control-Max-Age', '86400')
  response.headers.set('Vary', 'Origin')
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin')

  // Handle preflight OPTIONS requests
  if (request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 204 })
    setCorsHeaders(response, origin)
    return response
  }

  const response = NextResponse.next()
  setCorsHeaders(response, origin)
  return response
}

export const config = {
  matcher: ['/api/:path*', '/health'],
}
