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

Keep calls on the same run sequential. When a round returns `queued` or `running`, poll `run_get` with both `runId` and its `executionId` before starting the next operation or calling `run_finish`. For `RUN_BUSY`, use the IDs in `blockingExecutions`. The saved execution records carry `previousExecutionId`, `startedAt`, and `finishedAt`.

For `OUTCOME_UNKNOWN`, query the original execution. If it remains unknown after `executionStopped: true`, use a later same-run observe round to read what happened. Include the original execution ID, that observation ID, and a note in `browser_run.resolutions` before another write. If the result cannot be determined, report it as unresolved and leave the write pending.

After the last write, reopen the exact saved business record in a separate `purpose: "observe"` round. Return the identifying fields and the actual values at the paths declared in `run_begin.criteria`. In `run_finish`, pass `verification: [{ criterionId, observationId }]` for each criterion and use `outcome: "succeeded"` only after the values match. Use `outcome: "unknown"` for unconfirmed results and `outcome: "failed"` for confirmed mismatches. Retain the relevant verification references and describe the mismatch or missing evidence in `note`. Inspect the handoff's `readbacks` for the expected and actual values and observation references.

Omit `decision`, `usedMemoryIds`, and `updates` when handing off without a memory change. For `confirmed`, provide the IDs of memory actually used on the same product edition and site. For `learned` or `corrected`, provide the update, and include the original ID in `usedMemoryIds` when correcting an existing entry.

## Submit valid browser programs

Use the installed Ego API. Pass caller values through `args` and read them from `input`. Run DOM code inside `page.evaluate(callback, input)`; use `await import(...)` for helpers. Keep the browser program as ordinary JavaScript source and pass it as a string, so template interpolation and JSON encoding in the wrapper do not rewrite the source. On `EGO_PROGRAM_CONTRACT`, read `issues` for the line, column and rule, correct the source, and submit the corrected round.

In a Codex `exec` wrapper, use `text({ browserOperation: { operation, runId, requestId }, result })` for each browser tool's returned response. The `operation` is the MCP tool name without the namespace. When a branch skips work, emit `{ browserOperation, skipped: true, reason }` with the same identity. If several call sites use the same operation and their request IDs are computed, add the call site's one-based `operationIndex` in wrapper source order. Use a separate request ID for each iteration. If the wrapper yields a cell ID, use `wait` until its output is collected.

## Related documents

- [Installation](install.md)
- [Capabilities and MCP tools](README.md)
## Optional YonBuilder tools

Configure `BROWSER_AI_YONBUILDER_ROOT` (local plugin installation) and `BROWSER_AI_YONBUILDER_WORKSPACE` (authenticated workspace) in the MCP host. The server invokes the installed CLI with Node. Each operator supplies their own CLI, workspace and credentials.

Use `yonbuilder_app_list`, `yonbuilder_bizobj_list` and `yonbuilder_page_list` to identify a target in the selected session. Read an exact field with `yonbuilder_field_get` and preview a property change with `yonbuilder_field_preview`. Use `yonbuilder_cli` for other supported commands. `yonbuilder_open` returns a space ID for `yonbuilder_current_page`. When a name matches several pages, choose a unique code from the candidates.

## Versioned local procedures

Set `BROWSER_AI_PROCEDURES_DIR` to an operator-controlled directory of procedure folders. Each folder has a `SKILL.md` with JSON front matter between `---` lines, containing `id`, `version`, `description`, `nodes`, `goalTerms`, `entry`, and optionally `productVersion`, `node` and `flow`. The entry exports an async `probe({ task, page, input })`. The public checkout ships without deployment-specific procedure packages.

Read `scriptCache` in `run_begin` or `run_get`. For a match, pass `invoke.script` to `browser_run` with `purpose: "execute"`. An old or missing briefing returns before dispatch. To use custom code for a matched task, pass its current `scriptBriefingId`. Read back results independently and finish the run for Eval. The Yonyou page reader also supports explicit split-button menus through `ys.openSplitMenu`.

## YonCode host setup

Register the root Node entry point `src/mcp.js` in the project's local MCP settings. Set `BROWSER_AI_EGO_BIN` to the installed ego lite executable. Supply the plugin root and authenticated workspace through the two YonBuilder variables described above. Keep machine paths and login data in the local host configuration.

For runtime navigation, open the target through `yonbuilder_open` and pass its space ID to `yonbuilder_current_page`. For design-time edits, use the designer actions provided by the YonCode host. To verify an installation, list tools, read a known template field and run a dry-run preview against its exact container.
