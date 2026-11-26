'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function nodeFromUrl(value) {
  if (!value) return '';
  const url = new URL(value);
  for (const key of ['appcode', 'pagecode', 'nodecode']) {
    const node = url.searchParams.get(key);
    if (node) return node;
  }
  const hash = url.hash.match(/[?&#](?:appcode|pagecode|nodecode)=([^&#]+)/i);
  if (hash) return decodeURIComponent(hash[1]);
  return '';
}

class ScriptCache {
  constructor({ proceduresDir = process.env.BROWSER_AI_PROCEDURES_DIR } = {}) {
    this.proceduresDir = proceduresDir;
  }

  packages() {
    if (!this.proceduresDir) return [];
    return fs.readdirSync(this.proceduresDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
      .flatMap(entry => {
        const directory = path.join(this.proceduresDir, entry.name);
        const skillPath = path.join(directory, 'SKILL.md');
        if (!fs.existsSync(skillPath)) return [];
        const skill = fs.readFileSync(skillPath, 'utf8');
        const frontmatter = skill.match(/^---\r?\n(\{[\s\S]*?\})\r?\n---(?:\r?\n|$)/);
        if (!frontmatter) return [];
        const metadata = JSON.parse(frontmatter[1]);
        const scriptPath = fs.realpathSync(path.resolve(directory, metadata.entry));
        const relative = path.relative(fs.realpathSync(directory), scriptPath);
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
          throw new Error('Script entry must stay within its procedure directory');
        }
        const source = fs.readFileSync(scriptPath, 'utf8');
        const memoPath = path.join(directory, 'MEMO.md');
        const memo = fs.existsSync(memoPath) ? fs.readFileSync(memoPath, 'utf8').trim() : '';
        const hash = crypto.createHash('sha256').update(skill).update('\0').update(source);
        if (memo) hash.update('\0').update(memo);
        const digest = hash.digest('hex');
        const flow = Array.isArray(metadata.flow) ? metadata.flow.join(' → ') : metadata.flow;
        const summary = `${metadata.description} 脚本 ${metadata.version}；产品 ${metadata.productVersion}；节点 ${metadata.node}（${metadata.nodes.join(' / ')}）；流程 ${flow}；入口 ${metadata.entry}。`;
        return [{ ...metadata, digest, summary, source, skill, ...(memo ? { memo } : {}) }];
      });
  }

  match({ goal = '', url, node, productVersion = '' }) {
    const currentNode = node ?? nodeFromUrl(url);
    return this.packages().filter(pkg => {
      const supported = pkg.nodes.some(value => value.toLowerCase() === String(currentNode).toLowerCase());
      if (currentNode && !supported) return false;
      if (productVersion && pkg.productVersion && productVersion !== pkg.productVersion) return false;
      if (!Array.isArray(pkg.goalTerms) || !pkg.goalTerms.length) return false;
      return pkg.goalTerms.every(term => goal.toLowerCase().includes(term.toLowerCase()));
    }).map(({ source, skill, ...metadata }) => metadata);
  }

  load(id) {
    const pkg = this.packages().find(item => item.id === id);
    if (!pkg) throw Object.assign(new Error(`Unknown script package: ${id}`), { code: 'SCRIPT_NOT_FOUND' });
    return pkg;
  }

  code(id, version, digest) {
    const pkg = this.load(id);
    if (pkg.version !== version || digest !== undefined && pkg.digest !== digest) {
      throw Object.assign(new Error('The script package changed; read its current briefing before execution'), {
        code: 'SCRIPT_VERSION_MISMATCH', executionStarted: false
      });
    }
    const source = pkg.source.replace(/^export\s+(?=async\s+function\s+probe\b)/m, '');
    return `// script-cache ${pkg.id}@${pkg.version} sha256:${pkg.digest}\n${source}\nreturn await probe({ task, page, input });\n`;
  }
}

module.exports = { ScriptCache, nodeFromUrl };
