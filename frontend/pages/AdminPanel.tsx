import React, { useCallback, useEffect, useState } from "react"

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Divider,
  Input,
  Link,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@heroui/react"

import { DarkModeToggle, useDarkModeSelection } from "../components/DarkModeToggle.js"
import { useErrorModal } from "../components/ErrorModal.js"
import { tst } from "../utils/overrides.js"
import { formatSize } from "../utils/utils.js"

import type { AdminPasteListItem, AdminPasteListResponse } from "../../shared/interfaces.js"

import "../style.css"

function toDisplayUrl(rawUrl: string) {
  const u = new URL(rawUrl)
  u.pathname = "/d" + u.pathname
  return u.toString()
}

function toEditUrl(manageUrl: string) {
  return manageUrl
}

export function AdminPanel() {
  const [_, modeSelection, setModeSelection] = useDarkModeSelection()
  const { ErrorModal, showModal, handleFailedResp, handleError } = useErrorModal()

  const [prefix, setPrefix] = useState("")
  const [cursor, setCursor] = useState<string | null>(null)
  const [listComplete, setListComplete] = useState(false)
  const [items, setItems] = useState<AdminPasteListItem[]>([])

  const [isLoading, setIsLoading] = useState(false)

  const canLoadMore = !isLoading && !listComplete

  const load = useCallback(
    async ({ reset, prefixOverride }: { reset: boolean; prefixOverride?: string }) => {
      try {
        setIsLoading(true)
        const u = new URL(`${API_URL}/admin/api/pastes`)
        const p = (prefixOverride ?? prefix).trim()
        if (p.length) u.searchParams.set("prefix", p)
        u.searchParams.set("limit", "100")
        const nextCursor = reset ? null : cursor
        if (nextCursor) u.searchParams.set("cursor", nextCursor)

        const resp = await fetch(u)
        if (!resp.ok) {
          await handleFailedResp("Failed to fetch admin list", resp)
          return
        }
        const json: AdminPasteListResponse = await resp.json()
        setCursor(json.cursor)
        setListComplete(json.listComplete)
        setItems((prev) => (reset ? json.items : [...prev, ...json.items]))
      } catch (e) {
        handleError("Failed to fetch admin list", e as Error)
      } finally {
        setIsLoading(false)
      }
    },
    [cursor, handleError, handleFailedResp, prefix],
  )

  useEffect(() => {
    load({ reset: true })
  }, [])

  async function onDelete(item: AdminPasteListItem) {
    const ok = window.confirm(`Delete '${item.name}'?`)
    if (!ok) return
    try {
      setIsLoading(true)
      const resp = await fetch(item.manageUrl, { method: "DELETE" })
      if (!resp.ok) {
        await handleFailedResp(`Failed to delete '${item.name}'`, resp)
        return
      }
      showModal("Deleted", "It may take ~60 seconds for deletion to propagate")
      setItems((prev) => prev.filter((x) => x.name !== item.name))
    } catch (e) {
      handleError(`Failed to delete '${item.name}'`, e as Error)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <main className={`flex flex-col items-center min-h-screen font-sans ${tst} bg-background text-foreground`}>
      <div className="w-full max-w-[72rem] px-4 py-6">
        <div className="flex flex-row items-center justify-between gap-4">
          <div className="flex flex-row items-baseline gap-3">
            <Link href="/" className={`text-foreground-500 ${tst}`}>
              {INDEX_PAGE_TITLE}
            </Link>
            <span className="text-foreground-400">/</span>
            <h1 className="text-2xl">Admin</h1>
          </div>
          <DarkModeToggle modeSelection={modeSelection} setModeSelection={setModeSelection} />
        </div>

        <Card className={`mt-5 ${tst}`}>
          <CardHeader className="text-xl">Pastes</CardHeader>
          <Divider />
          <CardBody>
            <div className="flex flex-col md:flex-row gap-3 items-start md:items-end">
              <Input
                label="Prefix"
                value={prefix}
                onValueChange={setPrefix}
                placeholder="e.g. ~proj/"
                className="w-full md:max-w-[28rem]"
              />
              <div className="flex flex-row gap-2">
                <Button color="primary" className={tst} isDisabled={isLoading} onPress={() => load({ reset: true })}>
                  Search
                </Button>
                <Button
                  className={tst}
                  isDisabled={isLoading}
                  onPress={() => {
                    setPrefix("")
                    setCursor(null)
                    setListComplete(false)
                    load({ reset: true, prefixOverride: "" })
                  }}
                >
                  Reset
                </Button>
              </div>
            </div>

            <div className="mt-4">
              <Table aria-label="Admin paste list" className={tst}>
                <TableHeader>
                  <TableColumn>Name</TableColumn>
                  <TableColumn>Filename</TableColumn>
                  <TableColumn>Size</TableColumn>
                  <TableColumn>Location</TableColumn>
                  <TableColumn>Expire</TableColumn>
                  <TableColumn>Actions</TableColumn>
                </TableHeader>
                <TableBody
                  items={items}
                  emptyContent={isLoading ? "" : "No items"}
                  isLoading={isLoading}
                  loadingContent={<Spinner label="Loading..." />}
                >
                  {(item) => (
                    <TableRow key={item.name}>
                      <TableCell>
                        <Link href={item.url} className={tst}>
                          <code>{item.name}</code>
                        </Link>
                      </TableCell>
                      <TableCell>{item.filename || "-"}</TableCell>
                      <TableCell>{formatSize(item.sizeBytes)}</TableCell>
                      <TableCell>
                        <Chip size="sm" variant="flat">
                          {item.location}
                        </Chip>
                      </TableCell>
                      <TableCell>{new Date(item.expireAt).toLocaleString()}</TableCell>
                      <TableCell>
                        <div className="flex flex-row gap-2 flex-wrap">
                          <Button size="sm" className={tst} onPress={() => window.open(item.url, "_blank")}>
                            Raw
                          </Button>
                          <Button
                            size="sm"
                            className={tst}
                            onPress={() => window.open(toDisplayUrl(item.url), "_blank")}
                          >
                            Display
                          </Button>
                          <Button size="sm" className={tst} onPress={() => (location.href = toEditUrl(item.manageUrl))}>
                            Edit
                          </Button>
                          <Button size="sm" color="danger" className={tst} onPress={() => onDelete(item)}>
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="mt-4 flex flex-row items-center justify-between">
              <div className="text-small text-foreground-500">
                {listComplete ? "End of list" : cursor ? `Cursor: ${cursor}` : ""}
              </div>
              <Button className={tst} isDisabled={!canLoadMore} onPress={() => load({ reset: false })}>
                Load more
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
      <ErrorModal />
    </main>
  )
}
