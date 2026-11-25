'use strict';

const path = require('node:path');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

// Ego can keep imported workflows alive across MCP connections.
function scriptUrl(name, dependencies = []) {
  const directory = path.join(__dirname, '../scripts');
  const hash = createHash('sha256');
  for (const file of [name, ...dependencies]) hash.update(readFileSync(path.join(directory, file)));
  const url = pathToFileURL(path.join(directory, name));
  url.searchParams.set('revision', hash.digest('hex').slice(0, 16));
  return url.href;
}

module.exports = { workbenchScript: scriptUrl('asp-workbench.mjs'),
  billQueryScript: scriptUrl('asp-bill-query.mjs', ['asp-workbench.mjs']),
  templateScript: scriptUrl('asp-template.mjs', ['asp-workbench.mjs']) };
