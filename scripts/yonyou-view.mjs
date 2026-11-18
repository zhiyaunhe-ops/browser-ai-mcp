// 旗舰版页面「看全部」的替代方案：不进全屏，放大逻辑视口 + 用滚轮读虚拟表格。
// 背景：mdf 列表用 fixed-data-table，DOM 里只渲染可视窗口内的行（实测 25→31 行随滚动变化），
// 所以「看全部」不是把窗口撑到全屏，而是把视口调大一点、再分段用滚轮扫。
//
//   const view = await import("file:///.../scripts/yonyou-view.mjs");
//   await view.fitViewport(page);                 // 1440×801 → 1600×900，不进全屏
//   const rows = await view.readTable(page);      // 滚到底，按行文本去重后返回全部
//   await view.resetViewport(page);               // 还原，避免影响下一个任务

export const VERSION = "2026-11-09.1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 视口与全屏状态 */
export async function metrics(page) {
  return await page.evaluate(() => ({
    w: innerWidth,
    h: innerHeight,
    dpr: devicePixelRatio,
    fullscreen: !!document.fullscreenElement,
    screen: [screen.width, screen.height],
  }));
}

/**
 * 用 CDP 放大逻辑视口，代替全屏。dpr 设为 1，避免 2x 截图过大。
 * 返回 before/after，调用方可以断言 w 变大。
 */
/**
 * 放大逻辑视口。实现放在 yonyou-nav.mjs（那边开工就会自动调），这里转出同一份，
 * 避免两个脚本对「放大到多大、要不要跳过」各写一套。
 */
export { fitViewport } from "./yonyou-nav.mjs";

/** 清掉视口覆盖，恢复用户窗口尺寸 */
export async function resetViewport(page) {
  await page.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
  await sleep(400);
  return await metrics(page);
}

/** 如果页面已经进了原生全屏，退出来。全屏会打乱 rect 与截图，脚本里不要主动进。 */
export async function exitFullscreen(page) {
  const was = await page.evaluate(() => !!document.fullscreenElement);
  if (was) {
    await page.evaluate(() => document.exitFullscreen && document.exitFullscreen());
    await sleep(400);
  }
  return { wasFullscreen: was, now: await metrics(page) };
}

/** 找一个可滚动的表格容器（fixed-data-table 优先），返回可滚动的盒子与中心点 */
export async function findScroller(page, selector) {
  return await page.evaluate((sel) => {
    const cands = sel
      ? [...document.querySelectorAll(sel)]
      : [...document.querySelectorAll(".fixedDataTableLayout_rowsContainer, .fixedDataTableLayout_main, .wui-table-body, .scrollarea-content, [class*=table-container]")];
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 40) continue;
      const vScroll = el.scrollHeight > el.clientHeight + 8;
      const hScroll = el.scrollWidth > el.clientWidth + 8;
      if (!vScroll && !hScroll) continue;
      return {
        cls: String(el.className).slice(0, 60),
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + Math.min(r.height, 400) / 2),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        vScroll, hScroll,
        scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
      };
    }
    // fixed-data-table 的行容器是 overflow:hidden，scrollHeight 不大于 clientHeight，
    // 但 wheel 和 scrollTop 都还能用——必须单独兜底，否则长表会被当成「没有可滚容器」。
    const fdt = document.querySelector(".fixedDataTableLayout_rowsContainer");
    if (fdt) {
      const r = fdt.getBoundingClientRect();
      if (r.width > 120 && r.height > 60) {
        return {
          cls: String(fdt.className).slice(0, 60),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + Math.min(r.height, 400) / 2),
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          vScroll: true, hScroll: false, hidden: true,
          scrollTop: fdt.scrollTop, scrollHeight: fdt.scrollHeight, clientHeight: fdt.clientHeight,
        };
      }
    }
    return null;
  }, selector || null);
}

/** 在容器上滚一次（先 move 再 wheel，ego 的 wheel 作用在当前鼠标位置） */
export async function scroll(page, box, opts = {}) {
  const dx = opts.dx || 0;
  const dy = opts.dy || 500;
  await page.mouse.move(box.x, box.y, { label: "hover scroll area" });
  await page.mouse.wheel(dx, dy, { label: opts.label || "scroll list" });
  await sleep(opts.settle || 700);
  return await page.evaluate((sel) => {
    const el = (sel && document.querySelector(sel)) || document.querySelector(".fixedDataTableLayout_rowsContainer");
    const rows = document.querySelectorAll(".fixedDataTableRowLayout_rowWrapper, tbody tr, .wui-table-row");
    return { scrollTop: el ? el.scrollTop : null, scrollLeft: el ? el.scrollLeft : null, rows: rows.length };
  }, opts.selector || "");
}

/**
 * 逐段滚，收集所有行文本（虚拟表格必须这样读，DOM 里永远只有一屏）。
 * 停下来的判据不是 scrollTop（fixed-data-table 是 overflow:hidden，scrollTop 恒为 0），
 * 而是「这一屏的行内容和上一屏完全一样」——说明滚不动了或已到底。
 */
export async function readTable(page, opts = {}) {
  const maxRounds = opts.maxRounds || 20;
  const selector = opts.selector;
  const step = opts.step || 400;
  const settle = opts.settle || 500;
  const readNow = async () =>
    await page.evaluate(() => {
      const T = (el) => (el ? (el.innerText || "").trim().replace(/\s+/g, " ") : "");
      const rows = [...document.querySelectorAll(".fixedDataTableRowLayout_rowWrapper, tbody tr, .wui-table-row")];
      return rows.map((r) => T(r)).filter((t) => t && t.length > 1);
    });

  let box = await findScroller(page, selector);
  if (!box) return { rows: [...new Set(await readNow())], rounds: 0, note: "no scrollable container" };

  // 先往上滚到顶（负方向滚轮），再从头往下扫
  try {
    await page.mouse.move(box.x, box.y, { label: "hover list" });
    await page.mouse.wheel(0, -6000, { label: "back to top" });
    await sleep(settle);
  } catch { /* 页面忙时忽略，下面按当前屏开始 */ }
  await page.evaluate((sel) => {
    const el = (sel && document.querySelector(sel)) || document.querySelector(".fixedDataTableLayout_rowsContainer");
    if (el) el.scrollTop = 0;
  }, selector || "").catch(() => {});
  await sleep(300);

  const seen = new Map();
  let rounds = 0;
  let prevSig = "";
  for (let i = 0; i < maxRounds; i++) {
    rounds++;
    const batch = await readNow();
    for (const t of batch) if (!seen.has(t)) seen.set(t, 1);
    const sig = batch.join("\u0001");
    if (sig === prevSig) break; // 这一屏和上一屏一样：到底了
    prevSig = sig;
    try {
      const st = await scroll(page, box, { dy: step, settle });
      if (st.scrollTop != null) box = { ...box, scrollTop: st.scrollTop };
    } catch {
      break; // wheel 超时（页面忙）：保住已读到的行
    }
  }
  return { rows: [...seen.keys()], rounds, note: "" };
}

/**
 * 读表前的自检：渲染了多少行、去重后多少行、底部有没有分页/总数。
 * fixed-data-table 会渲染空的占位行（实测 16 个 wrapper 只有 11 行有字），
 * 所以「看全部」是否完整，要用这里的 total 判断，不能数 wrapper。
 */
export async function tableMeta(page) {
  return await page.evaluate(() => {
    const T = (el) => (el ? (el.innerText || "").trim().replace(/\s+/g, " ") : "");
    const wrappers = [...document.querySelectorAll(".fixedDataTableRowLayout_rowWrapper, tbody tr, .wui-table-row")];
    const texts = wrappers.map(T).filter((t) => t && t.length > 1);
    const pager = [...document.querySelectorAll("[class*=pagination], [class*=pager], .wui-pagination")]
      .map((e) => T(e)).filter(Boolean).join(" | ");
    const totalMatch = pager.match(/(?:共|Total)\s*([0-9]+)/i);
    return {
      wrappers: wrappers.length,
      rendered: texts.length,
      unique: new Set(texts).size,
      pager: pager.slice(0, 120),
      total: totalMatch ? Number(totalMatch[1]) : null,
    };
  });
}
