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

  const unauthorized = (message: string): Response => {
    return new Response(message, {
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

  const raw = request.headers.get("Authorization")
  if (!raw) return unauthorized("HTTP basic auth is required")

  try {
    const { username, password } = decodeBasicAuth(raw)
    if (!passwdMap.has(username) || !compareSync(password, passwdMap.get(username)!)) {
      return unauthorized("incorrect passwd for basic auth")
    }
    return null
  } catch {
    return unauthorized("invalid basic auth")
  }
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
  const raw = (env as unknown as { ADMIN_BASIC_AUTH?: unknown }).ADMIN_BASIC_AUTH

  // Allow configuring ADMIN_BASIC_AUTH as a dashboard Secret (stringified JSON).
  let admin_auth: Record<string, string> | undefined
  if (raw === undefined || raw === null) {
    admin_auth = undefined
  } else if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (trimmed.length === 0) {
      admin_auth = undefined
    } else {
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        throw new WorkerError(500, "invalid ADMIN_BASIC_AUTH: must be JSON")
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new WorkerError(500, "invalid ADMIN_BASIC_AUTH: must be an object")
      }
      admin_auth = parsed as Record<string, string>
    }
  } else {
    admin_auth = raw as Record<string, string>
  }

  if (admin_auth === undefined || Object.keys(admin_auth).length === 0) {
    return new Response("not found", {
      status: 404,
      headers: {
        // Hide the admin panel when not configured; also avoid any caching.
        "Cache-Control": "no-store",
        Vary: "Authorization",
      },
    })
  }
  return verifyAuthWithPasswdMap(request, new Map(Object.entries(admin_auth)))
}
