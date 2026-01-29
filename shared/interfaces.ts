// This file contains things shared with frontend

export type PasteLocation = "KV" | "R2"

export type ExpirationKind = "ttl" | "never"

export type PasteResponse =
  | {
      url: string
      manageUrl: string
      expirationKind: "ttl"
      expirationSeconds: number
      expireAt: string
    }
  | {
      url: string
      manageUrl: string
      expirationKind: "never"
      expirationSeconds: null
      expireAt: "never"
    }

export type MetaResponse =
  | {
      lastModifiedAt: string
      createdAt: string
      expirationKind: "ttl"
      expireAt: string
      sizeBytes: number
      location: PasteLocation
      filename?: string
      highlightLanguage?: string
      encryptionScheme?: string
    }
  | {
      lastModifiedAt: string
      createdAt: string
      expirationKind: "never"
      expireAt: "never"
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
  expirationKind: ExpirationKind
  expireAt: string | "never"

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
