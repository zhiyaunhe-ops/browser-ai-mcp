// 用友部署分支判定：先按域名给先验，再用 DOM 复核。
// 规则来源：references/yonyou-domain.md §1.1（2026-11-07 环境约定）
//
// 用法一（ego 程序里）：
//   import { branchFromHost, probeBranch } from "file:///.../scripts/yonyou-branch.mjs";
//   const prior = branchFromHost("https://global.yonyoucloud.com/");
//   const live = await probeBranch(page);   // { nlf, mdf, iframes, branch }
//
// 用法二（命令行，只看先验）：
//   node scripts/yonyou-branch.mjs https://global.yonyoucloud.com/

export function branchFromHost(input) {
  let host;
  try {
    host = new URL(input).hostname;
  } catch {
    host = String(input).split("/")[0];
  }
  if (host === "global.yonyoucloud.com") return { host, branch: "bip-cloud", why: "旗舰版公有云（mdf/wui SPA）" };
  if (/^c\d+\.yonyoucloud\.com$/.test(host)) return { host, branch: "iuap-c", why: "旗舰版 / 超级版 SaaS（iuap-c-* 那套）" };
  return { host, branch: "nccloud", why: "其余域名按高级版 / NC Cloud 先验" };
}

// DOM 复核：冲突时以这里的 branch 为准。page 是 ego 的 Page。
export async function probeBranch(page) {
  const signals = await page.evaluate(() => ({
    nlf: typeof window["nc-lightapp-front"],
    mdf: !!document.querySelector("[class*=mdf-]"),
    iframes: document.querySelectorAll("iframe").length,
  }));
  const branch = signals.nlf === "object" ? "nccloud" : signals.mdf && signals.iframes === 0 ? "bip-cloud" : "unknown";
  return { ...signals, branch };
}

export const REFERENCE = {
  "bip-cloud": "references/yonyou-bip-cloud.md",
  "iuap-c": "references/yonyou-bip-cloud.md §1（c4 行）→ iuap-c 系资料",
  nccloud: "references/yonyou-domain.md §2（L0–L4）",
  unknown: "先看 iframe 层数、脚本来源，再回到 §1 判域",
};

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 技能目录常是 junction（.dsh\skills\browser-ai → .skills-manager\...），
// import.meta.url 给真实路径、argv[1] 给逻辑路径，所以要用 realpath 比。
function isMainModule() {
  try {
    return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/yonyou-branch.mjs <url>");
    process.exit(1);
  }
  const prior = branchFromHost(target);
  console.log(JSON.stringify({ ...prior, then: "进场后用 probeBranch(page) 复核；DOM 与先验冲突时以 DOM 为准", reference: REFERENCE[prior.branch] }, null, 2));
}
