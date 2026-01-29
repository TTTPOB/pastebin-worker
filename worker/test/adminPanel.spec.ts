import { describe, it, expect, afterEach } from "vitest"
import { createExecutionContext, env } from "cloudflare:test"
import { hashSync } from "bcrypt-ts"

import { encodeBasicAuth } from "../pages/auth"
import { upload, workerFetch, BASE_URL } from "./testUtils"
import { parsePath } from "../../shared/parsers"

describe("admin panel api", () => {
  const ctx = createExecutionContext()

  afterEach(() => {
    env.ADMIN_BASIC_AUTH = {}
  })

  it("should hide admin api when ADMIN_BASIC_AUTH is empty", async () => {
    env.ADMIN_BASIC_AUTH = {}
    const resp = await workerFetch(ctx, `${BASE_URL}/admin/api/pastes`)
    expect(resp.status).toStrictEqual(404)
    expect(resp.headers.get("Cache-Control")).toStrictEqual("no-store")
    expect(resp.headers.get("Vary") || "").toMatch(/Authorization/i)
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  it("should require basic auth for admin api", async () => {
    env.ADMIN_BASIC_AUTH = { admin: hashSync("passwd", 8) }
    const resp = await workerFetch(ctx, `${BASE_URL}/admin/api/pastes`)
    expect(resp.status).toStrictEqual(401)
    expect(resp.headers.get("Cache-Control")).toStrictEqual("no-store")
    expect(resp.headers.get("Vary") || "").toMatch(/Authorization/i)
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  it("should list pastes with auth", async () => {
    env.ADMIN_BASIC_AUTH = { admin: hashSync("passwd", 8) }
    const authHeader = { Authorization: encodeBasicAuth("admin", "passwd") }

    const up = await upload(ctx, { c: "hello" })
    const { name } = parsePath(new URL(up.url).pathname)

    const resp = await workerFetch(ctx, new Request(`${BASE_URL}/admin/api/pastes?limit=50`, { headers: authHeader }))
    expect(resp.status).toStrictEqual(200)
    expect(resp.headers.get("Content-Type")).toStrictEqual("application/json;charset=UTF-8")
    expect(resp.headers.get("Cache-Control")).toStrictEqual("no-store")
    expect(resp.headers.get("Vary") || "").toMatch(/Authorization/i)
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBeNull()
    const json = (await resp.json()) as {
      cursor: string | null
      listComplete: boolean
      items: Array<{ name: string; url: string; manageUrl: string }>
    }

    const found = json.items.find((x) => x.name === name)
    expect(found).toBeDefined()
    expect(found!.url).toStrictEqual(`${BASE_URL}/${name}`)
    expect(found!.manageUrl.startsWith(`${BASE_URL}/${name}:`)).toStrictEqual(true)
  })

  it("should patch expiration and password without reupload", async () => {
    env.ADMIN_BASIC_AUTH = { admin: hashSync("passwd", 8) }
    const authHeader = { Authorization: encodeBasicAuth("admin", "passwd") }

    const up = await upload(ctx, { c: "hello" })
    const { name } = parsePath(new URL(up.url).pathname)

    const newPasswd = "newpassw0rd"
    const patchResp = await workerFetch(
      ctx,
      new Request(`${BASE_URL}/admin/api/paste/${encodeURIComponent(name)}/metadata`, {
        method: "PATCH",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ expire: "1d", passwd: newPasswd }),
      }),
    )
    expect(patchResp.status).toStrictEqual(200)
    const patched = (await patchResp.json()) as { manageUrl: string; expirationKind: string; expireAt: string }
    expect(patched.manageUrl.startsWith(`${BASE_URL}/${name}:`)).toStrictEqual(true)
    expect(patched.manageUrl.endsWith(`:${newPasswd}`)).toStrictEqual(true)
    expect(patched.expirationKind).toStrictEqual("ttl")

    const metaResp = await workerFetch(ctx, `${BASE_URL}/m/${encodeURIComponent(name)}`)
    expect(metaResp.status).toStrictEqual(200)
    const meta = (await metaResp.json()) as { expirationKind: string; expireAt: string }
    expect(meta.expirationKind).toStrictEqual("ttl")
    expect(new Date(meta.expireAt).getTime()).toBeGreaterThan(Date.now() + 12 * 60 * 60 * 1000)

    const oldDelete = await workerFetch(ctx, new Request(up.manageUrl, { method: "DELETE" }))
    expect(oldDelete.status).toStrictEqual(403)

    const newDelete = await workerFetch(ctx, new Request(`${BASE_URL}/${name}:${newPasswd}`, { method: "DELETE" }))
    expect(newDelete.status).toStrictEqual(200)
  })
})
