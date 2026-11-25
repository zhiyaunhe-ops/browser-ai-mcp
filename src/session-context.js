'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
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

module.exports = { sessionContext };
