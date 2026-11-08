import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

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

  const [selectedNames, setSelectedNames] = useState<Set<string>>(() => new Set())

  const [isLoading, setIsLoading] = useState(false)

  const canLoadMore = !isLoading && !listComplete

  const selectedCount = selectedNames.size

  const visibleNames = useMemo(() => items.map((x) => x.name), [items])
  const selectedVisibleCount = useMemo(() => {
    let n = 0
    for (const name of visibleNames) {
      if (selectedNames.has(name)) n += 1
    }
    return n
  }, [selectedNames, visibleNames])

  const allVisibleSelected = items.length > 0 && selectedVisibleCount === items.length
  const someVisibleSelected = selectedVisibleCount > 0 && selectedVisibleCount < items.length

  const visibleSelectRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (!visibleSelectRef.current) return
    visibleSelectRef.current.indeterminate = someVisibleSelected
  }, [someVisibleSelected])

  const fetchPage = useCallback(
    async ({
      cursor,
      prefix,
      limit,
    }: {
      cursor: string | null
      prefix: string
      limit: number
    }): Promise<AdminPasteListResponse | null> => {
      const u = new URL(`${API_URL}/admin/api/pastes`)
      if (prefix.length) u.searchParams.set("prefix", prefix)
      u.searchParams.set("limit", String(limit))
      if (cursor) u.searchParams.set("cursor", cursor)

      const resp = await fetch(u)
      if (!resp.ok) {
        await handleFailedResp("Failed to fetch admin list", resp)
        return null
      }
      return (await resp.json()) as AdminPasteListResponse
    },
    [handleFailedResp],
  )

  const load = useCallback(
    async ({ reset, prefixOverride }: { reset: boolean; prefixOverride?: string }) => {
      try {
        setIsLoading(true)
        const p = (prefixOverride ?? prefix).trim()
        const nextCursor = reset ? null : cursor

        const json = await fetchPage({ cursor: nextCursor, prefix: p, limit: 100 })
        if (!json) return
        setCursor(json.cursor)
        setListComplete(json.listComplete)
        setItems((prev) => (reset ? json.items : [...prev, ...json.items]))

        if (reset) setSelectedNames(new Set())
      } catch (e) {
        handleError("Failed to fetch admin list", e as Error)
      } finally {
        setIsLoading(false)
      }
    },
    [cursor, fetchPage, handleError, prefix],
  )

  useEffect(() => {
    void load({ reset: true })
  }, [])

  const loadAll = useCallback(
    async ({ prefixOverride }: { prefixOverride?: string } = {}) => {
      const p = (prefixOverride ?? prefix).trim()
      try {
        setIsLoading(true)

        let cur: string | null = null
        let complete = false
        const all: AdminPasteListItem[] = []

        while (!complete) {
          const json = await fetchPage({ cursor: cur, prefix: p, limit: 1000 })
          if (!json) return null
          all.push(...json.items)
          cur = json.cursor
          complete = json.listComplete
        }

        setItems(all)
        setCursor(cur)
        setListComplete(true)
        return all
      } catch (e) {
        handleError("Failed to fetch full admin list", e as Error)
        return null
      } finally {
        setIsLoading(false)
      }
    },
    [fetchPage, handleError, prefix],
  )

  const toggleSelected = useCallback((name: string, checked: boolean) => {
    setSelectedNames((prev) => {
      const next = new Set(prev)
      if (checked) next.add(name)
      else next.delete(name)
      return next
    })
  }, [])

  const selectVisible = useCallback(() => {
    setSelectedNames((prev) => {
      const next = new Set(prev)
      for (const name of visibleNames) next.add(name)
      return next
    })
  }, [visibleNames])

  const deselectVisible = useCallback(() => {
    setSelectedNames((prev) => {
      const next = new Set(prev)
      for (const name of visibleNames) next.delete(name)
      return next
    })
  }, [visibleNames])

  const invertVisible = useCallback(() => {
    setSelectedNames((prev) => {
      const next = new Set(prev)
      for (const name of visibleNames) {
        if (next.has(name)) next.delete(name)
        else next.add(name)
      }
      return next
    })
  }, [visibleNames])

  const selectAllItems = useCallback(async () => {
    const all = await loadAll()
    if (!all) return
    setSelectedNames(new Set(all.map((x) => x.name)))
  }, [loadAll])

  const invertAllItems = useCallback(async () => {
    const all = await loadAll()
    if (!all) return
    setSelectedNames((prev) => {
      const next = new Set<string>()
      for (const x of all) {
        if (!prev.has(x.name)) next.add(x.name)
      }
      return next
    })
  }, [loadAll])

  const clearSelection = useCallback(() => {
    setSelectedNames(new Set())
  }, [])

  async function onDeleteSelected() {
    if (!selectedCount) return
    const ok = window.confirm(`Delete ${selectedCount} selected item(s)?`)
    if (!ok) return

    try {
      setIsLoading(true)
      const selectedItems = items.filter((x) => selectedNames.has(x.name))

      const concurrency = 5
      let idx = 0
      const succeeded = new Set<string>()
      const failed: Array<{ name: string; status: number | "error" }> = []

      const worker = async () => {
        while (true) {
          const i = idx
          idx += 1
          const item = selectedItems[i]
          if (!item) return
          try {
            const resp = await fetch(item.manageUrl, { method: "DELETE" })
            if (!resp.ok) {
              failed.push({ name: item.name, status: resp.status })
              continue
            }
            succeeded.add(item.name)
          } catch {
            failed.push({ name: item.name, status: "error" })
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, selectedItems.length) }, () => worker()))

      if (succeeded.size) {
        setItems((prev) => prev.filter((x) => !succeeded.has(x.name)))
        setSelectedNames((prev) => {
          const next = new Set(prev)
          for (const name of succeeded) next.delete(name)
          return next
        })
      }

      if (!failed.length) {
        showModal("Deleted", "It may take ~60 seconds for deletion to propagate")
        return
      }
      showModal(
        "Partial delete",
        `Deleted ${succeeded.size}/${selectedItems.length}. Failed: ${failed.length}. (See console for details)`,
      )
      console.warn("Bulk delete failed items:", failed)
    } catch (e) {
      handleError("Failed to delete selected items", e as Error)
    } finally {
      setIsLoading(false)
    }
  }

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
      setSelectedNames((prev) => {
        if (!prev.has(item.name)) return prev
        const next = new Set(prev)
        next.delete(item.name)
        return next
      })
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
                <Button
                  color="primary"
                  className={tst}
                  isDisabled={isLoading}
                  onPress={() => void load({ reset: true })}
                >
                  Search
                </Button>
                <Button
                  className={tst}
                  isDisabled={isLoading}
                  onPress={() => {
                    setPrefix("")
                    setCursor(null)
                    setListComplete(false)
                    void load({ reset: true, prefixOverride: "" })
                  }}
                >
                  Reset
                </Button>
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-3 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
                <div className="text-small text-foreground-500">
                  Selected: {selectedCount}
                  {items.length ? ` (visible: ${selectedVisibleCount}/${items.length})` : ""}
                </div>
                <div className="flex flex-row gap-2 flex-wrap">
                  <Button
                    size="sm"
                    className={tst}
                    isDisabled={isLoading || !items.length}
                    onPress={() => selectVisible()}
                  >
                    Select visible
                  </Button>
                  <Button
                    size="sm"
                    className={tst}
                    isDisabled={isLoading || !items.length}
                    onPress={() => invertVisible()}
                  >
                    Invert visible
                  </Button>
                  <Button size="sm" className={tst} isDisabled={isLoading} onPress={() => void selectAllItems()}>
                    Select all
                  </Button>
                  <Button size="sm" className={tst} isDisabled={isLoading} onPress={() => void invertAllItems()}>
                    Invert all
                  </Button>
                  <Button
                    size="sm"
                    className={tst}
                    isDisabled={isLoading || !selectedCount}
                    onPress={() => clearSelection()}
                  >
                    Clear
                  </Button>
                  <Button
                    size="sm"
                    color="danger"
                    className={tst}
                    isDisabled={isLoading || !selectedCount}
                    onPress={() => void onDeleteSelected()}
                  >
                    Delete selected
                  </Button>
                </div>
              </div>
              <Table aria-label="Admin paste list" className={tst}>
                <TableHeader>
                  <TableColumn>
                    <input
                      ref={visibleSelectRef}
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={(e) => {
                        if (e.target.checked) selectVisible()
                        else deselectVisible()
                      }}
                      aria-label="Select visible"
                    />
                  </TableColumn>
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
                        <input
                          type="checkbox"
                          checked={selectedNames.has(item.name)}
                          onChange={(e) => toggleSelected(item.name, e.target.checked)}
                          aria-label={`Select ${item.name}`}
                        />
                      </TableCell>
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
                      <TableCell>
                        {item.expirationKind === "never" ? "Never" : new Date(item.expireAt).toLocaleString()}
                      </TableCell>
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
                          <Button size="sm" color="danger" className={tst} onPress={() => void onDelete(item)}>
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
              <Button className={tst} isDisabled={!canLoadMore} onPress={() => void load({ reset: false })}>
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
