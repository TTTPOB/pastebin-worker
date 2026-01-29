#!/usr/bin/env node

import { hashSync } from "bcrypt-ts"
import readline from "readline"

function toBase64Utf8(s) {
  return Buffer.from(s, "utf8").toString("base64")
}

function main() {
  const args = new Set(process.argv.slice(2))
  const printHeader = args.has("--print-header")
  const rounds = 8

  const rl = readline.createInterface({
    input: process.stdin,
    output: null,
    terminal: true,
  })

  process.stderr.write("Enter admin password (max 72 bytes): ")
  rl.question("", (password) => {
    rl.close()
    try {
      const hash = hashSync(password, rounds)
      const secretJson = JSON.stringify({ admin: hash })

      process.stdout.write(`ADMIN_BASIC_AUTH secret value:\n${secretJson}\n`)

      if (printHeader) {
        const header = `Authorization: Basic ${toBase64Utf8(`admin:${password}`)}`
        process.stdout.write(`\nAuthorization header (contains your password):\n${header}\n`)
      }
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })
}

main()
