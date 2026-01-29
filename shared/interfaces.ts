// This file contains things shared with frontend

export type PasteLocation = "KV" | "R2"

export type PasteResponse = {
  url: string
  manageUrl: string
  expirationSeconds: number
  expireAt: string
}

export type MetaResponse = {
  lastModifiedAt: string
  createdAt: string
  expireAt: string
  sizeBytes: number
  location: PasteLocation
  filename?: string
  highlightLanguage?: string
  encryptionScheme?: string
}

export type MPUCreateResponse = {
  name: string
  key: string
  uploadId: string
}

export type AdminPasteListItem = {
  name: string
  url: string
  manageUrl: string

  createdAt: string
  lastModifiedAt: string
  expireAt: string

  sizeBytes: number
  location: PasteLocation
  filename?: string
  highlightLanguage?: string
  encryptionScheme?: string
  accessCounter?: number
}

export type AdminPasteListResponse = {
  cursor: string | null
  listComplete: boolean
  items: AdminPasteListItem[]
}

export type AdminPasteMetadataPatchRequest = {
  expire?: string
  passwd?: string
}
