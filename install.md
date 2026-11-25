# 安装 browser-ai

在运行 ego lite 的同一台电脑上安装 browser-ai，让支持 stdio 的 MCP 客户端启动它。完成后，客户端可以调用工具读取真实网页，并将执行记录保存在本机。

## 准备桌面环境

1. 安装带 npm 的 Node.js，可选当前 LTS。服务使用内置 SQLite，支持 Node 22.x 的 22.13.0 及以后版本，以及从 23.4.0 起的更高版本。[Node.js 下载](https://nodejs.org/en/download) · [SQLite 版本说明](https://nodejs.org/api/sqlite.html)
2. 在 Windows 或 macOS 安装并打开 ego lite，完成首次设置以注册 `ego-browser` 命令。Linux 桌面支持仍在上游路线图中。[ego lite 下载](https://lite.ego.app/) · [支持平台](https://github.com/citrolabs/ego-lite#quick-start)
3. 打开新的终端，运行下面的命令。`nodejs` 那一行应输出 `ego-browser ready`，最后一行会显示本机 ego 版本的操作指南。

```sh
node --version
npm --version
ego-browser nodejs -e "console.log('ego-browser ready')"
ego-browser skill
```

## 安装服务

从公开仓库克隆当前版本。

```sh
git clone https://github.com/zhiyaunhe-ops/browser-ai-mcp.git
cd browser-ai-mcp
```

也可以在仓库选择 **Code → Download ZIP** 并解压。已有源代码时，直接在含 `package.json` 和 `package-lock.json` 的目录打开终端。

```sh
npm ci
node src/mcp.js --help
```

`npm ci` 会按锁文件安装 MCP SDK、Acorn、Zod 及其依赖。看到 `Transport: MCP stdio` 后，继续配置客户端。

本机 Eval 需要 Python 3.11+。MCP 自带 YonClaw Toolkit 的评估模块；安装此仓库后，其他 AI 可以用同一个本机数据目录读取交接、提交评估并追踪后续实测。已有独立 Toolkit 的用户可用 `BROWSER_AI_REVIEW_TOOLKIT` 指定外部 `runtime/review.py`，用 `BROWSER_AI_REVIEW_PYTHON` 指定解释器。

评估 AI 可从 `eval_packet.sessionSearch` 取得当前机器的候选日志目录；详见[在本机找回对应会话](README.md#在本机找回对应会话)。

升级时用新版 Browser MCP 打开一次原数据目录。它为已有评估提供 `browser_review_attempts_v1` 和 `browser_review_evidence_v1` 两个只读日志视图，供 Toolkit 读取原评估、验收条件和证据引用。

## 生成本机的 MCP 配置

保持终端在同一目录。先按系统找到 ego 可执行文件。

**Windows PowerShell**

```powershell
$egoBin = (Get-Command ego-browser.exe -CommandType Application -ErrorAction Stop).Source
```

**macOS 终端**

```sh
egoBin="$(command -v ego-browser)"
```

接下来，两种系统都运行下面这段命令。它会输出可复制的 JSON，其中包含本机 Node、服务入口和 ego 的绝对路径。

```sh
node -e "
const server = {
  command: process.execPath,
  args: [require.resolve('./src/mcp.js')],
  env: { BROWSER_AI_EGO_BIN: process.argv[1] }
}
console.log(JSON.stringify({ mcpServers: { 'browser-ai': server } }, null, 2))
" "$egoBin"
```

在客户端的 MCP 设置中添加名为 `browser-ai` 的 **stdio** 服务。使用 JSON 的客户端将输出中的 `browser-ai` 条目合并到已有的 `mcpServers` 下，使用表单或其他配置格式的客户端分别填入 `command`、`args` 和 `env`。

保存后，重启客户端管理的 MCP 服务，让客户端持有 Node 进程。使用默认数据目录即可，通常无需另外配置启动目录。

## 确认安装成功

在客户端的工具列表中找到 `run_begin`、`browser_run`、`run_get` 和 `run_finish`。再把下面这句话交给已连接的 Agent，确认它能通过桌面浏览器完成一次读取。

> 用 browser-ai 打开 https://example.com/，读取网页标题，核对标题是否为 Example Domain，然后结束任务。告诉我实际读到的标题和 runId。

结果应含网页标题 `Example Domain` 和这次的 `runId`。若 Agent 支持加载技能，可以把本仓库中含 `SKILL.md` 的目录注册为 `browser-ai`，供它按需阅读操作指南。

## 常见安装问题

| 现象 | 处理 |
|---|---|
| 找不到 `node:sqlite` | 用 `node --version` 确认终端的 Node 版本。升级后重新生成客户端配置，让它使用同一版本。 |
| 报错找不到 `@modelcontextprotocol/sdk`、`acorn` 或 `zod` | 在服务入口所属仓库的根目录执行 `npm ci`，等待命令正常退出。 |
| 工具已列出，首次调用浏览器却报 `ENOENT` | 在完成 ego lite 首次设置后新开的终端中找到可执行文件，重新生成配置。Windows 的 `BROWSER_AI_EGO_BIN` 应指向原生 `.exe`。 |
| 终端手动启动 `node src/mcp.js` 后一直等待 | 该进程正在等待标准输入中的 MCP 请求。用 Ctrl+C 退出，再让客户端按配置启动服务。 |
| 安装目录移动后客户端连不上 | 在新目录运行 `npm ci` 并重新生成 MCP 配置，再重启服务。 |

## 数据与更新

服务按 `--data-dir` 参数、`BROWSER_AI_DATA_DIR` 环境变量、用户主目录下的 `.browser-ai` 依次选择数据目录。该目录包含 `browser-ai.sqlite` 和 `executions/` 下的执行记录。

若需自定位置，在客户端的 `args` 数组末尾依次添加 `"--data-dir"` 和数据目录的绝对路径。更新服务时继续使用原数据目录，即可保留任务和流程记忆。

Git 安装可在仓库根目录执行 `git pull --ff-only` 和 `npm ci`。ZIP 安装则解压新版本并在新目录执行 `npm ci`，重新生成配置后重启客户端管理的服务。

ego lite 随桌面应用独立更新，更新后用 `ego-browser skill` 阅读当前指南。分析 DSH 历史压缩日志是可选功能，仅在读取 `.zstd` 文件时需要带 `zstdDecompressSync` 的 Node（22.x 从 22.15 起，或 23.8 及以上）。[Node.js Zstd 说明](https://nodejs.org/api/zlib.html#zlibzstddecompresssyncbuffer-options)

## Related documents

- [功能概览与使用入口](README.md)
