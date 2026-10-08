export type NormalizedArticle = {
  source: string
  headline: string
  author: string | null
  published_at: string | null
  body: string
  url: string
}

export type SourcePreview = {
  name: string
  url: string
}

export type HomeStory = {
  topic_id: string
  neutral_headline: string
  snippet: string
  source_count: number
  sources_preview: SourcePreview[]
  updated_at: string
}

export type ClaimType = 'reported_fact' | 'quoted_statement' | 'interpretation' | 'framing'

export type ExtractedClaim = {
  claim: string
  type: ClaimType
}

export type ArticleExtraction = {
  source: string
  url: string
  headline: string
  claims: ExtractedClaim[]
}

export type ConflictView = {
  source: string
  stance: string
  emphasis: string
  emotion: string
}

export type ComparisonClaim = {
  claim_summary: string
  type: ClaimType
  shared_by: string[]
  conflicting: ConflictView[]
  progression: string
  consensus_level: 'low' | 'medium' | 'high'
}

export type ComparisonAnalysis = {
  overall_note: string
  claims: ComparisonClaim[]
}

export type NarrativeSection = {
  label: string
  body: string
}

export type NarrativeAnalysis = {
  opening_paragraph: string
  sections: NarrativeSection[]
  conclusion: string
  coverage_overlap_percent: number
  differs_on: string
}

export type TopicSource = {
  name: string
  url: string
  headline: string
  framing: string
}

export type TopicMeta = {
  topic_id: string
  neutral_headline: string
  snippet: string
  published_at: string | null
  source_count: number
  sources: TopicSource[]
}

export type MosaicError = {
  code: string
  message: string
  details?: unknown
}
