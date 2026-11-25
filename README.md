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

## Browser 与 Toolkit 的 MCP 工具

| 任务 | 工具 |
|---|---|
| 开始任务，保存目标与验收字段 | `run_begin` |
| 执行操作或独立读取，查询异步结果 | `browser_run`、`run_get` |
| 在当前工作台任务中打开节点、按条件查询企业级 PC 模板 | `asp_workbench_open_node`、`asp_workbench_query_templates` |
| 在通用申请单列表按完整单号查询 | `asp_workbench_query_general_applications` |
| 用后续观察核对结果并结束任务 | `run_finish` |
| 召回流程，读取操作记录和版本 | `memory_search`、`memory_get` |
| 查询已保存的执行证据，起草可复用流程 | `evidence_query`、`recipe_draft` |
| 评估模型读取待办、核对证据并保存评估 | `task_eval_pending`、`task_eval_packet`、`task_eval_submit` |
| 读取某次运行的评估进度、结论和总结 | `task_run_summary` |
| 按问题或尝试查看 Toolkit 统一历史与后续观测 | `task_review_history` |

### 执行模型和评估模型交接

执行模型负责操作页面和回读业务字段。`run_finish` 接受运行结果和验收引用，日常交接可以省略 `decision` 和 `note`。成功运行仍需提供最后一次执行之后的观察。MCP 自动将已交接的任务列为 `pending`，保存证据并完成原有的页面清理。

外部调度方选择评估模型，让它使用 YonClaw Toolkit 的评估入口。安装或升级时同步更新 Browser 和 Toolkit，两端使用同一份 Browser 数据。Toolkit 通过 Browser 提供的适配器读取本机原始证据、保存判定，并将评估、改进任务与后续实测关联起来。评估模型按以下步骤完成交接。

1. 调用 `task_eval_pending` 获取待评估的 `runId`，也可直接使用执行方交来的 `runId`。
2. 调用 `task_eval_packet({runId})` 读取目标、验收条件、操作轮次、回读结果和采集缺口。`readbacks` 单独列出验收字段的实际值及观察是否晚于最后一次执行。翻页检查 `rounds` 时传回首页的 `reviewKey` 和上一页的 `nextCursor`，需要请求细节时用 `task_evidence_query`。
3. 调用 `task_eval_submit`，逐条说明验收条件是否满足，并撰写结论、可复用经验和局限。引用证据包中的 `observationId` 或 `task_evidence_query` 返回的 `recordId`。判定条件满足时须引用操作后的回读。证据不足时用 `insufficient_evidence`。下面的示例以单号查询为目标，尖括号中的值取自实际运行。

```json
{
  "runId": "<runId>",
  "requestId": "review-1",
  "reviewKey": "<reviewKey>",
  "reviewerModel": "<承担评估的模型标识>",
  "verdict": "pass",
  "criterionResults": [{
    "criterionId": "complete",
    "verdict": "met",
    "reason": "独立回读显示查询完整，候选数和实际匹配数都是 0。",
    "evidenceIds": ["<observationId>"]
  }],
  "evidenceIds": [],
  "summary": {
    "result": "已核实该单号没有匹配记录。",
    "lessons": ["将计数请求与返回行一起核对。"],
    "limitations": ["此次查询只覆盖通用申请单。"]
  }
}
```

在 `run_begin` 的 `reviewMemory` 字段传入以下结构，可以预登记跨轮复验计划。

```json
{
  "problem_id": "asp-pc-template-enable",
  "context": "ASP 费控企业级 PC 租户模板启用",
  "rationale": "启用请求异步完成，需要按实际模板核对结果。",
  "prediction": "下一次同类操作能通过独立列表查询完成验收。",
  "metric": "缺少目标模板独立回读的运行数 / 同类运行总数",
  "evidence": "本轮和后续同类运行的 observationId"
}
```

后续同类尝试沿用这个 `problem_id`。旧评估可用其 `reviewId` 作为 `attempt_id` 查询，例如 `task_review_history({source:"browser",attempt_id:"<reviewId>"})`。需要对比改进效果时，用 Toolkit 的 `task_review_observe` 追加后续实测，原始请求和观察详情仍可凭 `runId`、`executionId` 在 Browser MCP 查询。

`task_run_summary({runId})` 返回执行方的 `executionOutcome`、评估进度 `reviewState` 以及评估报告 `review`。进度依次为 `not_ready`、`pending`、`reviewed`。同一提交重试沿用 `requestId`。结果未知的任务继续执行后，需要新一次交接；提交旧证据包会收到 `EVAL_STALE`。历史运行已有 `run_finish` 交接记录的也可进入评估。

用友基础配置按产品版本复用。ASP 项目费控模块使用同一个标签 `domain_tag: "超级版和旗舰版"`，涵盖报销模板、字段属性、公式和相关查询。执行端在 `run_begin` 指定版本或通过已识别的 ASP 费控任务自动归类。`memory_search` 和新任务的 `recalledMemory` 可按相同版本找回适用的流程和评估经验。切换环境后，当前租户的模板 ID、权限和字段状态以新运行的读取结果为准。

评估发现需要改动时，使用 Toolkit 的 `task_review_improve` 指定来源评估、改动对象、改法和验收条件。工具返回可跟进的任务编号。改动类型可选业务配置、工具实现或操作流程；`task_review_observe` 记录后续运行实际测到的效果。

### 记录请求与复用

每个浏览器执行轮次自动收集所操作页面的 XHR 和 Fetch 请求。用 `run_get` 查看本轮的 `networkCapture`。用 `evidence_query` 传入同一个 `runId`、`executionId` 和 `view: "api"` 可看方法、路径、查询参数名、请求体结构及响应状态。草稿的 `requestEvidence` 带回请求样本和证据 ID。样本超过 30 条时，用原任务的 `evidence_query` 翻页读取其余记录。下次任务命中这条流程记忆或页面提醒时，可以用返回的 `sourceRunId` 查回当时的请求。

工作流优先复用业务含义和参数已核实的请求，并保留可定位到同一目标的页面操作。只读请求失败可切换页面路径。写入超时或响应丢失时，先重新打开目标并核对业务值，避免再按一次保存。抓到 HTTP 200 后仍需核对返回数据或持久化后的业务字段。

同一轮脚本主动调用 `page.events()` 仍能读取原始事件。轮次结束时 MCP 读取剩余缓冲，跨轮查询请使用 `evidence_query`。采集范围限本轮使用的页面，响应可能在轮次结束后才到达；缺失的响应、请求体或超限记录会体现在采集结果里。

例如要在 ASP UAT 查询 Training / Meeting Reimbursement，先用 `run_begin` 在已登录的工作台创建任务，再用下面的参数调用 `asp_workbench_query_templates`。

```json
{
  "runId": "<run_begin 返回的 runId>",
  "requestId": "find-training-template",
  "documentName": "通用报销单",
  "templateName": "Training / Meeting Reimbursement"
}
```

要先打开某个服务，可在同一任务调用 `asp_workbench_open_node` 并传入工作台上显示的精确 `nodeName`。用返回的 `executionId` 查询 `run_get`，后续操作沿用同一个任务。

按完整单号查通用申请单时，给 `asp_workbench_query_general_applications` 传入 `runId`、`requestId` 和 `billCode`。它按返回行的实际单号核对匹配，结果会说明查询路径和完整性。

ASP 超级版 UAT 的 `asp_ui_template_update_field` 使用当前已登录的 All Seasons Property 工作台，读取或修改 PC 单据设计器的表头字段和明细列。通过工作台查找企业账号级模板时，`documentName` 指定业务树中的单据，模板和字段均可按名称或标识定位，同名模板可用 `transactionType` 区分。省略单据和字段位置时沿用通用报销单表头。重试同一操作时沿用原 `requestId`。

```json
{
  "requestId": "training-meeting-reason-required-1",
  "templateName": "Training / Meeting Reimbursement",
  "field": "报销说明",
  "changes": { "required": true }
}
```

- 配置其他单据时提供实际的 `documentName` 和模板名。同名单据可用候选里的完整 `documentPath` 确认。选择明细列时传 `fieldScope: "detail"`。多个明细表存在同名列时，通过候选返回的 `entityCode` 填写 `detailEntity`；同一实体仍有多个字段节点时，优先用候选的 `fieldId` 指定持久字段 ID。
- 例如，选择差旅费报销单可以传 `"documentName": "差旅费报销单", "templateName": "Travel Claim (ASP)"`；个人借款单可以传 `"documentName": "个人借款单", "templateName": "Personal Loan Slip (ASP)"`。首次使用某列时，可用 `changes: {}` 查看属性。
- 同一单据有多个 PC 页面类型时，`pageType` 可指定工作台上的实际标签，例如“还款单列表”。只有已配置租户模板、且使用同一单据设计器字段模型的页面才能继续修改。
- 查看培训报销模板的明细金额列时，沿用示例中的模板名，将 `field` 改为 `nexpensemny`，并传 `fieldScope: "detail"`、`detailEntity: "znbzbx_expensebill_b"` 和 `changes: {}`。
- `changes` 支持 `required`（必填）、`visible`（显示）、`editable`（允许修改）、`caption`（标题）。给定模板和字段后，传 `changes: {}` 可查看该字段实际开放的属性、编码、控件类型、当前值和禁用状态。
- 用 `changes.properties` 按编码或面板上的精确属性名修改。例如报销说明可以传 `{"无数据时提示文本": "请填写报销事由", "输入长度": 200}`。默认值、布局占比和其他属性同样按字段元数据处理；有下拉选项时使用选项的 `value`。回读结果以属性编码为键。
- 金额字段还可能提供精度、最大值、最小值和千分位；日期字段的“默认值”可能是默认值类型选项。先读目标字段的属性，可获取该模板采用的实际编码和值类型。
- 枚举和参照编码通过设计器对应动作设置。参照字段是否允许修改编码以设计器判断为准，属性清单中的 `disabled` 会反映该限制。
- `changes.formula` 接收用友公式表达式、`{"expression": "...", "display": "..."}` 或 `null`。设计器负责解析表达式和生成触发字段及函数清单。传 `null` 清空计算公式。
- 同时提供 `templateId` 和工作台打开的 `designerUrl` 可全程走无点击路径。设计器 URL 内的 `PT…` 编码与工作台模板 ID 是两个不同的标识。通过模板名称或 ID 搜索时，仍由工作台打开设计器。
- 保存及独立回读按单据编码、模板 ID、表头或明细实体、字段编码和持久字段 ID 核对；缺少持久 ID 时核对节点 ID。设计器负责构造保存 POST。请求中的单据编码和模板 ID 均与目标一致且收到对应响应时，`savePost` 返回请求方法、路径、模板 ID 和 HTTP 状态。当前值已符合要求时跳过保存。
- 只传 `required` 且省略 `designerUrl` 时，`before` 和 `after` 仍是布尔值。其他模式按属性编码返回值。

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
