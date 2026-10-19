/**
 * In-memory sliding-window rate limiter.
 *
 * Limitation: state is per-process. On multi-instance deployments (e.g. Render
 * scale-out) each instance has its own window, so the effective limit is
 * `maxRequests * instanceCount`.  For a single-instance hobby deployment this
 * is perfectly sufficient.  If multi-instance rate limiting is required, swap
 * the `Map` for a Redis / Upstash KV store.
 */

type WindowEntry = {
  timestamps: number[]
}

const windows = new Map<string, WindowEntry>()

/**
 * Check whether `key` (typically an IP address + route identifier) has
 * exceeded `maxRequests` within the rolling `windowMs` window.
 *
 * @returns `true` when the request is allowed, `false` when rate-limited.
 */
export function checkRateLimit(key: string, maxRequests = 5, windowMs = 60_000): boolean {
  const now = Date.now()
  const cutoff = now - windowMs

  let entry = windows.get(key)
  if (!entry) {
    entry = { timestamps: [] }
    windows.set(key, entry)
  }

  // Evict timestamps outside the current window
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff)

  if (entry.timestamps.length >= maxRequests) {
    return false // rate-limited
  }

  entry.timestamps.push(now)
  return true // allowed
}

/** Resolve the best-effort client IP from a Next.js `Request`. */
export function getClientIp(request: Request): string {
  const headers = (request as { headers: Headers }).headers

  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    headers.get('x-real-ip') ??
    headers.get('cf-connecting-ip') ??
    'unknown'
  )
}
