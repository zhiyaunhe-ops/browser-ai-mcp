'use strict';

// 单一份 memo 文本：MCP 的 run_begin 返回它，ego.js 每轮把 prelude 注入脚本。
// Historical source-mining counts are not runtime counts; keep the memo qualitative.
// 定位类规则已固化进 scripts/ys-locate.mjs，memo 只保留一句入口，不再逐条讲怎么拼选择器。
const VERSION = '2026-11-25.1';

const MEMO = `[ego memo]
每个业务步骤都要记录实际请求，查看本轮 networkCapture 和 evidence_query 的接口证据与缺口。复用已核实的请求，保留精确的页面入口作为回退。读取失败可改走页面；提交结果不明时先独立核对业务值，再决定是否重试。
1 On Yonyou pages, start with ys.context/inspect/find and narrow by observed fieldid, framePath and scope when available. If insufficient, use native semantic page.snapshot(), then visual page.screenshot(); stop once the question is answered.
2 On a missing node, inspect entryPoints or ys.entries({rowText,framePath,reveal:true}). If the row lacks 对照表, check modeActions for a visible 修改/Edit toolbar control. Enter edit mode when appropriate and inspect the same row again. Open its exact link, then read the destination. For two-pane pickers use ys.transferState then ys.transferRight to move the requested batch and verify the right list. Verify any later save separately.
3 On a miss, keep trying distinct observed paths: wait for loading, scroll the actual grid, select or hover the target row, open More, expand a branch or enter Edit. After each change, reread the same record or destination. If still unclear, try a native page.snapshot() and then page.screenshot(). On a repeated state, change approach. Check both sides before any further transfer; a write with an unknown result needs independent observation.
4 Use waitForSelector or ys.waitFor for controls, or ys.waitIdle({until:state=>...}) for a specific state. Default waitIdle observes content stability and does not prove saving succeeded.
5 rows counts rendered visible rows, not all records. Read tables with a scoped extraction and verify pagination, stable row IDs and the application's total count.
6 Coordinate actions need a label naming the target and purpose. Scrolling requires a new target observation; auto-labels and successful clicks do not establish correctness.
7 Scripts run in Node: use task/page/input; document/window/location belong inside page.evaluate(). Ego is a custom API: no page.locator/$/frames/wait, no label on fill/screenshot, no timeoutMs on goto; screenshot paths must be absolute. Read the installed ego guide rather than infer Playwright methods.
8 Use ys.readValue({selector,framePath,scope,kind:'value'}) for one observed field. Check ok/found/reason; missing, ambiguous, shape-mismatch and empty values differ. For custom extraction check elements and Array.isArray before accessing properties or mapping.
9 After stale refs take a fresh snapshot; after missing labels inspect task.pages()/tabs(). On timeouts query run_get and observe current URL/state once stopped. Do not replay a write or silently create another Space. Return JSON values, await page.url(), and verify business fields independently after writes.`;

const MEMO_SHORT = MEMO.split('\n').slice(0, 5).join('\n');

module.exports = { VERSION, MEMO, MEMO_SHORT };
