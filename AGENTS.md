# 项目功能

- Pastebin 服务，部署在 Cloudflare Workers 上
- Web UI：支持发布/更新/删除文本（以及读取展示）
- HTTP API：可通过 `curl` 等工具调用（详见 `doc/api.md`）
- 永久粘贴：过期时间可设置为 `never`
- 语法高亮：基于 highlight.js
- Markdown 渲染：将 Markdown 作为 HTML 展示
- 客户端加密：在浏览器侧加密内容
- 短链接/自定义路径：最短 4 字符，也支持自定义 URL
- 返回内容类型可配置：可自定义 `Content-Type`
- 认证：可选 Basic Auth（用于私有部署，只允许管理员写入）
- 管理面板：可选 Admin Panel（`/admin`，需配置 `ADMIN_BASIC_AUTH` 才启用）
- 存储分层：小文件 KV（`PB`），大文件 R2（`R2`，带阈值/最大限制）
- 定时维护：Cron 每日清理 R2 垃圾

# 现有工具链

- 运行时/平台：Cloudflare Workers
- Worker 构建与部署：Wrangler（`wrangler.toml`）
- 语言：TypeScript（ESM）
- 前端：React + Vite
- 样式：Tailwind CSS
- 测试：Vitest（含覆盖率）
- 代码质量：ESLint + Prettier
- 包管理器：pnpm（`pnpm-lock.yaml`、`pnpm-workspace.yaml`）
- CLI 辅助脚本：`scripts/pb`（依赖 `bash`/`jq`/`getopt`/`curl`）

# 常用命令（pnpm）

```bash
pnpm install
pnpm build:frontend
pnpm build:frontend:dev
pnpm dev:frontend
pnpm dev
pnpm deploy
pnpm test
pnpm coverage
pnpm lint
pnpm fmt
pnpm gen:admin-auth
```

# 文档索引

- API：`doc/api.md`
- 管理面板方案/实现说明：`dev-docs/admin-panel.md`
