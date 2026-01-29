# 管理面板（Admin Panel）方案调研

目标：加入一个“管理员可用”的管理面板，用于查看/筛选现有 paste（snippet/file），并支持查看过期时间、编辑、删除等操作；尽量复用当前已存在的后端能力与前端编辑页。

本文只做调研与落地方案拆解，不直接实现。

## 现状梳理：已经具备什么能力

### 1) 读/展示相关

- 原始内容读取：`GET /<name>[.<ext>]` 或 `GET /<name>/<filename>`
  - 实现在 `worker/handlers/handleRead.ts`
  - 会基于扩展名/filename 推断 `Content-Type`，并设置 `Content-Disposition`
- 展示页（可解密、语法高亮等）：`GET /d/<name>`
  - 服务器返回 `display.html`，前端 `frontend/pages/DisplayPaste.tsx` 负责拉取内容并渲染
- 元数据：`GET /m/<name>`
  - 返回 `MetaResponse`（createdAt/expireAt/size/location/filename/highlightLanguage/encryptionScheme）
  - 定义在 `shared/interfaces.ts`

### 2) 写/更新/删除（管理能力）

- 新建：`POST /`（`multipart/form-data`）
  - 字段：`c`(content)、`e`(expiration)、`s`(password)、`n`(name)、`p`(private)、`lang`、`encryption-scheme`
  - 返回 `PasteResponse`：`url`、`manageUrl`、`expirationSeconds`、`expireAt`
  - 实现在 `worker/handlers/handleWrite.ts`
- 更新：`PUT /<name>:<passwd>`（`multipart/form-data`）
  - 字段：`c` 必须存在；`e`、`s` 可选
  - 重要限制：想“只改过期时间/只改密码”也必须带上 `c`（即需要重新上传内容）
- 删除：`DELETE /<name>:<passwd>`
  - 实现在 `worker/handlers/handleDelete.ts`

### 3) 现有“编辑/删除 UI”是怎么工作的

- 访问 `/<name>:<passwd>` 会被后端当作“管理 URL”，实际返回 `index.html`（SPA）
  - 逻辑在 `worker/handlers/handleRead.ts`：检测到路径包含 `:` 时把它当作管理入口并转到 `index.html`
- 前端首页 `frontend/pages/PasteBin.tsx` 在 `useEffect` 里解析 `location.pathname`
  - 如果解析到 `password`：
    - 自动把 `uploadKind` 切换到 `manage`
    - 把 `manageUrl` 设置为 `${APIUrl}/${name}:${password}`
    - 拉取 `GET /<name>` 的内容，自动判断是文本编辑（snippet）还是文件（file）
    - Delete 按钮直接 `fetch(manageUrl, { method: "DELETE" })`
    - Update 通过 `uploadPaste()` 走 `PUT manageUrl`

结论：编辑/删除能力已经存在；如果管理面板能“列出所有 paste 并拿到 manageUrl”，最简单就是跳转/复用当前的 `/<name>:<passwd>` 编辑页。

## 关键问题：管理面板需要哪些额外能力

“管理面板”的核心差异通常是：

1. 能“枚举/搜索”所有 paste（而不是用户手里已有的 manageUrl）。
2. 能显示更丰富的状态（过期时间、大小、存储位置、访问热度等）。
3. 能执行删除/编辑/延期等操作。

当前系统缺失的是 (1)：没有对外提供“列出所有 key”的 HTTP API。

## 存储层现实：可以列出所有 paste 吗？

可以。

- KV 绑定 `PB` 支持 `env.PB.list()`，项目里已经用于定时清理 R2：`worker/storage/storage.ts` 的 `cleanExpiredInR2()`。
- 每个 paste 的 KV metadata 里包含：
  - `passwd`（更新/删除所需的密码）
  - `createdAtUnix` / `lastModifiedAtUnix` / `willExpireAtUnix`
  - `sizeBytes`、`location`(KV/R2)、`filename`、`highlightLanguage`、`encryptionScheme`、`accessCounter`

这意味着：管理员侧如果能拿到 KV list + metadata，就能直接拼出 `manageUrl` 并复用现有的 PUT/DELETE 能力，无需新增“管理员特权删除/编辑”接口。

## 安全性红线（非常重要）

因为 KV metadata 里包含 `passwd`，一旦你把“列表 API”开放给任何未授权用户，就等价于把所有 paste 的管理权限泄露。

所以：

- 管理面板及其 API 必须强制认证。
- 不能复用当前 `verifyAuth()` 的“空 BASIC_AUTH 等于不需要认证”的语义来保护管理面板。
  - `worker/pages/auth.ts` 中：`BASIC_AUTH` 为空时直接放行。
  - 对“管理面板”来说，应该是：未配置管理员认证 => 直接禁用（404/403），而不是放开。

推荐策略：

- 使用独立的 `ADMIN_BASIC_AUTH` 保护管理面板（不影响普通用户上传/访问）。
- 仅当 `env.ADMIN_BASIC_AUTH` 非空时启用管理面板（否则返回 404）。
- 对所有 `/admin` 页面与 `/admin/api/*` 使用 Basic Auth 强制校验。

## 方案选型

### 方案 A：仅做“本地管理面板”（零后端改动）

- 思路：只管理“用户自己保存过的 manageUrl”（localStorage / 文件导入）。
- 能力：列表、跳转编辑页、删除、延期（需重新上传内容）都能做。
- 缺点：无法枚举全站 paste；不是真正的管理员面板。

### 方案 B（推荐）：管理员面板 + 受保护的列表 API

后端新增：

1. 管理面板页面：`GET /admin`（或 `/admin.html`）
2. 列表 API：`GET /admin/api/pastes`

前端新增：

- 一个独立入口页（类似现有 `index.html` / `display.html`），渲染 AdminPanel。

管理员在列表页点击“Edit”时，直接跳转 `/<name>:<passwd>`，复用既有编辑 UI 与上传逻辑。

## 具体落地拆解（方案 B）

### 1) 后端：新增 admin 列表 API

建议新增 endpoint：

- `GET /admin/api/pastes?cursor=<cursor>&limit=<1..1000>&prefix=<prefix>`
  - 认证：必须通过 Basic Auth；当 `ADMIN_BASIC_AUTH` 为空时直接返回 404（隐藏管理面板/管理 API）
  - 分页：基于 KV list 的 cursor；`limit` 默认 50（前端目前用 100），上限 1000
  - 返回：分页结果（cursor pagination）

建议返回结构（示例）：

```json
{
  "cursor": "...",
  "listComplete": false,
  "items": [
    {
      "name": "abcd",
      "manageUrl": "https://example.com/abcd:xxxxx",
      "createdAt": "...",
      "lastModifiedAt": "...",
      "expireAt": "...",
      "sizeBytes": 123,
      "location": "KV",
      "filename": "a.txt",
      "highlightLanguage": "js",
      "encryptionScheme": "AES-GCM",
      "accessCounter": 42
    }
  ]
}
```

实现要点（当前实现）：

- 入口：`worker/handlers/handleAdmin.ts`（由 `worker/handlers/handleRead.ts` 分发）
- `manageUrl` 由 `env.DEPLOY_URL + "/" + name + ":" + passwd` 拼出（仅管理员可见）
- 当前实现为保证元数据形态一致：对 `env.PB.list()` 返回的每个 key 再调用一次 `getPasteMetadata()`，避免直接使用 list 返回的 metadata（版本迁移/缺字段差异）
- 返回结构类型已放在 `shared/interfaces.ts`：`AdminPasteListResponse` / `AdminPasteListItem`

### 2) 后端：新增 admin 页面路由

当前 worker 的静态页策略：

- `index.html` / `/assets/*` 等通过 `env.ASSETS.fetch()` 返回。
- `display.html` 被 `/d/<name>` 逻辑间接使用。
- `/<name>:<passwd>` 会被映射到 `index.html`。

因此管理员面板最自然的方式是增加第三个 HTML 入口（例如 `admin.html`），并在 `worker/handlers/handleRead.ts` 的静态页逻辑里：

- 当 path 为 `/admin` 或 `/admin/` 或 `/admin.html` 时，返回 `admin.html`。
- 对该页面强制 Basic Auth。

### 3) 前端：新增 admin.html + AdminPanel 页面

前端目前是多入口构建：`frontend/vite.config.js` 的 `build.rollupOptions.input` 有 `index` 与 `display`。

新增管理面板建议：

- 增加 `admin.html` 与对应渲染入口（比如 `frontend/pages/render/admin.tsx`）。
- 新增页面组件 `frontend/pages/AdminPanel.tsx`。

AdminPanel 的最小可用交互：

- 列表：调用 `GET /admin/api/pastes`，支持分页（cursor）、搜索（prefix/客户端过滤）。
- 展示字段：name、filename、size、location、expireAt、lastModifiedAt、highlightLanguage、encryptionScheme、accessCounter。
- 操作：
  - View raw：打开 `/<name>`
  - View display：打开 `/d/<name>`
  - Edit：打开 `/<name>:<passwd>`（复用现有编辑页）
  - Delete：直接对 `/<name>:<passwd>` 发 `DELETE`（或先跳转到编辑页点 Delete）

### 4) “expiration / edit / delete / snippet/file” 在面板里怎么做

基于现有能力，最省事的做法是：

- edit：跳转 `/<name>:<passwd>`（现有 `PasteBin` 会自动进入 manage 模式，并拉取原内容）
- delete：
  - 直接在列表页调用 `fetch(manageUrl, { method: "DELETE" })`（同 `frontend/pages/PasteBin.tsx` 逻辑）
  - 或跳转编辑页让管理员点 Delete
- expiration：
  - 现有协议下要修改过期时间必须 `PUT` 且带 `c`（即重新上传内容）。
  - 所以“延期/改 expire”最简单也是跳转编辑页，在 Settings 里填 `Expiration` 然后 Update。
  - 若要在列表页“一键延期”，需要先 `GET /<name>` 拉取内容再 `PUT manageUrl` 回写（对大文件/大 R2 成本高）。
- snippet/file：
  - 现有编辑页通过 `Content-Type` 是否 `text/*` 或是否存在 `X-PB-Highlight-Language` 来判断。
  - 管理面板列表页可用 metadata 的 `filename` / `highlightLanguage` / `encryptionScheme` 粗略判断；需要精确判断时可 `HEAD /<name>`。

## 可选增强：避免“改过期时间必须重传内容”

如果管理员面板需要高频“只改 expire / 只改 password / 只改 metadata”，目前 API 设计会迫使前端重传内容（尤其对 R2 大对象很不友好）。

已实现一个仅管理员可用的接口（仍需强制认证）：

- `PATCH /admin/api/paste/<name>/metadata`
  - body: `{ "expire": "7d", "passwd": "..." }`（字段均可选，但至少提供一个）
  - 行为：不重传 paste 内容；只更新 KV metadata 与 KV TTL
  - 对 R2：不会修改 R2 对象本体，只调整 KV 中的 metadata/expiration（依旧保留 R2 清理所需的延迟窗口）

这能显著降低管理动作的带宽与时延成本。

## 实施步骤（建议顺序）

1. 明确安全策略：只有配置 `BASIC_AUTH` 时启用管理面板与 admin API（否则 404）。
2. 后端新增 `GET /admin/api/pastes`（分页 + 强制认证）。
3. 前端新增 `admin.html` 入口与 `AdminPanel` 页面，完成列表与跳转编辑的最小闭环。
4. 在列表页加 Delete 操作（直接调用 `DELETE manageUrl`）。
5. 评估是否需要“metadata patch”增强以支持一键延期/改密码。

## 相关文件索引

- API 文档：`doc/api.md`
- 读请求与静态页路由：`worker/handlers/handleRead.ts`
- 写/更新：`worker/handlers/handleWrite.ts`
- 删除：`worker/handlers/handleDelete.ts`
- 存储与 KV metadata：`worker/storage/storage.ts`
- Basic Auth：`worker/pages/auth.ts`
- 现有编辑页逻辑：`frontend/pages/PasteBin.tsx`
- 上传实现（PUT/POST）：`frontend/utils/uploader.ts`、`shared/uploadPaste.ts`

## 当前实现落点（MVP）

- Admin 页面：`GET /admin` 或 `GET /admin/` 或 `GET /admin.html`（返回 `dist/frontend/admin.html`）
- Admin API：`GET /admin/api/pastes`
- Worker 代码：`worker/pages/auth.ts`、`worker/handlers/handleAdmin.ts`、`worker/handlers/handleRead.ts`
- 前端入口：`frontend/admin.html`、`frontend/pages/render/admin.tsx`、`frontend/pages/AdminPanel.tsx`
