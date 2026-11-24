# browser-ai-mcp

用 MCP 和 ego lite 操作网页，保存每一轮执行结果，并在操作后核对业务字段。用友页面可按字段、所在行和弹窗读取，还可以一次勾选多条记录并移入穿梭框右栏。

## 安装

在运行 ego lite 的电脑上安装 Node.js 和 npm，然后在终端执行以下命令。Node.js 22.x 需 22.13.0 或以上，23.x 需 23.4.0 或以上，后续主版本也可用。

```sh
git clone https://github.com/zhiyaunhe-ops/browser-ai-mcp.git
cd browser-ai-mcp
npm ci
```

配置 MCP 客户端通过 stdio 启动 `node <仓库绝对路径>/src/mcp.js`。Windows 和 macOS 的 ego 安装、配置生成命令和首次读取示例见[安装指南](install.md)。

## 读取用友页面

| 场景 | 做法 |
|---|---|
| 找不到业务节点 | 先读父页面。检查 `ys.find()` 返回的 `entryPoints`，或用 `ys.entries({framePath,scope})` 找对照表按钮、行内链接和展开控件。 |
| 多行都有同名入口 | 用 `ys.click(name,{rowText,framePath})` 指定该行一个单元格的完整值，再读新页面、弹窗或标签页的标题与业务字段。 |
| 操作栏只在鼠标移入行后出现 | 用 `ys.entries({rowText,framePath,reveal:true})` 揭示入口。已渲染的行若被固定表头挡住，助手会滚动居中，再按同一单元格重新定位。 |
| 找到正确行却只有「删除」 | 查看 `modeActions` 中实际可见的「修改」。需要进入编辑态时，先点页顶「修改」，再读同一行的「对照表」。 |
| 选择多条后统一右移 | 用 `ys.transferState({scope,framePath})` 看左右明细和勾选状态，再用 `ys.transferRight(names,{scope,framePath})` 移动这一批。它核对右侧原有和新增条目。 |
| 可见信息不足 | Agent 先读用友语义层，再按需要使用 ego 原生语义快照 `page.snapshot()`，最后才取视觉截图 `page.screenshot()`。 |

第一次没找到时，Agent 会根据页面上可见的线索继续尝试。它可以等候加载、滚动表格、选中或悬停目标行、展开「更多」或进入编辑态。每一步重新读取目标记录，右移后先核对两侧明细再决定下一步。

`scope` 是现场观察到的 CSS 选择器。`framePath` 是适配器返回的同源框架路径。适配器读取当前渲染的普通 DOM，跨域框架、Shadow DOM 或虚拟列表可能需要进一步观察。穿梭框右栏变更后，业务单据仍需按任务要求确认、保存并复查。

## MCP 工具

| 任务 | 工具 |
|---|---|
| 开始任务，保存目标与验收字段 | `run_begin` |
| 执行操作或独立读取，查询异步结果 | `browser_run`、`run_get` |
| 用后续观察核对结果并结束任务 | `run_finish` |
| 召回流程，读取操作记录和版本 | `memory_search`、`memory_get` |
| 查询已保存的执行证据，起草可复用流程 | `evidence_query`、`recipe_draft` |

ASP 超级版 UAT 的 `asp_ui_template_update_field` 使用当前已登录的 All Seasons Property 工作台，修改 PC 通用报销单的表头字段。按模板名称或 ID 和字段名称或编码定位。通过工作台查找时可用 `transactionType` 区分交易类型。重试同一操作时沿用原 `requestId`。

```json
{
  "requestId": "training-meeting-reason-required-1",
  "templateName": "Training / Meeting Reimbursement",
  "field": "报销说明",
  "changes": { "required": true }
}
```

- `changes` 支持 `required`（必填）、`visible`（显示）、`editable`（允许修改）、`caption`（标题）。其他普通属性通过 `changes.properties` 按属性编码配置，例如 `{"iColWidth": 2, "UI#placeholder": "请输入报销说明", "cDefaultValue": "培训"}`。传 `changes: {}` 可读取该字段的属性编码、当前值及控件禁用状态。可编辑范围由具体字段和设计器决定。
- `changes.formula` 接收用友公式表达式、`{"expression": "...", "display": "..."}` 或 `null`。设计器负责解析表达式和生成触发字段及函数清单。传 `null` 清空计算公式。
- 同时提供 `templateId` 和工作台打开的 `designerUrl` 可全程走无点击路径。设计器 URL 内的 `PT…` 编码与工作台模板 ID 是两个不同的标识。通过模板名称或 ID 搜索时，仍由工作台打开设计器。
- 扩展属性使用设计器内置动作设置，调用设计器原生保存动作，再打开新页面独立回读。只传 `required` 且省略 `designerUrl` 时沿用原流程和布尔返回值。新流程以属性编码为键返回修改前后值和回读观察记录 ID。当前值已符合要求时跳过保存。

## 页面提醒

每轮 `browser_run` 成功后，MCP 按本轮操作的页面匹配已保存的提醒。例如费用导入和导入结果共用一个网址时，可以分别按弹窗标题保存两条提醒。命中的摘要随执行结果的 `pageMemos` 返回，异步执行可从 `run_get` 读取同一结果。打开弹窗后结束这一轮，下一轮准备文件或提交时就能用到提醒。

通过 `run_finish` 的 `updates` 保存规则。下面是一条示例，路径、标题和要求应替换成现场确认的内容。

```json
{
  "baseRevision": 0,
  "entry": {
    "scope": "page",
    "key": "expense-import-template",
    "name": "费用导入模板",
    "summary": "准备文件时，将费用项目编码列保留为文本，以保留前导零。",
    "match": { "path": "/expenses", "dialogTitle": "费用导入" }
  }
}
```

匹配条件同时生效。弹窗标题按可见窗口的实际标题精确匹配；省略标题时可用路径或 hash 匹配独立页面。规则沿用记忆库的版本管理，标为 `stale` 后停止随页面返回。

## 开发验证

`npm test` 运行 Node 测试，`npm run check:docs` 检查文档链接。`npm run test:e2e` 通过本机 ego lite 和真实 MCP stdio 操作本地测试页面，运行前需完成 ego 桌面初始化。

## Related documents

- [安装与客户端配置](install.md)
- [Agent 操作指南和脚本示例](SKILL.md)
