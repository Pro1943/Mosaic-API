import type { MosaicError } from './types'

const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GEMINI_API_KEY',
  'GNEWS_API_KEY',
  'NEWSDATA_API_KEY',
  'CURRENTS_API_KEY',
] as const

export type RequiredEnvKey = (typeof REQUIRED_ENV)[number]

export function getEnv(name: RequiredEnvKey): string {
  const value = process.env[name]
  if (!value) {
    throw createMosaicError('ENV_MISSING', `Missing required environment variable: ${name}`, { name })
  }
  return value
}

export function getOptionalEnv(name: string): string | undefined {
  return process.env[name] || undefined
}

export function createMosaicError(code: string, message: string, details?: unknown): Error & MosaicError {
  const error = new Error(message) as Error & MosaicError
  error.code = code
  error.message = message
  error.details = details
  return error
}

export function toMosaicError(error: unknown, fallbackCode = 'MOSAIC_ERROR'): MosaicError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const known = error as MosaicError
    return {
      code: String(known.code),
      message: String(known.message),
      details: known.details,
    }
  }

  if (error instanceof Error) {
    return { code: fallbackCode, message: error.message }
  }

  return { code: fallbackCode, message: 'Unknown Mosaic error', details: error }
}
