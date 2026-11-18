---
name: browser-ai
description: Run browser tasks through MCP and ego lite with scoped Yonyou readers, bulk picker controls and saved execution evidence.
---

# Browser tasks through MCP

Start with `run_begin` and a goal, URL and observable business criteria. The first `browser_run` opens the task Space. Run scripts receive `task`, `page` and JSON `input`. Read `ego-browser skill` for the installed Page and TaskSpace API.

## Find a business node

1. On a Yonyou page, inspect `ys.context()` or `ys.find(name)`. Use an observed frame, control ID or scope to narrow the read.
2. If the parent page is visible, inspect `entryPoints` on a miss or call `ys.entries({scope,framePath})`. A row can open its detail through a mapping button or a text link. Color alone provides insufficient evidence.
3. If the row shows actions on hover, use `ys.entries({framePath,rowText,reveal:true})` with one exact cell value. Open the observed control, then check the destination record and title. Some entries open another page in `task.pages()`.
4. If the relevant control remains unclear, inspect the native semantic `page.snapshot()`, then a visual `page.screenshot()` as needed. An incomplete scan only describes the observed view.

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
