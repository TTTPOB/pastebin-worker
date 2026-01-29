import { atob_utf8, btoa_utf8, WorkerError } from "../common.js"
import { compareSync } from "bcrypt-ts"

// Encoding function
export function encodeBasicAuth(username: string, password: string): string {
  const credentials = `${username}:${password}`
  return `Basic ${btoa_utf8(credentials)}`
}

// Decoding function
export function decodeBasicAuth(encodedString: string): {
  username: string
  password: string
} {
  const [scheme, encodedCredentials] = encodedString.split(" ")
  if (scheme !== "Basic") {
    throw new WorkerError(400, "Invalid authentication scheme")
  }
  const credentials = atob_utf8(encodedCredentials)
  const [username, password] = credentials.split(":", 2)
  return { username, password }
}

function verifyAuthWithPasswdMap(request: Request, passwdMap: Map<string, string>): Response | null {
  if (passwdMap.size === 0) return null

  if (request.headers.has("Authorization")) {
    const { username, password } = decodeBasicAuth(request.headers.get("Authorization")!)
    if (!passwdMap.has(username) || !compareSync(password, passwdMap.get(username)!)) {
      throw new WorkerError(401, "incorrect passwd for basic auth")
    }
    return null
  }

  return new Response("HTTP basic auth is required", {
    status: 401,
    headers: {
      // Prompts the user for credentials.
      "WWW-Authenticate": 'Basic charset="UTF-8"',
      // Never cache auth-gated responses.
      "Cache-Control": "no-store",
      Vary: "Authorization",
    },
  })
}

// return null if auth passes or is not required,
// return auth page if auth is required
// throw WorkerError if auth failed
// TODO: only allow hashed passwd
export function verifyAuth(request: Request, env: Env): Response | null {
  // pass auth if 'BASIC_AUTH' is not present
  const basic_auth = env.BASIC_AUTH as { [username: string]: string }
  return verifyAuthWithPasswdMap(request, new Map(Object.entries(basic_auth)))
}

// Admin-only auth: if ADMIN_BASIC_AUTH is not configured, hide admin endpoints.
export function verifyAdminAuth(request: Request, env: Env): Response | null {
  const admin_auth = env.ADMIN_BASIC_AUTH as { [username: string]: string } | undefined
  if (admin_auth === undefined || Object.keys(admin_auth).length === 0) {
    return new Response("not found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
      },
    })
  }
  return verifyAuthWithPasswdMap(request, new Map(Object.entries(admin_auth)))
}
