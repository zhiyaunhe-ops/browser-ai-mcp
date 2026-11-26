import { cliCode } from "./ego-session-metrics.mjs";

const browserScript = /^(?:asp-(?:workbench|template|bill-query)|ys-(?:page|locate|transfer)|yonyou-(?:nav|view|branch|publish-node)|ego-network)\.mjs$/i;

function* shellEntries(command) {
  let start = 0, quote = "", escaped = false;
  for (let index = 0; index <= command.length; index++) {
    const character = command[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character !== undefined && !"\n;&|".includes(character)) continue;
    const entry = command.slice(start, index).trim();
    start = index + 1;
    if (!entry) continue;
    let body = "";
    const heredoc = /<<(-?)\s*['"]?([A-Za-z_]\w*)['"]?\s*$/.exec(entry);
    if (character === "\n" && heredoc) {
      const lines = command.slice(start).split("\n");
      const end = lines.findIndex(line => (heredoc[1] ? line.trimStart() : line).trimEnd() === heredoc[2]);
      const consumed = (end < 0 ? lines : lines.slice(0, end + 1)).join("\n");
      body = (end < 0 ? lines : lines.slice(0, end)).join("\n");
      index += consumed.length + 1;
      start = index + 1;
    }
    yield { entry, body };
  }
}

export function cliOperations(command, coverage) {
  if (typeof command !== "string") return [];
  const result = [];
  const entries = [...shellEntries(command)];
  for (const { entry, body } of entries) {
    const tokens = entry.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) || [];
    while (tokens.length && /^(?:[A-Za-z_]\w*=|env$|command$|sudo$|nohup$|xvfb-run$)/.test(tokens[0])) tokens.shift();
    const basename = value => (value || "").replace(/^['"]|['"]$/g, "").split(/[/\\]/).pop();
    let executable = basename(tokens.shift()).replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
    if (/^(?:npx|pnpx|bunx)$/.test(executable)) {
      while (tokens[0]?.startsWith("-")) tokens.shift();
      executable = basename(tokens.shift());
    } else if (["npm", "pnpm", "bun", "uvx"].includes(executable) && tokens[0] === "exec") {
      tokens.shift();
      executable = basename(tokens.shift());
    }
    const action = basename(tokens[0]);
    if (tokens.some(token => /^(?:--help|-h|--version|-V)$/.test(token))) continue;
    const add = (operation, code = null) => result.push({ operation, transport: "cli", code, attributable: entries.length === 1 });
    if (executable === "ego-browser" && action && !/^(?:-|skill$|help$|version$|completion$)/.test(action)) {
      add(`ego-browser ${action}`, action === "nodejs" ? cliCode(entry) : null);
    } else if (["playwright", "playwright-cli"].includes(executable) && action && !action.startsWith("-") && action !== "install" && action !== "install-deps") {
      add(`${executable} ${action}`);
    } else if (/^(?:chromium(?:-browser)?|google-chrome(?:-stable)?|chrome|msedge)$/.test(executable)
      && tokens.some(token => /^--(?:headless|remote-debugging(?:-port|-pipe)?)(?:=|$)/.test(token))) {
      add(executable);
    } else if (/^(?:bash|sh|zsh|pwsh)$/.test(executable)) {
      const commandIndex = tokens.findIndex(token => /^(?:-[lix]*c|-command)$/i.test(token));
      const nested = tokens[commandIndex + 1];
      if (commandIndex >= 0 && nested && /^['"]/.test(nested)) result.push(...cliOperations(nested.slice(1, -1), coverage)
        .map(operation => ({ ...operation, attributable: entries.length === 1 && operation.attributable })));
    } else if (/^(?:node|python(?:\d+(?:\.\d+)?)?|py|bun|tsx)$/.test(executable)) {
      if (executable === "node" && browserScript.test(action)) { add(action); continue; }
      const evalIndex = tokens.findIndex(token => /^(?:-e|--eval|-c)$/.test(token));
      const script = body || (evalIndex >= 0 ? tokens[evalIndex + 1] : "") || "";
      const library = /\b(playwright|selenium|puppeteer(?:-core)?|chrome-remote-interface)\b/i.exec(script);
      if (library && (/\b(?:from|import|require)\b/.test(script) || /\b(?:launch|connectOverCDP|connect_over_cdp|webdriver)\b/.test(script))) {
        add(library[1].toLowerCase(), /^[nbt]/.test(executable) ? script.replace(/^['"]|['"]$/g, "") : null);
      } else if (/\b(?:connectOverCDP|connect_over_cdp|newCDPSession|Browser\.getVersion|Target\.getTargets|devtools\/browser)\b/.test(script)) {
        add("CDP", /^[nbt]/.test(executable) ? script.replace(/^['"]|['"]$/g, "") : null);
      } else if (!script && /(?:browser|playwright|selenium|puppeteer|cdp)/i.test(action) && /\.(?:m?js|cjs|py|ts)$/i.test(action)) {
        coverage.uninspectedScriptCommands++;
      }
    }
  }
  return result;
}
