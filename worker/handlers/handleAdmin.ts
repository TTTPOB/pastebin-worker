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
  return {
    name,
    url: makeAccessUrl(env, name),
    manageUrl: makeManageUrl(env, name, meta.passwd),

    createdAt: new Date(meta.createdAtUnix * 1000).toISOString(),
    lastModifiedAt: new Date(meta.lastModifiedAtUnix * 1000).toISOString(),
    expirationKind: meta.permanent ? "never" : "ttl",
    expireAt: meta.permanent ? "never" : new Date((meta.willExpireAtUnix ?? 0) * 1000).toISOString(),

    sizeBytes: meta.sizeBytes,
    location: meta.location,
    filename: meta.filename,
    highlightLanguage: meta.highlightLanguage,
    encryptionScheme: meta.encryptionScheme,
    accessCounter: meta.accessCounter,
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

    const listed = await env.PB.list({ cursor, prefix, limit })
    const items: AdminPasteListItem[] = []

    for (const key of listed.keys) {
      // Always load via getPasteMetadata to ensure migrated shape and consistent expiration behavior.
      const meta = await getPasteMetadata(env, key.name)
      if (!meta) continue
      items.push(metaToAdminItem(env, key.name, meta))
    }

    const resp: AdminPasteListResponse = {
      cursor: listed.cursor || null,
      listComplete: listed.list_complete,
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
      body = (await request.json()) as AdminPasteMetadataPatchRequest
    } catch {
      throw new WorkerError(400, "invalid json")
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
