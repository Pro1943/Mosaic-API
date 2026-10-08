import { createHash } from 'crypto'

export function stableHash(input: string): string {
  return createHash('sha256').update(input.trim().toLowerCase()).digest('hex').slice(0, 16)
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 72)
}
