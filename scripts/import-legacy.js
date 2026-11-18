#!/usr/bin/env node
'use strict';

const { Store } = require('../src/storage');

function importLegacy({ from, dataDir }) {
  if (typeof from !== 'string' || !from || typeof dataDir !== 'string' || !dataDir) throw Object.assign(new Error('Both --from DIR and --data-dir DIR are required'), { code: 'INVALID_ARGUMENTS' });
  const store = new Store(dataDir);
  try { return store.importLegacy(from); }
  finally { store.close(); }
}

function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help' || argv[index] === '-h') {
      process.stdout.write('Usage: node scripts/import-legacy.js --from LEGACY_DATA_DIR --data-dir MCP_DATA_DIR\n');
      return;
    }
    const key = argv[index] === '--from' ? 'from' : argv[index] === '--data-dir' ? 'dataDir' : null;
    if (!key || !argv[index + 1] || argv[index + 1].startsWith('--') || options[key] !== undefined) throw Object.assign(new Error(`Invalid or duplicate argument: ${argv[index]}`), { code: 'INVALID_ARGUMENTS' });
    options[key] = argv[++index];
  }
  const result = importLegacy(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.imported && !result.alreadyImported) process.exitCode = 2;
  return result;
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message, code: error.code || 'IMPORT_FAILED', ...(error.file ? { file: error.file } : {}), ...(error.line ? { line: error.line } : {}) })}\n`); process.exitCode = 1; }
}

module.exports = { importLegacy, main };
