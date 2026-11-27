'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function sessionSearch() {
  const home = os.homedir();
  const codex = process.env.CODEX_HOME || path.join(home, '.codex');
  const claude = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const roots = [];
  function add(client, directory) {
    roots.push({ client, path: path.resolve(directory) });
  }
  for (const name of ['sessions', 'archived_sessions']) add('Codex', path.join(codex, name));
  const buddy = process.env.YONCLAW_YONBUDDY_HOME || (process.env.APPDATA &&
    path.join(process.env.APPDATA, 'yonyou-bridge', 'codex-home'));
  if (buddy) {
    for (const name of ['sessions', 'archived_sessions']) add('YonBuddy', path.join(buddy, name));
  }
  add('Claude Code', path.join(claude, 'projects'));
  add('DSH', process.env.DSH_SESSIONS_ROOT || path.join(home, '.dsh', 'sessions'));
  return { roots, instructions: 'Start with sessionSource.path. If missing or moved, actively search the matching client root and its subdirectories by session ID, then by run ID, task wording and time. Confirm the original user request and final reply before citing the file and physical lines. These are candidate paths. Read plain JSONL via eval_session_context; use a zstd-capable reader for compressed DSH logs. Record the evidence gap if no matching session is found.' };
}
const { createInterface } = require('node:readline');

// A page carries at most 64 KiB of sampled log text, including very large tool outputs.
async function sessionContext({ path: filename, startLine = 1, limit = 10 }) {
  if (!path.isAbsolute(filename) || !/\.jsonl$/i.test(filename)) {
    throw Object.assign(new Error('Supply the absolute path of a local JSONL session log.'), { code: 'EVAL_LOG_PATH' });
  }
  const file = await fs.open(filename);
  const records = [];
  let remaining = 65536;
  let truncated = false;
  let nextLine = null;
  try {
    if (!(await file.stat()).isFile()) throw new Error('The session log must be a regular file.');
    const stream = file.createReadStream({ encoding: 'utf8', autoClose: false });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      let line = 0;
      for await (const raw of lines) {
        if (++line < startLine) continue;
        if (records.length >= limit || (records.length && Buffer.byteLength(raw) > remaining)) {
          nextLine = line;
          break;
        }
        const size = Buffer.byteLength(raw);
        if (size > remaining) {
          records.push({ line, record: null, preview: Buffer.from(raw).subarray(0, remaining).toString('utf8'), truncated: true });
          truncated = true;
        } else {
          try {
            records.push({ line, record: JSON.parse(line === 1 ? raw.replace(/^\uFEFF/, '') : raw) });
          } catch {
            records.push({ line, record: null, error: 'INVALID_JSON' });
          }
        }
        remaining -= Math.min(size, remaining);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  } finally {
    await file.close();
  }
  return { path: filename, startLine, records, nextLine, truncated };
}

module.exports = { sessionContext, sessionSearch };
