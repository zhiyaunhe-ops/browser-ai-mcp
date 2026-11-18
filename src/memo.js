'use strict';

// 单一份 memo 文本：MCP 的 run_begin 返回它，ego.js 每轮把 prelude 注入脚本。
// Historical source-mining counts are not runtime counts; keep the memo qualitative.
// 定位类规则已固化进 scripts/ys-locate.mjs，memo 只保留一句入口，不再逐条讲怎么拼选择器。
const VERSION = '2026-11-18.2';

const MEMO = `[ego memo]
1 On Yonyou pages, start with ys.context/inspect/find and narrow by observed fieldid, framePath and scope when available. If insufficient, use native semantic page.snapshot(), then visual page.screenshot(); stop once the question is answered.
2 On a missing node, check find().entryPoints or ys.entries() for a 对照表 button or row link. For a hover toolbar use entries({rowText,framePath,reveal:true}). Use ys.click(name,{rowText,framePath}) with an exact cell value, then read the new view. For a two-pane picker, read ys.transferState({scope,framePath}), then ys.transferRight(names,{scope,framePath}) moves the selected batch and checks the right-hand list. Verify any later save separately.
3 Incomplete, truncated, unread-frame, ambiguous or missing-target results may need a native viewport/full-page/subtree snapshot, followed by a screenshot if still insufficient. This ladder is chosen by the agent, not an automatic fallback API; incomplete output never proves absence.
4 Use waitForSelector or ys.waitFor for controls, or ys.waitIdle({until:state=>...}) for a specific state. Default waitIdle observes content stability and does not prove saving succeeded.
5 rows counts rendered visible rows, not all records. Read tables with a scoped extraction and verify pagination, stable row IDs and the application's total count.
6 Coordinate actions need a label naming the target and purpose. Scrolling requires a new target observation; auto-labels and successful clicks do not establish correctness.
7 Scripts run in Node: use task/page/input; document/window/location belong inside page.evaluate(). Ego is a custom API: no page.locator/$/frames/wait, no label on fill/screenshot, no timeoutMs on goto; screenshot paths must be absolute. Read the installed ego guide rather than infer Playwright methods.
8 Use ys.readValue({selector,framePath,scope,kind:'value'}) for one observed field. Check ok/found/reason; missing, ambiguous, shape-mismatch and empty values differ. For custom extraction check elements and Array.isArray before accessing properties or mapping.
9 After stale refs take a fresh snapshot; after missing labels inspect task.pages()/tabs(). On timeouts query run_get and observe current URL/state once stopped. Do not replay a write or silently create another Space. Return JSON values, await page.url(), and verify business fields independently after writes.`;

const MEMO_SHORT = MEMO.split('\n').slice(0, 4).join('\n');

module.exports = { VERSION, MEMO, MEMO_SHORT };
