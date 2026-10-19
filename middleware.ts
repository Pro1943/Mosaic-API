import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Routes that are intentionally server-to-server (cron, internal triggers).
 * These are authenticated via CRON_SECRET and are allowed even without an
 * Origin header — but they still do NOT receive a wildcard ACAO header, so
 * browsers cannot reach them cross-origin.
 */
const SERVER_ROUTES = [
  /^\/api\/maintenance\//,
  /^\/api\/home\/status$/,
  /^\/api\/ingest/,
]

function isAllowedOrigin(origin: string): boolean {
  // Allow localhost for local development
  if (/^http:\/\/localhost(:\d+)?$/.test(origin) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
    return true
  }

  // Allow Vercel preview/production deployments
  if (
    /^https:\/\/[a-zA-Z0-9_-]+\.vercel\.app$/.test(origin) ||
    /^https:\/\/mosaic[a-zA-Z0-9_-]*\.vercel\.app$/.test(origin)
  ) {
    return true
  }

  // Allow origins configured via environment variable (comma-separated list)
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
    response.headers.set('Access-Control-Allow-Credentials', 'true')
  }
  // No-origin requests (curl, server-to-server) intentionally do NOT receive
  // a wildcard ACAO header — that would allow any browser script to call us
  // without restrictions.  Omitting the header is the safe default.
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept')
  response.headers.set('Access-Control-Max-Age', '86400')
  response.headers.set('Vary', 'Origin')
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin')
  const pathname = request.nextUrl.pathname

  // Handle preflight OPTIONS requests
  if (request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 204 })
    setCorsHeaders(response, origin)
    return response
  }

  // Reject cross-origin requests whose origin is not on the allow-list.
  // Requests with no Origin header are allowed through (server-to-server).
  // Requests from an Origin are rejected unless that origin is on the list.
  if (origin && !isAllowedOrigin(origin)) {
    // For server-to-server maintenance routes, origin should never be present
    // — but if a browser somehow hits them with a bad origin, block it.
    const isServerRoute = SERVER_ROUTES.some((pattern) => pattern.test(pathname))
    if (!isServerRoute) {
      return new NextResponse(JSON.stringify({ error: 'Forbidden: Origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  const response = NextResponse.next()
  setCorsHeaders(response, origin)
  return response
}

export const config = {
  matcher: ['/api/:path*', '/health'],
}
