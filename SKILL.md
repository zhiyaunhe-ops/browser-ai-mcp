---
name: browser-ai
description: Run browser tasks through MCP and ego lite with scoped Yonyou readers, bulk picker controls and saved execution evidence.
---

# Browser tasks through MCP

Start with `run_begin` and a goal, URL and observable business criteria. The first `browser_run` opens the task Space. Run scripts receive `task`, `page` and JSON `input`. Read `ego-browser skill` for the installed Page and TaskSpace API.

For ASP UAT workbench service navigation use `asp_workbench_open_node`. For enterprise PC template lookups use `asp_workbench_query_templates`. Both operate in the current run. Inspect the settled execution's `networkCapture` and use `evidence_query` with the execution ID and `view: "api"` for observed request details and capture gaps. In a reusable procedure, record the verified request inputs, the page controls to use if a read fails, and the observable result. After a write with an uncertain outcome, read back the target before trying either path again.

## Review a run on the same machine

When available, pass the original log path and session ID in `run_begin.sessionSource`. After handoff, a reviewer on the same data directory calls `eval_pending`, then `eval_packet`. Use `eval_session_context` to check user corrections and the final claim against the browser evidence. Submit the verdict using `eval_submit` with browser evidence IDs and session line references. Record missing evidence as `insufficient_evidence`.

If the original log path is absent or stale, actively search the client-specific roots in `eval_packet.sessionSearch`. Look for the session ID, then the run ID, task wording and time. Confirm the request and final reply in context before citing line numbers.

On Oracle, run the daily cross-client Browser Eval with `python3 scripts/browser-review-pr.py run --day YYYY-MM-DD` (Hong Kong date). It opens a separate local review session and submits the resulting report as a GitHub pull request for approval. See the [daily review workflow](README.md).

After review, submit reusable fixes, regression cases or documented lessons through a PR to the authorized repository. Include the problem ID, rationale, evidence locators and verification result, and return the PR URL. Keep full session logs local.

Follow the same `problem_id` in `review_history`. Use `review_observe` for later measurements with the actual deployed version and evidence locator.

## Act on evaluation findings

For each actionable finding, include an item in `eval_submit.improvements` or call `review_improve` on an existing review. Identify the problem, the change and an observable criterion. Use `review_improvements` to resume open items.

Implement code and scripts with the local repository tools. For a request builder, use the captured method, URL, query keys and payload structure from the source run and commit the parameterized builder. Supply the repository, exact commit and changed file to `review_apply`. Include the native request record ID for a builder. For memory, submit the actual entry or patch and its base revision to `review_apply`.

Run the delivered version on a fresh task using `run_begin.improvement` and the planned criterion. Read the business result independently. Include the version observed from the running implementation in the readback's `improvementVersion` field; for memory, identify the revision used and cite the memory ID at finish. Submit the new evaluation, inspect the recorded attempt and continue any unresolved item. Deliver the reusable change by PR with the version and verification evidence.

## Find a business node

1. On a Yonyou page, inspect `ys.context()` or `ys.find(name)`. Use an observed frame, control ID or scope to narrow the read.
2. If the parent page is visible, inspect `entryPoints` on a miss or call `ys.entries({scope,framePath})`. A row can open its detail through a mapping button or a text link. Color alone provides insufficient evidence.
3. If the row shows actions on hover, use `ys.entries({framePath,rowText,reveal:true})` with one exact cell value. Open the observed control, then check the destination record and title. Some entries open another page in `task.pages()`.
4. If the relevant control remains unclear, inspect the native semantic `page.snapshot()`, then a visual `page.screenshot()` as needed. An incomplete scan only describes the observed view.

If the correct row lacks its mapping action, inspect `modeActions` for a visible 修改 or Edit in the toolbar. When editing mode is appropriate, click the observed toolbar control without a row filter, then reveal the target row again. Use Cancel to leave temporary inspection changes.

On a miss, try the next observed route. Check loading and the grid's scroll position, select or hover the row, open More, or expand a branch. Re-read the target after each action. A repeating state calls for another route or observation layer. Read both sides of a transfer before sending further input.

```js
return await ys.click(input.entryName, {rowText: input.cellValue, framePath: input.framePath});
```

## Select several records

Read the two lists in an observe round, using the CSS selector for the picker and its observed frame.

```js
return await ys.transferState({scope: input.scope, framePath: input.framePath});
```

Use the exact item names and the same scope in an execute round. The helper checks the requested candidates, clicks the move-selected arrow once, and reads back the right list.

```js
return await ys.transferRight(input.names, {scope: input.scope, framePath: input.framePath});
```

Inspect `ok`, `verified` and `moved`. A collapsed tree may hide existing choices. The reader reports `expandHints`. The execute helper can expand a uniquely identified root to check its leaves. An incomplete list, an ambiguous name or an unexpected selection requires another observation.

When the task includes saving the business record, confirm and save as the page requires, reopen it and verify the saved values independently.

## Finish a run

Poll `run_get` with the execution ID. Before repeating an interrupted action, establish whether the original execution stopped and observe its outcome. After the last write, return the business fields in a separate `purpose: "observe"` execution. Use its observation ID in `run_finish`.

## Related documents

- [Installation](install.md)
- [Capabilities and MCP tools](README.md)
