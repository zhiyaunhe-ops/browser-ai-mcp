# 浏览器操作与验收

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

## Browser MCP 工具

| 任务 | 工具 |
|---|---|
| 开始任务，保存目标与验收字段 | `run_begin` |
| 执行操作或独立读取，查询异步结果 | `browser_run`、`run_get` |
| 在当前工作台任务中打开节点、按条件查询企业级 PC 模板 | `asp_workbench_open_node`、`asp_workbench_query_templates` |
| 在通用申请单列表按完整单号查询 | `asp_workbench_query_general_applications` |
| 定位和修改单个模板字段 | `asp_ui_template_update_field` |
| 在原运行中逐项验收批量保存结果 | `asp_ui_template_verify_batch` |
| 用后续观察核对结果并结束任务 | `run_finish` |
| 召回流程，读取操作记录和版本 | `memory_search`、`memory_get` |
| 查询已保存的执行证据，起草可复用流程 | `evidence_query`、`recipe_draft` |
| 评估模型读取待办、核对证据并保存评估 | `eval_pending`、`eval_packet`、`eval_submit` |
| 读取某次运行的评估进度、结论和总结 | `run_summary` |
| 对照原始会话，追踪同一问题的历史和后续实测 | `eval_session_context`、`review_history`、`review_observe` |

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
- 如果返回 `field_not_found`，先看 `candidates` 中的字段编码、实体、表头或明细位置和可用的持久 ID。选定候选后用新的 `requestId` 重新调用。没有精确候选时，`searchedEntities` 列出已搜索的实体、字段数和名称样本。
- 例如，选择差旅费报销单可以传 `"documentName": "差旅费报销单", "templateName": "Travel Claim (ASP)"`；个人借款单可以传 `"documentName": "个人借款单", "templateName": "Personal Loan Slip (ASP)"`。首次使用某列时，可用 `changes: {}` 查看属性。
- 同一单据有多个 PC 页面类型时，`pageType` 可指定工作台上的实际标签，例如“还款单列表”。只有已配置租户模板、且使用同一单据设计器字段模型的页面才能继续修改。
- 查看培训报销模板的明细金额列时，沿用示例中的模板名，将 `field` 改为 `nexpensemny`，并传 `fieldScope: "detail"`、`detailEntity: "znbzbx_expensebill_b"` 和 `changes: {}`。
- `changes` 支持 `required`（必填）、`visible`（显示）、`editable`（允许修改）、`caption`（标题）。给定模板和字段后，传 `changes: {}` 可查看该字段实际开放的属性、编码、控件类型、当前值和禁用状态。
- 用 `changes.properties` 按编码或面板上的精确属性名修改。例如报销说明可以传 `{"无数据时提示文本": "请填写报销事由", "输入长度": 200}`。默认值、布局占比和其他属性同样按字段元数据处理；有下拉选项时使用选项的 `value`。回读结果以属性编码为键。
- 金额字段还可能提供精度、最大值、最小值和千分位；日期字段的“默认值”可能是默认值类型选项。先读目标字段的属性，可获取该模板采用的实际编码和值类型。
- 枚举和参照编码通过设计器对应动作设置。参照字段是否允许修改编码以设计器判断为准，属性清单中的 `disabled` 会反映该限制。
- `changes.formula` 接收用友公式表达式、`{"expression": "...", "display": "..."}` 或 `null`。设计器负责解析表达式和生成触发字段及函数清单。传 `null` 清空计算公式。
- 同时提供 `templateId` 和工作台打开的 `designerUrl` 可全程走无点击路径。设计器 URL 内的 `PT…` 编码与工作台模板 ID 是两个不同的标识。通过模板名称或 ID 搜索时，仍由工作台打开设计器。
- 保存及独立回读按单据、模板、实体、字段编码和持久字段 ID 核对。部分扩展字段只在父节点记录模板 ID。写入前核对已选节点；重开后若节点 ID 已更新且字段没有持久 ID，在同一模板和实体中按精确字段编码唯一定位。显式指定的节点仍按指定 ID 核对。设计器负责构造保存 POST。请求中的单据编码和模板 ID 均与目标一致且收到对应响应时，`savePost` 返回请求方法、路径、模板 ID 和 HTTP 状态。当前值已符合要求时跳过保存。
- 只传 `required` 且省略 `designerUrl` 时，`before` 和 `after` 仍是布尔值。其他模式按属性编码返回值。

### 批量保存后的字段验收

在 `run_begin` 中，ASP 费控配置沿用 `domain_tag: "超级版和旗舰版"`。已确定目标时，把完整清单登记为验收条件，例如 `{id:"coverage", path:"verifiedTargets", equals:targets}`。保存完成后，在原运行中调用 `asp_ui_template_verify_batch`，按原顺序传入相同的 `targets`。漏掉模板、替换字段或改变期望值都会报清单冲突。历史运行只有 `allSelectedFieldsMatch == true` 条件时，结论覆盖本次传入的清单。每个目标填写实际定位的模板 ID、设计器地址、字段和预期属性。有持久字段 ID 时一并传入。

```json
{
  "runId": "<原批量运行 ID>",
  "requestId": "verify-expense-fields-1",
  "targets": [
    {
      "templateId": "<培训模板 ID>",
      "designerUrl": "<培训模板设计器地址>",
      "field": "pk_receptionarchive_matter_name",
      "fieldScope": "detail",
      "detailEntity": "znbzbx_expensebill_b",
      "expected": {"bShowIt": true}
    },
    {
      "templateId": "<加班餐模板 ID>",
      "designerUrl": "<加班餐模板设计器地址>",
      "field": "expensebillDcs__ASP_VENUE",
      "fieldScope": "header",
      "expected": {"bShowIt": false}
    }
  ]
}
```

工具逐字段重新打开设计器。结果的 `rows` 包含目标身份、预期值、实读值、状态和可用的观察编号。全部字段匹配后，把返回的 `verification` 交给 `run_finish`。出现值不符或读取失败时，按对应行检查。原请求重试沿用 `requestId`；发生后续写入或更改验收清单后，用新 `requestId` 重新读取。

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

## Related documents

- [AI 操作入口](../SKILL.md)
- [评估与改进流程](browser-eval.md)
