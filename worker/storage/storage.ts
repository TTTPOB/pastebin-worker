import { dateToUnix, WorkerError } from "../common.js"
import { parseSize } from "../../shared/parsers.js"
import { PasteLocation } from "../../shared/interfaces.js"

// since CF does not allow expiration shorter than 60s, extend the expiration to 70s
const PASTE_EXPIRE_SPECIFIED_MIN = 70

/* Since we need the metadata stored in KV to perform R2 cleanup,
 the paste in KV should not be deleted until it is cleaned in R2.
 We extend the lifetime by 2 days to avoid it being cleaned in VK too early
 */
const PASTE_EXPIRE_EXTENSION_FOR_R2 = 2 * 24 * 60 * 60

// TODO: allow admin to upload permanent paste
// TODO: add filename length check
export type PasteMetadata = {
  schemaVersion: 1
  location: PasteLocation // new field on V1
  passwd: string

  lastModifiedAtUnix: number
  createdAtUnix: number
  // If permanent is true, willExpireAtUnix may be absent.
  willExpireAtUnix?: number
  permanent?: boolean

  accessCounter: number // a counter representing how frequent it is accessed, to administration usage
  sizeBytes: number
  filename?: string
  highlightLanguage?: string
  encryptionScheme?: string
}

type PasteMetadataInStorage = {
  schemaVersion: number
  location?: PasteLocation
  passwd: string

  lastModifiedAtUnix?: number
  createdAtUnix?: number
  willExpireAtUnix?: number
  permanent?: boolean

  accessCounter?: number
  sizeBytes?: number
  filename?: string
  highlightLanguage?: string
  encryptionScheme?: string
}

function legacyMetadataFromMissing(
  now: Date,
  inferred: { location: PasteLocation; sizeBytes: number },
): PasteMetadataInStorage {
  const nowUnix = dateToUnix(now)
  return {
    schemaVersion: 0,
    location: inferred.location,
    passwd: "",
    lastModifiedAtUnix: nowUnix,
    createdAtUnix: nowUnix,
    willExpireAtUnix: undefined,
    permanent: true,
    accessCounter: 0,
    sizeBytes: inferred.sizeBytes,
  }
}

function migratePasteMetadata(original: PasteMetadataInStorage): PasteMetadata {
  const permanent = original.permanent === true || original.willExpireAtUnix === undefined
  return {
    schemaVersion: 1,
    location: original.location || "KV",
    passwd: original.passwd,

    lastModifiedAtUnix: original.lastModifiedAtUnix ?? 0,
    createdAtUnix: original.createdAtUnix ?? 0,
    willExpireAtUnix: permanent ? undefined : original.willExpireAtUnix,
    permanent,

    accessCounter: original.accessCounter || 0,
    sizeBytes: original.sizeBytes || 0,
    filename: original.filename,
    highlightLanguage: original.highlightLanguage,
    encryptionScheme: original.encryptionScheme,
  }
}

function isExpired(meta: PasteMetadata, nowUnixFloat: number): boolean {
  if (meta.permanent) return false
  if (meta.willExpireAtUnix === undefined) return false
  return meta.willExpireAtUnix < nowUnixFloat
}

export type PasteWithMetadata = {
  paste: ArrayBuffer | ReadableStream
  metadata: PasteMetadata
  httpEtag?: string
}

async function updateAccessCounter(env: Env, short: string, value: ArrayBuffer, metadata: PasteMetadata) {
  // update counter with probability 1%
  if (Math.random() < 0.01) {
    metadata.accessCounter += 1
    try {
      if (metadata.permanent) {
        await env.PB.put(short, value, { metadata })
      } else {
        await env.PB.put(short, value, {
          metadata,
          expiration: metadata.willExpireAtUnix,
        })
      }
    } catch (e) {
      // ignore rate limit message
      if (!(e as Error).message.includes("KV PUT failed: 429 Too Many Requests")) {
        throw e
      }
    }
  }
}

export async function getPaste(env: Env, short: string, ctx: ExecutionContext): Promise<PasteWithMetadata | null> {
  const item = await env.PB.getWithMetadata<PasteMetadataInStorage>(short, {
    type: "arrayBuffer",
  })

  if (item.value === null) {
    return null
  } else {
    const now = new Date()
    let metaInStorage: PasteMetadataInStorage
    if (item.metadata === null) {
      // Best-effort recovery for legacy data written without metadata.
      const r2Object = await env.R2.get(short)
      if (r2Object !== null) {
        const inferredSize = (r2Object as unknown as { size?: number }).size ?? 0
        metaInStorage = legacyMetadataFromMissing(now, { location: "R2", sizeBytes: inferredSize })
        ctx.waitUntil(env.PB.put(short, item.value, { metadata: metaInStorage }))
        const metadata = migratePasteMetadata(metaInStorage)
        return { paste: r2Object.body, metadata, httpEtag: r2Object.httpEtag }
      }

      metaInStorage = legacyMetadataFromMissing(now, { location: "KV", sizeBytes: item.value.byteLength })
      ctx.waitUntil(env.PB.put(short, item.value, { metadata: metaInStorage }))
    } else {
      metaInStorage = item.metadata
    }

    const metadata = migratePasteMetadata(metaInStorage)
    const expired = isExpired(metadata, new Date().getTime() / 1000)

    ctx.waitUntil(
      (async () => {
        if (expired) {
          await deletePaste(env, short, metadata)
          return null
        }
        await updateAccessCounter(env, short, item.value!, metadata)
      })(),
    )

    if (expired) {
      return null
    }

    if (metadata.location === "R2") {
      const object = await env.R2.get(short)
      if (object === null) {
        return null
      }
      return { paste: object.body, metadata, httpEtag: object.httpEtag }
    } else {
      return { paste: item.value, metadata }
    }
  }
}

// we separate usage of getPasteMetadata and getPaste to make access metric more reliable
export async function getPasteMetadata(env: Env, short: string): Promise<PasteMetadata | null> {
  const item = await env.PB.getWithMetadata<PasteMetadataInStorage>(short, {
    type: "stream",
  })

  if (item.value === null) {
    return null
  } else {
    let metaInStorage: PasteMetadataInStorage
    if (item.metadata === null) {
      // Best-effort recovery for legacy data written without metadata.
      const full = await env.PB.getWithMetadata<PasteMetadataInStorage>(short, { type: "arrayBuffer" })
      if (full.value === null) return null

      const now = new Date()
      let inferredLocation: PasteLocation = "KV"
      let inferredSize = full.value.byteLength

      const r2Object = await env.R2.get(short)
      if (r2Object !== null) {
        inferredLocation = "R2"
        inferredSize = (r2Object as unknown as { size?: number }).size ?? inferredSize
      }

      metaInStorage = legacyMetadataFromMissing(now, { location: inferredLocation, sizeBytes: inferredSize })
      await env.PB.put(short, full.value, { metadata: metaInStorage })
    } else {
      metaInStorage = item.metadata
    }

    const metadata = migratePasteMetadata(metaInStorage)
    if (isExpired(metadata, new Date().getTime() / 1000)) return null
    return metadata
  }
}

type PasteMetadataPatchOptions = {
  now: Date
  // undefined means unchanged; null means never expire.
  expirationSeconds?: number | null
  passwd?: string
}

export async function patchPasteMetadataAdmin(
  env: Env,
  pasteName: string,
  originalMetadata: PasteMetadata,
  options: PasteMetadataPatchOptions,
): Promise<PasteMetadata> {
  const nowUnix = dateToUnix(options.now)
  const nowUnixFloat = options.now.getTime() / 1000

  const nextPermanent =
    options.expirationSeconds === null
      ? true
      : options.expirationSeconds !== undefined
        ? false
        : (originalMetadata.permanent ?? false)
  const willExpireAtUnix = nextPermanent
    ? undefined
    : options.expirationSeconds !== undefined
      ? nowUnix + (options.expirationSeconds as number)
      : originalMetadata.willExpireAtUnix

  let expirationUnixSpecified: number | undefined
  if (!nextPermanent) {
    const seconds =
      options.expirationSeconds !== undefined
        ? (options.expirationSeconds as number)
        : Math.max(0, (originalMetadata.willExpireAtUnix ?? nowUnix) - nowUnix)
    expirationUnixSpecified = nowUnix + Math.max(seconds, PASTE_EXPIRE_SPECIFIED_MIN)
    if (originalMetadata.location === "R2") {
      expirationUnixSpecified += PASTE_EXPIRE_EXTENSION_FOR_R2
    }
  }

  // Refuse updating an already-expired paste.
  if (!originalMetadata.permanent && (originalMetadata.willExpireAtUnix ?? 0) < nowUnixFloat) {
    throw new WorkerError(404, `paste of name '${pasteName}' not found`)
  }

  const kvItem = await env.PB.getWithMetadata<PasteMetadataInStorage>(pasteName, { type: "arrayBuffer" })
  if (kvItem.value === null) {
    throw new WorkerError(404, `paste of name '${pasteName}' not found`)
  }
  // If metadata is missing, treat it as legacy data and repair with best-effort defaults.
  const existingMetaInStorage: PasteMetadataInStorage =
    kvItem.metadata ??
    legacyMetadataFromMissing(options.now, { location: originalMetadata.location, sizeBytes: kvItem.value.byteLength })
  if (kvItem.metadata === null) {
    await env.PB.put(pasteName, kvItem.value, { metadata: existingMetaInStorage })
  }

  const metadata: PasteMetadata = {
    schemaVersion: 1,
    location: originalMetadata.location,
    filename: originalMetadata.filename,
    highlightLanguage: originalMetadata.highlightLanguage,
    passwd: options.passwd ?? originalMetadata.passwd,

    lastModifiedAtUnix: nowUnix,
    createdAtUnix: originalMetadata.createdAtUnix,
    willExpireAtUnix,
    permanent: nextPermanent,

    accessCounter: originalMetadata.accessCounter,
    sizeBytes: originalMetadata.sizeBytes,
    encryptionScheme: originalMetadata.encryptionScheme,
  }

  // For R2 objects, KV value is a placeholder string/empty buffer; keep the stored value.
  if (nextPermanent) {
    await env.PB.put(pasteName, kvItem.value, { metadata })
  } else {
    await env.PB.put(pasteName, kvItem.value, {
      metadata,
      expiration: expirationUnixSpecified,
    })
  }

  return metadata
}

interface WriteOptions {
  now: Date
  contentLength: number
  // null means never expire.
  expirationSeconds: number | null
  passwd: string
  filename?: string
  highlightLanguage?: string
  encryptionScheme?: string
  isMPUComplete: boolean
}

export async function updatePaste(
  env: Env,
  pasteName: string,
  content: ArrayBuffer | ReadableStream,
  originalMetadata: PasteMetadata,
  options: WriteOptions,
) {
  const nowUnix = dateToUnix(options.now)
  const permanent = options.expirationSeconds === null
  const expirationUnix = permanent ? undefined : nowUnix + (options.expirationSeconds as number)
  let expirationUnixSpecified: number | undefined = permanent
    ? undefined
    : nowUnix + Math.max(options.expirationSeconds as number, PASTE_EXPIRE_SPECIFIED_MIN)

  if (originalMetadata.location === "R2") {
    if (expirationUnixSpecified !== undefined) {
      expirationUnixSpecified = expirationUnixSpecified + PASTE_EXPIRE_EXTENSION_FOR_R2
    }

    if (!options.isMPUComplete) {
      await env.R2.put(pasteName, content)
    }
  }

  // if the paste is previous on R2, we keep it on R2 to avoid losing reference to it
  const newLocation =
    originalMetadata.location === "R2" || options.isMPUComplete || options.contentLength > parseSize(env.R2_THRESHOLD)!
      ? "R2"
      : "KV"
  const metadata: PasteMetadata = {
    schemaVersion: 1,
    location: newLocation,
    filename: options.filename,
    highlightLanguage: options.highlightLanguage,
    passwd: options.passwd,

    lastModifiedAtUnix: dateToUnix(options.now),
    createdAtUnix: originalMetadata.createdAtUnix,
    willExpireAtUnix: expirationUnix,
    permanent,
    accessCounter: originalMetadata.accessCounter,
    sizeBytes: options.contentLength,
    encryptionScheme: options.encryptionScheme,
  }

  if (permanent) {
    await env.PB.put(pasteName, originalMetadata.location === "R2" ? "" : content, {
      metadata,
    })
  } else {
    await env.PB.put(pasteName, originalMetadata.location === "R2" ? "" : content, {
      metadata,
      expiration: expirationUnixSpecified,
    })
  }
}

export async function createPaste(
  env: Env,
  pasteName: string,
  content: ArrayBuffer | ReadableStream,
  options: WriteOptions,
) {
  const nowUnix = dateToUnix(options.now)
  const permanent = options.expirationSeconds === null
  const expirationUnix = permanent ? undefined : nowUnix + (options.expirationSeconds as number)

  let expirationUnixSpecified: number | undefined = permanent
    ? undefined
    : nowUnix + Math.max(options.expirationSeconds as number, PASTE_EXPIRE_SPECIFIED_MIN)

  const location = options.isMPUComplete || options.contentLength > parseSize(env.R2_THRESHOLD)! ? "R2" : "KV"
  if (location === "R2") {
    if (expirationUnixSpecified !== undefined) {
      expirationUnixSpecified = expirationUnixSpecified + PASTE_EXPIRE_EXTENSION_FOR_R2
    }

    if (!options.isMPUComplete) {
      await env.R2.put(pasteName, content)
    }
  }

  const metadata: PasteMetadata = {
    schemaVersion: 1,
    location: location,
    filename: options.filename,
    highlightLanguage: options.highlightLanguage,
    passwd: options.passwd,

    lastModifiedAtUnix: dateToUnix(options.now),
    createdAtUnix: dateToUnix(options.now),
    willExpireAtUnix: expirationUnix,
    permanent,
    accessCounter: 0,
    sizeBytes: options.contentLength,
    encryptionScheme: options.encryptionScheme,
  }

  if (permanent) {
    await env.PB.put(pasteName, location === "R2" ? "" : content, { metadata })
  } else {
    await env.PB.put(pasteName, location === "R2" ? "" : content, {
      metadata,
      expiration: expirationUnixSpecified,
    })
  }
}

export async function pasteNameAvailable(env: Env, pasteName: string): Promise<boolean> {
  const item = await env.PB.getWithMetadata<PasteMetadata>(pasteName)
  if (item.value == null) {
    return true
  } else if (item.metadata === null) {
    // Legacy KV entry without metadata should be considered occupied.
    return false
  } else {
    const metadata = migratePasteMetadata(item.metadata)
    if (metadata.permanent) return false
    if (metadata.willExpireAtUnix === undefined) return false
    return metadata.willExpireAtUnix < new Date().getTime() / 1000
  }
}

export async function deletePaste(env: Env, pasteName: string, originalMetadata: PasteMetadata): Promise<void> {
  await env.PB.delete(pasteName)
  if (originalMetadata.location === "R2") {
    await env.R2.delete(pasteName)
  }
}

export async function cleanExpiredInR2(env: Env, controller: ScheduledController) {
  // types generated by wrangler somehow not working, so cast manually
  type Listed = {
    list_complete: false
    keys: KVNamespaceListKey<PasteMetadataInStorage, string>[]
    cursor: string
    cacheStatus: string | null
  }

  const nowUnix = controller.scheduledTime / 1000

  let numCleaned = 0
  const r2NamesToClean: string[] = []

  async function clean() {
    await env.R2.delete(r2NamesToClean)
    numCleaned += r2NamesToClean.length
    r2NamesToClean.length = 0
  }

  let cursor: string | null = null
  while (true) {
    const listed = (await env.PB.list<PasteMetadataInStorage>({ cursor })) as Listed

    cursor = listed.cursor

    for (const key of listed.keys) {
      if (key.metadata !== undefined) {
        const metadata = migratePasteMetadata(key.metadata)
        if (
          metadata.location === "R2" &&
          !metadata.permanent &&
          metadata.willExpireAtUnix !== undefined &&
          metadata.willExpireAtUnix < nowUnix
        ) {
          r2NamesToClean.push(key.name)

          if (r2NamesToClean.length === 1000) {
            await clean()
          }
        }
      }
    }

    if (listed.list_complete) break
  }
  await clean()

  console.log(`${numCleaned} buckets cleaned`)
}
