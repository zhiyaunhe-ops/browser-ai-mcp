---
name: browser-ai-review
description: 独立复核已交接的 browser-ai 运行，按验收条件评审业务结果和工具选择，并跟踪改进与复验。
---

# Browser AI 运行评审

评审会话加载 `browser-ai-review` MCP（启动参数 `--tools review`）。现有会话可通过本仓库的 `scripts/review-provider.js` 按次调用评审工具，标准输入为 JSON 对象 `{"action":"eval_pending","arguments":{}}`。

1. 在执行端使用的数据目录中，用 `eval_pending` 选择待评运行，再用 `eval_packet` 读取目标、验收条件和独立回读。翻页与提交沿用该次交接的 `reviewKey`。
2. 对照原始会话中的请求、用户纠正及最终答复。用 `eval_session_context` 核对会话行号，用 `evidence_query` 核对执行记录和请求。
3. 逐项判断业务结果，单独评价当时可用且获准的工具选择。用 `eval_submit` 提交结论与证据引用。证据不足的项目标记为 `insufficient_evidence`。
4. 对需要跟踪的改进，用 `review_improve` 登记问题和验收条件，用 `review_apply` 记录实现版本。执行端在新运行中回读业务结果，评审端据此复验。

## Related documents

- [评审、会话取证与每日评审操作](../../references/browser-eval.md)
- [执行与交接](../../SKILL.md)
