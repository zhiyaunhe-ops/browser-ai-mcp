// YonBIP 旗舰版/超级版（global.yonyoucloud.com、c<N>.yonyoucloud.com）:
// 左上角三栏菜单的确定性导航。按「领域 → 二级菜单 → 功能项」逐层点，
// 不靠语义定位猜按钮：菜单项在 DOM 里常驻，先读目录，再按名字匹配，最后点坐标。
//
// 用法（在 ego 脚本里）：
//   const nav = await import('file:///.../browser-ai/scripts/yonyou-nav.mjs');
//   const page = task.page("p1");
//   await nav.buildCatalog(page);              // 建目录（每个领域点一次，慢，建议缓存）
//   const hits = nav.search(catalog, "预算控制"); // 名字模糊匹配
//   await nav.gotoFeature(page, "交易类型-预算控制规则"); // 打开菜单并点进去
//
// CLI（只做名字匹配与目录查看，不连浏览器）：
//   node scripts/yonyou-nav.mjs find "预算控制"
//   node scripts/yonyou-nav.mjs catalog <path.json>

import { homedir } from 'node:os';
import { join } from 'node:path';
export const VERSION = "2026-11-09.2";

/**
 * 开工先放大逻辑视口：菜单三栏和列表都能多显示几行，点选路径更短。
 * 只放大不缩小；页面没有 cdp（非 ego）时静默跳过。
 */
export async function fitViewport(page, opts = {}) {
  const width = opts.width || 1680;
  const height = opts.height || 1000;
  if (typeof page.cdp !== "function") return { skipped: "no cdp" };
  const before = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
  if (before.w >= width && before.h >= height) return { before, after: before, skipped: "already large" };
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width: Math.max(width, before.w),
    height: Math.max(height, before.h),
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(600);
  const after = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, fullscreen: !!document.fullscreenElement }));
  return { before, after };
}

const SEL = {
  panel: ".menuBarPart--jHtN4",
  hamburger: ".svgWrap--Jl4L1",
  domainCard: ".menuBarPart--jHtN4 .domain-cloud-wrap",
  domainTitle: ".topText",
  domainSubs: ".domain-list li",
  funcWrap: ".menuBarPart--jHtN4 .navbarRight--KFBMe > .funcWrap",
  funcActive: ".menuBarPart--jHtN4 .navbarRight--KFBMe > .funcWrap.active",
  thirdActive: ".navbarThird .third-node-wrap.active",
  groupItem: ".navbarSecond li.sub-menu-item",
  thirdWrap: ".navbarThird .third-node-wrap",
  thirdInner: ".third-node-wrap-inner",
  classify: ".third-node-classify",
  classifyName: ".third-node-classify-name",
  feature: "div.service-node",
  featureName: ".new-node-name",
};

// 常见同义/近义写法：查不到时按组内任意一个词命中即算候选
const ALIASES = [
  ["交易类型", "业务类型", "单据类型"],
  ["费用项目", "费用项", "费用类别"],
  ["预算控制", "预算管控", "预算规则"],
  ["报销单", "报销", "报账单", "报销单据"],
  ["组织机构", "组织", "部门结构"],
  ["用户", "用户管理", "账号"],
  ["角色", "角色管理"],
  ["供应商", "供应商信息"],
  ["客户", "客户信息"],
  ["物料", "商品", "物料档案"],
  ["凭证", "会计凭证"],
  ["会计科目", "科目"],
  ["付款单", "付款申请单"],
  ["收款单", "收款"],
  ["差旅", "差旅费"],
  ["工作流", "流程"],
  ["模板", "UI模板", "单据模板"],
];

const norm = (s) =>
  String(s == null ? "" : s)
    .replace(/[\u3000\s]+/g, "")
    .replace(/[（）()【】\[\]·・\-—_/、,，.。:：;；'"“”‘’]/g, "")
    .toLowerCase();

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function expand(query) {
  const q = norm(query);
  const groups = [];
  for (const g of ALIASES) {
    const n = g.map(norm);
    if (n.some((x) => x && (q.includes(x) || x.includes(q)))) groups.push(n);
  }
  return { q, groups };
}

function overlapFraction(q, n) {
  if (q.length < 2) return n.includes(q) ? 1 : 0;
  let hit = 0, total = 0;
  for (let i = 0; i < q.length - 1; i++) {
    total++;
    if (n.includes(q.slice(i, i + 2))) hit++;
  }
  return total ? hit / total : 0;
}

/** 给一个名字打分；越高越像。返回 0..1 */
export function scoreName(query, name) {
  const { q, groups } = expand(query);
  const n = norm(name);
  if (!q || !n) return 0;
  if (n === q) return 1;
  if (n.startsWith(q) || q.startsWith(n)) return 0.92;
  if (n.includes(q)) return 0.88;
  const byOverlap = overlapFraction(q, n) * 0.95;
  // 同义组：只在长度相近时给分，避免「控制规则」把「账单控制规则」抬起来
  let aliasBest = 0;
  for (const g of groups) {
    for (const a of g) {
      if (!a || Math.abs(a.length - q.length) > 3) continue;
      if (n === a) aliasBest = Math.max(aliasBest, 0.9);
      else if (n.includes(a)) aliasBest = Math.max(aliasBest, 0.62);
      else aliasBest = Math.max(aliasBest, dice(a, n) * 0.55);
    }
  }
  return Math.max(byOverlap, aliasBest, dice(q, n) * 0.6);
}

/** 目录里做模糊搜索，返回按分数降序的候选 */
export function search(catalog, query, opts = {}) {
  const minScore = opts.minScore == null ? 0.45 : opts.minScore;
  const limit = opts.limit || 12;
  const out = [];
  for (const d of catalog.domains || []) {
    for (const g of d.groups || []) {
      for (const it of g.items || []) {
        const s = Math.max(scoreName(query, it.name), scoreName(query, g.name) * 0.6, scoreName(query, d.name) * 0.4);
        if (s >= minScore) out.push({ score: Number(s.toFixed(3)), card: d.card || d.name, domain: d.name, group: g.name, item: it.name });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  // 同名去重
  const seen = new Set();
  const uniq = [];
  for (const h of out) {
    const k = `${h.domain}|${h.group}|${h.item}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(h);
    if (uniq.length >= limit) break;
  }
  return uniq;
}

// ---------------- 浏览器侧 ----------------

async function panelState(page) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), show: el.classList.contains("show") };
  }, SEL.panel);
}

async function ensureMenuOpen(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let s = await panelState(page);
  if (!(s && s.show)) {
    await page.mouse.click(28, 20, { label: "open top-left menu" });
  }
  while (Date.now() < deadline) {
    await sleep(200);
    s = await panelState(page);
    if (s && s.show && s.x >= 0) return s;
  }
  throw new Error("MENU_NOT_OPEN: panel did not reach x>=0; check hamburger at (28,20) or a different shell");
}

async function closeMenu(page) {
  const s = await panelState(page);
  if (s && s.show) {
    await page.mouse.click(28, 20, { label: "close top-left menu" });
    await sleep(500);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读领域卡（左列），不需要打开菜单也能读 */
export async function readDomains(page) {
  return await page.evaluate((S) => {
    const T = (el) => (el ? (el.innerText || "").trim().replace(/\s+/g, " ") : "");
    return [...document.querySelectorAll(S.domainCard)].map((c, i) => {
      const r = c.getBoundingClientRect();
      return { i, name: T(c.querySelector(S.domainTitle)), subs: [...c.querySelectorAll(S.domainSubs)].map(T).filter(Boolean), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
    }).filter((d) => d.name && !d.name.startsWith("搜索"));
  }, SEL);
}

/** 点一个领域卡；用真实鼠标事件，React 才认 */
export async function openDomain(page, name) {
  await ensureMenuOpen(page);
  const target = await page.evaluate(({ S, name }) => {
    const T = (el) => (el ? (el.innerText || "").trim().replace(/\s+/g, " ") : "");
    const cards = [...document.querySelectorAll(S.domainCard)];
    const hit = cards.find((c) => T(c.querySelector(S.domainTitle)).includes(name));
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), title: T(hit.querySelector(S.domainTitle)) };
  }, { S: SEL, name });
  if (!target) throw new Error(`DOMAIN_NOT_FOUND: ${name}`);
  await page.mouse.click(target.x, target.y, { label: `domain ${name}` });
  await sleep(600);
  return target.title;
}

/** 读一张领域卡里的二级导航项（.domain-list > li），带坐标 */
export async function readCardSubs(page, cardName) {
  return await page.evaluate(({ S, cardName }) => {
    const T = (el) => (el ? (el.innerText || "").trim().replace(/\s+/g, " ") : "");
    const card = [...document.querySelectorAll(S.domainCard)].find((c) => T(c.querySelector(S.domainTitle)).includes(cardName));
    if (!card) return [];
    return [...card.querySelectorAll(S.domainSubs)].map((li) => {
      const r = li.getBoundingClientRect();
      return { name: T(li), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };
    }).filter((s) => s.name);
  }, { S: SEL, cardName });
}

/** 打开「领域卡 → 可选二级导航项」；sub 为空就只点卡 */
export async function openNav(page, cardName, subName) {
  const title = await openDomain(page, cardName);
  if (!subName) return title;
  const subs = await readCardSubs(page, cardName);
  const hit = subs.find((s) => s.name === subName) || subs.find((s) => s.name.includes(subName));
  if (!hit) throw new Error(`SUB_NOT_FOUND: ${subName} in ${cardName}; have ${subs.map((s) => s.name).join(",")}`);
  await page.mouse.click(hit.x, hit.y, { label: `nav ${hit.name}` });
  await sleep(700);
  return `${title} / ${hit.name}`;
}

/** 读当前激活领域下的二级菜单（只读 `.funcWrap.active`，其余领域 display:none） */
export async function readGroups(page) {
  return await page.evaluate((S) => {
    const T = (el) => (el ? (el.innerText || "").trim().replace(/\s+/g, " ") : "");
    const out = [];
    const wrap = document.querySelector(S.funcActive);
    if (!wrap) return out;
    for (const el of wrap.querySelectorAll(S.groupItem)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0) continue;
      out.push({ name: T(el), active: el.classList.contains("active"), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    }
    return out;
  }, SEL);
}

export async function openGroup(page, name) {
  const groups = await readGroups(page);
  const hit = groups.find((g) => g.name === name) || groups.find((g) => g.name.includes(name));
  if (!hit) throw new Error(`GROUP_NOT_FOUND: ${name}; have ${groups.map((g) => g.name).join(",")}`);
  await page.mouse.click(hit.x, hit.y, { label: `group ${hit.name}` });
  await sleep(600);
  return hit.name;
}

/** 读当前二级菜单下的功能项（只读激活 funcWrap 里 `.third-node-wrap.active`；分类标题 + 功能名 + 坐标） */
export async function readFeatures(page) {
  return await page.evaluate((S) => {
    const T = (el) => (el ? (el.innerText || "").trim().replace(/\s+/g, " ") : "");
    const out = [];
    const wrap = document.querySelector(`${S.funcActive} ${S.thirdActive}`);
    if (!wrap) return out;
    const inner = wrap.querySelector(S.thirdInner) || wrap;
    let classify = "";
    for (const child of inner.children) {
      if (child.matches(S.classify)) {
        classify = T(child.querySelector(S.classifyName));
        for (const feat of child.querySelectorAll(S.feature)) {
          const r = feat.getBoundingClientRect();
          const nm = feat.querySelector(S.featureName);
          out.push({ classify, name: T(nm) || T(feat), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
        }
      } else if (child.matches(S.feature)) {
        const r = child.getBoundingClientRect();
        out.push({ classify: "", name: T(child), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      }
    }
    return out;
  }, SEL);
}

/** 把某个功能项滚进右列可视区，返回点击坐标 */
async function scrollToFeature(page, name) {
  return await page.evaluate(({ S, name }) => {
    const T = (el) => (el ? (el.innerText || "").trim().replace(/\s+/g, " ") : "");
    const scope = document.querySelector(`${S.funcActive} ${S.thirdActive}`) || document;
    const feats = [...scope.querySelectorAll(S.feature)];
    const hit = feats.find((f) => { const n = f.querySelector(S.featureName); return (T(n) || T(f)) === name; });
    if (!hit) return null;
    hit.scrollIntoView({ block: "center" });
    const r = hit.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
  }, { S: SEL, name });
}

/** 在菜单里点一个功能项；成功返回 true（随后调用方自己等页面跳转） */
export async function clickFeature(page, name) {
  const pos = await scrollToFeature(page, name);
  if (!pos) throw new Error(`FEATURE_NOT_FOUND: ${name}`);
  if (pos.rect[2] <= 0 || pos.y <= 40) throw new Error(`FEATURE_NOT_IN_VIEW: ${name} rect=${pos.rect}`);
  await page.mouse.click(pos.x, pos.y, { label: `feature ${name}` });
  return true;
}

/** 建完整目录：逐「领域卡 / 卡内二级导航项」点开，读「二级菜单 → 功能项」。慢，建议缓存到 JSON。 */
export async function buildCatalog(page, opts = {}) {
  if (opts.fit !== false) await fitViewport(page, opts).catch(() => {});
  const cards = await readDomains(page);
  const out = { version: VERSION, host: await page.evaluate(() => location.host), builtAt: new Date().toISOString(), domains: [] };
  for (const card of cards) {
    const navs = card.subs && card.subs.length ? card.subs : [null];
    for (const sub of navs) {
      if (opts.only && ![card.name, sub || ""].some((k) => k && opts.only.some((o) => k.includes(o)))) continue;
      await openNav(page, card.name, sub);
      const groups = await readGroups(page);
      const groupsOut = [];
      for (const g of groups) {
        await openGroup(page, g.name);
        const feats = await readFeatures(page);
        const items = [];
        const seen = new Set();
        for (const f of feats) {
          const key = `${f.name}|${f.classify}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ name: f.name, classify: f.classify });
        }
        groupsOut.push({ name: g.name, items });
      }
      out.domains.push({ card: card.name, name: sub || card.name, subs: card.subs, groups: groupsOut });
    }
  }
  await closeMenu(page);
  return out;
}

/** 只建「领域卡/二级导航 → 二级菜单」的索引，不读功能项。快（~1s/nav），适合缓存。 */
export async function buildIndex(page, opts = {}) {
  const cards = await readDomains(page);
  const out = { version: VERSION, host: await page.evaluate(() => location.host), builtAt: new Date().toISOString(), kind: "index", domains: [] };
  for (const card of cards) {
    const navs = card.subs && card.subs.length ? card.subs : [null];
    for (const sub of navs) {
      if (opts.only && ![card.name, sub || ""].some((k) => k && opts.only.some((o) => k.includes(o)))) continue;
      await openNav(page, card.name, sub);
      const groups = await readGroups(page);
      out.domains.push({ card: card.name, name: sub || card.name, groups: groups.map((g) => ({ name: g.name, items: [] })) });
    }
  }
  await closeMenu(page);
  return out;
}

/** 按 二级菜单名/导航名 排候选组（不读功能项） */
export function rankGroups(index, query, opts = {}) {
  const min = opts.minScore == null ? 0.35 : opts.minScore;
  const out = [];
  for (const d of index.domains || []) {
    for (const g of d.groups || []) {
      const s = Math.max(scoreName(query, g.name) * 0.75, scoreName(query, d.name) * 0.5, scoreName(query, d.card) * 0.45);
      if (s >= min) out.push({ score: Number(s.toFixed(3)), card: d.card, domain: d.name, group: g.name });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 用索引 + 懒读功能项定位：只点开分数最高的几个二级菜单，读里面的功能项再排序 */
export async function findFeature(page, query, opts = {}) {
  const index = opts.index || (await buildIndex(page));
  const groups = rankGroups(index, query).slice(0, opts.topGroups || 3);
  if (!groups.length) return { best: null, candidates: [], groups: [] };
  const found = [];
  for (const g of groups) {
    await openNav(page, g.card, g.domain === g.card ? null : g.domain);
    await openGroup(page, g.group);
    const feats = await readFeatures(page);
    for (const f of feats) {
      const s = Math.max(scoreName(query, f.name), scoreName(query, g.group) * 0.5);
      if (s >= 0.45) found.push({ score: Number(s.toFixed(3)), card: g.card, domain: g.domain, group: g.group, item: f.name });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return { best: found[0] || null, candidates: found.slice(0, 5), groups };
}

/** 一步到位：按功能名找到路径并点进去；返回命中的 path */
export async function gotoFeature(page, query, opts = {}) {
  if (opts.fit !== false) await fitViewport(page, opts).catch(() => {});
  const { best, candidates } = opts.catalog
    ? { best: (search(opts.catalog, query)[0] || null), candidates: search(opts.catalog, query).slice(0, 5) }
    : await findFeature(page, query, opts);
  if (!best) throw new Error(`NO_MATCH: ${query} in this menu catalog. Inspect ys.entries() on the parent business page for mapping buttons or row links.`);
  await openNav(page, best.card, best.domain === best.card ? null : best.domain);
  await openGroup(page, best.group);
  await clickFeature(page, best.item);
  await sleep(300);
  return { path: best, candidates };
}

/** 判断当前页是哪种外壳：bip-cloud（mdf/lebra 三栏菜单）或 nccloud（高级版树菜单） */
export async function detectShell(page) {
  return await page.evaluate(() => {
    const has = (s) => !!document.querySelector(s);
    if (has(".menuBarPart--jHtN4") || has(".lebra-navbar-left") || has("button[fieldid]")) return "bip-cloud";
    if (typeof window["nc-lightapp-front"] === "object") return "nccloud";
    return "unknown";
  });
}

/** 用菜单自带的搜索框（`.searchPart--sFQdu`）搜服务名；返回候选项文本。搜不到时用来做退化。 */
export async function menuSearch(page, query) {
  await ensureMenuOpen(page);
  const box = await page.evaluate((S) => {
    const input = document.querySelector(`${S.panel} .searchPart--sFQdu input`);
    if (!input) return null;
    const r = input.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };
  }, SEL);
  if (!box) throw new Error("MENU_SEARCH_NOT_FOUND");
  if (box.w <= 0) throw new Error("MENU_SEARCH_HIDDEN: 搜索框只在菜单初始态显示；先 closeMenu(page) 再调用");
  await page.mouse.click(box.x, box.y, { label: "menu search box" });
  if (typeof page.fill === "function") {
    await page.fill(`${SEL.panel} .searchPart--sFQdu input`, query).catch(() => {});
  }
  if (typeof page.keyboard?.insertText === "function") {
    await page.keyboard.insertText(query).catch(() => {});
  } else if (typeof page.keyboard?.type === "function") {
    await page.keyboard.type(query).catch(() => {});
  }
  await sleep(900);
  const items = await page.evaluate((S) => {
    const T = (el) => (el ? (el.innerText || "").trim().replace(/\s+/g, " ") : "");
    const out = [];
    for (const el of document.querySelectorAll(`${S.panel} .search-result-wrap li, ${S.panel} .search-result-wrap .result-item`)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) out.push({ text: T(el), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    }
    return out;
  }, SEL);
  return items;
}

/** 把目录缓存到磁盘 / 读回；catalog 文件按 host 命名 */
export async function saveCatalog(cat, cachePath) {
  const fs = await import("node:fs");
  fs.writeFileSync(cachePath, JSON.stringify(cat));
  return cachePath;
}

export async function loadCatalog(cachePath) {
  const fs = await import("node:fs");
  if (!fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
}

export function catalogSummary(cat) {  const d = (cat.domains || []).length;
  const g = (cat.domains || []).reduce((n, x) => n + (x.groups || []).length, 0);
  const i = (cat.domains || []).reduce((n, x) => n + (x.groups || []).reduce((m, y) => m + (y.items || []).length, 0), 0);
  return `${d} domains / ${g} groups / ${i} features, builtAt=${cat.builtAt}`;
}

// ---------------- CLI ----------------
// 在 ego 的 nodejs 里跑：ego-browser nodejs -e "await import('file:///.../yonyou-nav.mjs')" 不传参；
// 直接在 PowerShell 里跑（只查目录，不连浏览器）：
//   node scripts/yonyou-nav.mjs find "预算管控"
//   node scripts/yonyou-nav.mjs catalog

const DEFAULT_CATALOG = join(homedir(), '.browser-ai', 'yonyou-catalog-global.json');

function isMain() {
  if (!process.argv[1]) return false;
  const norm = (p) => p.replace(/\\/g, "/").replace(/^\/([A-Za-z]:)/, "$1").toLowerCase();
  const self = norm(decodeURIComponent(new URL(import.meta.url).pathname));
  const entry = norm(process.argv[1]);
  // 技能目录是 junction：比较 basename 兜底
  return self === entry || self.endsWith("/" + entry.split("/").pop());
}

async function cli() {
  if (!isMain()) return;
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "help";
  const path = argv.find((a) => a.endsWith(".json")) || DEFAULT_CATALOG;
  const cat = await loadCatalog(path);
  if (cmd === "catalog") {
    if (!cat) return console.log(`no catalog at ${path}`);
    console.log(catalogSummary(cat));
    for (const d of cat.domains) console.log(`  [${d.card} / ${d.name}] ${d.groups.map((g) => `${g.name}(${g.items.length})`).join(", ")}`);
    return;
  }
  if (cmd === "find") {
    const q = argv[1];
    if (!cat) return console.log(`no catalog at ${path}; run --build first`);
    for (const h of search(cat, q)) console.log(`${h.score}\t${h.card} / ${h.domain} / ${h.group} / ${h.item}`);
    return;
  }
  if (cmd === "goto") {
    const q = argv[1];
    const spaceName = (argv.find((a) => a.startsWith("--space=")) || "").split("=")[1] || "default";
    const pageName = (argv.find((a) => a.startsWith("--page=")) || "").split("=")[1] || "p1";
    if (typeof taskSpace !== "function") return console.log("goto 只能在 ego 的 nodejs 里跑：ego-browser nodejs -e \"...\"");
    const space = await taskSpace(spaceName);
    const p = space.page(pageName);
    const r = await gotoFeature(p, q, { catalog: cat });
    console.log("clicked", JSON.stringify(r.path));
    return;
  }
  console.log('usage: yonyou-nav.mjs catalog | find "<name>" | goto "<name>" --page=p1   [--catalog=path.json]');
}

await cli();
