# 浏览器评估与改进

### 执行模型和评估模型交接

执行模型负责操作页面和回读业务字段。`run_finish` 接受运行结果和验收引用，日常交接可以省略 `decision` 和 `note`。成功运行仍需提供最后一次执行之后的观察。MCP 自动将已交接的任务列为 `pending`，保存证据并完成原有的页面清理。

评估 AI 连接同一台机器上的 Browser MCP，指向执行方使用的数据目录。MCP 内置 Toolkit 的评估规则和历史查询，执行方可以在 `run_begin` 传入 `sessionSource`，例如 `{"path":"/absolute/path/session.jsonl","sessionId":"session-1","startLine":42}`。

执行卡住时，在向用户求助或给最终答复前调用 `run_finish`，传 `outcome: "unknown"`，在 `note` 中写明阻塞、最后观察到的结果和剩余验收条件。对于漏交的运行，查询待办会将等待用户的运行或闲置 30 分钟的运行交接为结果未知；评估方应先核对会话和业务回读。

1. 调用 `eval_pending` 获取待评估的 `runId`，也可直接使用执行方交来的 `runId`。
2. 调用 `eval_packet({runId})` 读取目标、验收条件、操作轮次、回读结果和采集缺口。`readbacks` 单独列出验收字段的实际值及观察是否晚于最后一次执行。翻页检查 `rounds` 时传回首页的 `reviewKey` 和上一页的 `nextCursor`，需要请求细节时用 `evidence_query`。
3. 如果业务问题涉及用户原话、纠正或最终答复，从包里的 `sessionSource` 或已知日志路径调用 `eval_session_context({path,startLine,limit})`。按 `nextLine` 翻页，在提交的 `sessionRefs` 里写明 `path`、`sessionId`、`line` 和已知的 `commit`；缺失或截断处须说明证据缺口。
4. 调用 `eval_submit`，逐条说明验收条件是否满足，并撰写结论、可复用经验和局限。引用证据包中的 `observationId` 或 `evidence_query` 返回的 `recordId`。判定条件满足时须引用操作后的回读。证据不足时用 `insufficient_evidence`。下面的示例以单号查询为目标，尖括号中的值取自实际运行。

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

### 在本机找回对应会话

先读 `eval_packet.sessionSource.path`。路径缺失或已移动时，请主动在 `sessionSearch.roots` 返回的本机候选目录及子目录中查找；先搜 session ID，再按 run ID、任务原话和时间缩小范围。

| 客户端 | 常见目录 |
| --- | --- |
| Codex | `~/.codex/sessions/`、`~/.codex/archived_sessions/`，设置了 `CODEX_HOME` 时使用该目录下的同名子目录 |
| YonBuddy（Windows） | `%APPDATA%/yonyou-bridge/codex-home/sessions/` 和同级 `archived_sessions/`，也可由 `YONCLAW_YONBUDDY_HOME` 指定根目录 |
| Claude Code | `~/.claude/projects/<项目目录>/`，或 `CLAUDE_CONFIG_DIR` 下的 `projects/` |
| DSH | `~/.dsh/sessions/`，或 `DSH_SESSIONS_ROOT` 指定的目录 |

核对用户请求、纠正和最后答复后再引用文件及行号。普通 JSONL 可用 `eval_session_context`；DSH 压缩日志需用支持 zstd 的读取器。证据不足时，在评估中说明缺口。

评估完成后，建议将可复用的修复、回归用例或操作经验通过 PR 提交到获授权的仓库。PR 写明问题编号、改动理由、证据位置及验证结果，并将 PR 链接回传；原始会话日志留在本机。

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

后续同类尝试沿用这个 `problem_id`。旧评估可用其 `reviewId` 作为 `attempt_id` 查询，例如 `review_history({source:"browser",attempt_id:"<reviewId>"})`。需要对比改进效果时，用本机 `review_observe` 追加后续实测，原始请求和观察详情仍可凭 `runId`、`executionId` 在 Browser MCP 查询。

`run_summary({runId})` 返回执行方的 `executionOutcome`、评估进度 `reviewState` 以及评估报告 `review`。进度依次为 `not_ready`、`pending`、`reviewed`。同一提交重试沿用 `requestId`。结果未知的任务继续执行后，需要新一次交接；提交旧证据包会收到 `EVAL_STALE`。历史运行已有 `run_finish` 交接记录的也可进入评估。

用友基础配置按产品版本复用。ASP 项目费控模块使用同一个标签 `domain_tag: "超级版和旗舰版"`，涵盖报销模板、字段属性、公式和相关查询。执行端在 `run_begin` 指定版本或通过已识别的 ASP 费控任务自动归类。`memory_search` 和新任务的 `recalledMemory` 可按相同版本找回适用的流程和评估经验。切换环境后，当前租户的模板 ID、权限和字段状态以新运行的读取结果为准。

### 从评估到改进和复验

评估 AI 在 `eval_submit.improvements` 中写下可执行的问题、改法和可观察的验收条件，提交后会得到 `improvementIds`。也可以对已有评估调用 `review_improve`。换一个 AI 接手时，用 `review_improvements` 按原评估、问题或状态找回待做事项。

| 改动类型 | AI 实施的动作 | MCP 核对的产物 |
| --- | --- | --- |
| `code` | 在授权仓库修改实现，增加相应回归用例 | 本地 Git 提交实际变动的文件及 blob |
| `script` | 新增或修订可复用脚本并提交 | 脚本路径、提交和 blob |
| `memory` | 通过 `review_apply` 写入记忆条目或按已有 revision 修订 | 实际保存的 memory ID 和新 revision |
| `request` | 依据原运行捕获的请求构造参数化请求，保留业务回读，再提交实现 | 构造器文件、提交和同一运行中原生捕获的请求记录 |

例如，评估发现已有脚本把“保存请求返回成功”当作“字段已经更新”，可在该评估的 `improvements` 数组中加入以下一项。

```json
{
  "kind": "script",
  "problemId": "saved-field-readback",
  "change": "在保存后重新查询目标记录，并返回实际字段值",
  "criterion": {"id": "persisted", "path": "persisted", "equals": true}
}
```

1. 实施后调用 `review_apply({improvementId,requestId,artifact:{repository,commit,file,prUrl}})`。传入工作树绝对路径、完整提交号和相对文件名，PR 链接可选；请求构造器还要传 `evidenceId`。记忆改动传 `artifact.memoryUpdate`，沿用 `baseRevision` 和 `entry` 或 `memoryId + patch` 的格式。
2. 在新运行的 `run_begin` 中传 `improvement:{improvementId,version}` 及原验收条件。实际使用交付版本，再独立回读业务结果。文件类改动的回读同时返回从已加载实现取得的 `improvementVersion`；记忆改动在 `run_finish.usedMemoryIds` 中引用实际使用的条目。请求构造器还需留下新运行的原生请求记录。
3. 评估 AI 提交新运行的 `eval_submit`。同一版本满足验收条件并有对应回读后，该项进入 `verified`。失败或证据不足会留下尝试记录，状态保留为 `applied`；修订交付物时传当前 `expectedVersion`，再按新版本复验。
4. 通过 PR 交付可复用改动，附上问题编号、版本和复验运行。后续多个真实案例的效果，可继续用 `review_observe` 跟踪。

### Oracle 每日浏览器操作评审

在 Oracle 上使用有权读取浏览器操作记录的账号运行。需要 Python 3、Node.js、本机已登录的 Codex CLI，以及有目标仓库写权限的 GitHub CLI。Oracle 定时入口 `scripts/browser-review-daily.py` 在香港时间 09:00 和 21:00 处理上一完整日，晚间沿用当日 PR 或补交缺报。它通过本机 `yonclaw-result` 发送普通结果通知。每日窗口按香港日历计算，可用 `TZ=Asia/Hong_Kong date -d yesterday +%F` 取得前一天。

```sh
python3 scripts/browser-review-pr.py run --day 2026-11-25
```

首轮运行时，Oracle 采集当日记录并启动独立的只读 Codex 会话评审。评审完成后，同一轮落实有证据支持的修改，将代码差异、逐项处理结果和报告一并提交到 `zhiyaunhe-ops/browser-ai-mcp` 的同一条 PR，等待人工审批。当天没有代码修改时，单独提交报告。报告位于 `reviews/browser/YYYY-MM-DD.md`。原始证据和会话日志保留在 Oracle。

```sh
python3 scripts/browser-review-pr.py collect --day 2026-11-25
python3 scripts/browser-review-pr.py review --day 2026-11-25
python3 scripts/browser-review-pr.py publish --day 2026-11-25
```

`collect` 返回本地证据包路径，`review` 返回本地报告路径，`publish` 返回 PR 链接、状态和提交号。已经由另一个独立会话准备好报告时，可直接执行 `publish --day 2026-11-25 --report /absolute/path/to/review.md`。报告应为 UTF-8 Markdown，以一级标题开头，只写归纳结论和非敏感证据定位。

默认状态目录为 `~/.local/state/browser-ai-mcp/reviews/YYYY-MM-DD`，设置 `XDG_STATE_HOME` 或传入 `--state-dir` 可改变存放位置。同一天重跑会沿用已保存的证据和报告。推送后创建 PR 失败时，用相同日期重跑 `publish` 即可继续。已有同日 PR 时返回它的状态和链接。现存远端报告与本地文件不一致时，脚本保留本地报告并报告冲突。

采集来源补齐后，可用 `python3 scripts/browser-review-pr.py refresh --day 2026-11-25` 对同日重新采集和独立评审。刷新仅适用于已有开放 PR。旧证据和报告保留在本机，新报告以快进提交更新同一条 PR，随后回读 PR 提交和报告。刷新中断时，重跑相同命令会继续待完成的修订。刷新成功后，日常命令沿用最新核实的修订。

## Related documents

- [AI 操作入口](../SKILL.md)
- [评估报告索引](../reviews/browser/README.md)
