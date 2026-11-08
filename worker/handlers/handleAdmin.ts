import { verifyAdminAuth } from "../pages/auth.js"
import { WorkerError } from "../common.js"
import { getPasteMetadata, patchPasteMetadataAdmin, type PasteMetadata } from "../storage/storage.js"
import { AdminPasteListItem, AdminPasteListResponse, AdminPasteMetadataPatchRequest } from "../../shared/interfaces.js"
import { parseExpiration, parseExpirationSpec } from "../../shared/parsers.js"
import { MAX_PASSWD_LEN, MIN_PASSWD_LEN } from "../../shared/constants.js"

function withAdminSecurityHeaders(resp: Response): Response {
  resp.headers.set("Cache-Control", "no-store")
  const vary = resp.headers.get("Vary")
  if (!vary) {
    resp.headers.set("Vary", "Authorization")
  } else if (
    !vary
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .includes("authorization")
  ) {
    resp.headers.set("Vary", `${vary}, Authorization`)
  }

  // Admin endpoints should not be callable cross-origin.
  resp.headers.delete("Access-Control-Allow-Origin")
  return resp
}

function makeAccessUrl(env: Env, name: string) {
  return `${env.DEPLOY_URL}/${name}`
}

function makeManageUrl(env: Env, name: string, passwd: string) {
  return `${env.DEPLOY_URL}/${name}:${passwd}`
}

function metaToAdminItem(env: Env, name: string, meta: PasteMetadata): AdminPasteListItem {
  const base = {
    name,
    url: makeAccessUrl(env, name),
    manageUrl: makeManageUrl(env, name, meta.passwd),

    createdAt: new Date(meta.createdAtUnix * 1000).toISOString(),
    lastModifiedAt: new Date(meta.lastModifiedAtUnix * 1000).toISOString(),

    sizeBytes: meta.sizeBytes,
    location: meta.location,
    filename: meta.filename,
    highlightLanguage: meta.highlightLanguage,
    encryptionScheme: meta.encryptionScheme,
    accessCounter: meta.accessCounter,
  }

  if (meta.permanent) {
    return { ...base, expirationKind: "never", expireAt: "never" }
  }

  return {
    ...base,
    expirationKind: "ttl",
    expireAt: new Date((meta.willExpireAtUnix ?? 0) * 1000).toISOString(),
  }
}

function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit")
  if (!raw) return 50
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new WorkerError(400, `invalid limit: '${raw}'`)
  }
  return Math.min(1000, Math.max(1, parsed))
}

export async function handleAdminApi(request: Request, env: Env, _ctx: ExecutionContext, isHead: boolean) {
  const authResp = verifyAdminAuth(request, env)
  if (authResp !== null) return withAdminSecurityHeaders(authResp)

  const url = new URL(request.url)

  const path = url.pathname.replace(/\/+$/, "")
  if (path === "/admin/api/pastes") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return withAdminSecurityHeaders(new Response("method not allowed", { status: 405 }))
    }
    const limit = parseLimit(url)
    const cursor = url.searchParams.get("cursor") || undefined
    const prefix = url.searchParams.get("prefix") || undefined

    const listedUnknown: unknown = await env.PB.list({ cursor, prefix, limit })
    if (!listedUnknown || typeof listedUnknown !== "object") {
      throw new WorkerError(500, "invalid kv list response")
    }
    const listed = listedUnknown as Record<string, unknown>
    const items: AdminPasteListItem[] = []

    const keysRaw = listed["keys"]
    const keys = Array.isArray(keysRaw) ? keysRaw : []
    for (const key of keys) {
      // Always load via getPasteMetadata to ensure migrated shape and consistent expiration behavior.
      const keyName =
        key && typeof key === "object" && "name" in key && typeof (key as { name?: unknown }).name === "string"
          ? (key as { name: string }).name
          : ""
      if (!keyName) continue

      const meta = await getPasteMetadata(env, keyName)
      if (!meta) continue
      items.push(metaToAdminItem(env, keyName, meta))
    }

    const cursorRaw = listed["cursor"]
    const cursorValue = typeof cursorRaw === "string" ? cursorRaw : ""
    const listCompleteRaw = listed["list_complete"]
    const listCompleteValue = typeof listCompleteRaw === "boolean" ? listCompleteRaw : Boolean(listCompleteRaw)

    const resp: AdminPasteListResponse = {
      cursor: cursorValue || null,
      listComplete: listCompleteValue,
      items,
    }

    return withAdminSecurityHeaders(
      new Response(isHead ? null : JSON.stringify(resp, null, 2), {
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
        },
      }),
    )
  }

  const patchMatch = path.match(/^\/admin\/api\/paste\/(.+)\/metadata$/)
  if (patchMatch) {
    if (request.method !== "PATCH") {
      return withAdminSecurityHeaders(new Response("method not allowed", { status: 405 }))
    }
    const name = decodeURIComponent(patchMatch[1])
    if (name.length === 0) {
      return withAdminSecurityHeaders(new Response("not found", { status: 404 }))
    }

    let body: AdminPasteMetadataPatchRequest
    try {
      const unknownBody: unknown = await request.json()
      if (typeof unknownBody !== "object" || unknownBody === null) {
        throw new WorkerError(400, "invalid json")
      }
      body = unknownBody as AdminPasteMetadataPatchRequest
    } catch {
      throw new WorkerError(400, "invalid json")
    }

    if (body.expire !== undefined && typeof body.expire !== "string") {
      throw new WorkerError(400, "invalid expire")
    }
    if (body.passwd !== undefined && typeof body.passwd !== "string") {
      throw new WorkerError(400, "invalid passwd")
    }

    if (!body || (body.expire === undefined && body.passwd === undefined)) {
      throw new WorkerError(400, "no fields to update")
    }

    let expirationSeconds: number | null | undefined
    if (body.expire !== undefined) {
      const parsed = parseExpirationSpec(body.expire)
      if (parsed === null) {
        throw new WorkerError(400, `‘${body.expire}’ is not a valid expiration specification`)
      }
      if (parsed.kind === "never") {
        expirationSeconds = null
      } else {
        const maxExpiration = parseExpiration(env.MAX_EXPIRATION)!
        expirationSeconds = Math.min(parsed.seconds, maxExpiration)
      }
    }

    if (body.passwd !== undefined) {
      if (body.passwd.length > MAX_PASSWD_LEN) {
        throw new WorkerError(400, `password too long (${body.passwd.length} > ${MAX_PASSWD_LEN})`)
      } else if (body.passwd.length < MIN_PASSWD_LEN) {
        throw new WorkerError(400, `password too short (${body.passwd.length} < ${MIN_PASSWD_LEN})`)
      } else if (body.passwd.includes("\n")) {
        throw new WorkerError(400, `password should not contain newline`)
      }
    }

    const originalMetadata = await getPasteMetadata(env, name)
    if (originalMetadata === null) {
      throw new WorkerError(404, `paste of name ‘${name}’ is not found`)
    }

    const meta = await patchPasteMetadataAdmin(env, name, originalMetadata, {
      now: new Date(),
      expirationSeconds,
      passwd: body.passwd,
    })

    const resp = metaToAdminItem(env, name, meta)
    return withAdminSecurityHeaders(
      new Response(JSON.stringify(resp, null, 2), {
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
        },
      }),
    )
  }

  return withAdminSecurityHeaders(new Response("not found", { status: 404 }))
}
