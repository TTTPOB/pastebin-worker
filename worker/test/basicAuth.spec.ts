import { expect, test, it, describe, beforeEach, afterEach } from "vitest"
import { BASE_URL, genRandomBlob, upload, workerFetch } from "./testUtils"
import { encodeBasicAuth, decodeBasicAuth } from "../pages/auth"
import { createExecutionContext, env } from "cloudflare:test"
import { hashSync } from "bcrypt-ts"

test("basic auth encode and decode", () => {
  const userPasswdPairs = [
    ["user1", "passwd1"],
    ["あおい", "まなか"],
    ["1234#", "اهلا"],
  ]
  for (const [user, passwd] of userPasswdPairs) {
    const encoded = encodeBasicAuth(user, passwd)
    const decoded = decodeBasicAuth(encoded)
    expect(decoded.username).toStrictEqual(user)
    expect(decoded.password).toStrictEqual(passwd)
  }
})

describe("admin basic auth", () => {
  const ctx = createExecutionContext()
  const users: Record<string, string> = {
    user1: "passwd1",
    user2: "passwd2",
  }
  const authHeader = { Authorization: encodeBasicAuth("user1", users["user1"]) }
  const blob1 = genRandomBlob(1024)

  /* TODO: Due to the limitation of workers-sdk, setting env here may also affect other tests occasionally
   It means that other tests may fail with 400 error occasionally
   ref: https://github.com/cloudflare/workers-sdk/issues/7339
  */
  beforeEach(() => {
    env.ADMIN_BASIC_AUTH = Object.fromEntries(
      Object.entries(users).map(([user, passwd]) => [user, hashSync(passwd, 8)]),
    )
  })

  afterEach(() => {
    env.ADMIN_BASIC_AUTH = {}
  })

  it("should allow upload without auth", async () => {
    await upload(ctx, { c: blob1 })
  })

  it("should require auth for /admin", async () => {
    const resp = await workerFetch(ctx, `${BASE_URL}/admin`)
    expect(resp.status).toStrictEqual(401)
    expect(resp.headers.get("Cache-Control")).toStrictEqual("no-store")
    expect(resp.headers.get("Vary") || "").toMatch(/Authorization/i)
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  it("should allow /admin with auth", async () => {
    const resp = await workerFetch(ctx, new Request(`${BASE_URL}/admin`, { headers: authHeader }))
    expect(resp.status).toStrictEqual(200)
    expect(resp.headers.get("Cache-Control")).toStrictEqual("no-store")
    expect(resp.headers.get("Vary") || "").toMatch(/Authorization/i)
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  it("should accept ADMIN_BASIC_AUTH as JSON string secret", async () => {
    env.ADMIN_BASIC_AUTH = JSON.stringify(
      Object.fromEntries(Object.entries(users).map(([user, passwd]) => [user, hashSync(passwd, 8)])),
    ) as unknown as object

    const resp = await workerFetch(ctx, new Request(`${BASE_URL}/admin`, { headers: authHeader }))
    expect(resp.status).toStrictEqual(200)
  })
})
