# browser-ai-mcp

通过 MCP 和 ego lite 操作浏览器、回读业务结果并保存执行证据。可用于通用网页操作、用友页面和 YonBuilder 配置，也支持独立评估与改进复验。

## 快速上手

1. 安装 ego lite 和受支持的 Node.js 版本。
2. 克隆仓库，在仓库根目录运行 `npm ci`。
3. 在 MCP 客户端配置 `node <仓库绝对路径>/src/mcp.js`。平台配置和首次验证见[安装指南](install.md)。

## 开发

运行 `npm test`。安装 ego lite 后可运行 `npm run test:e2e`，文档链接可用 `npm run check:docs` 检查。

## Related documents

- [AI 操作入口](SKILL.md)
- [浏览器评估报告](reviews/browser/README.md)
- [浏览器 Eval · 2026-11-26](reviews/browser/2026-11-26.md)
