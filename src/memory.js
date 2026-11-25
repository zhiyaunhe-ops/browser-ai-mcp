'use strict';

const crypto = require('node:crypto');

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (code, message, fields = {}) => Object.assign(new Error(message), { code, ...fields });
const RECIPE_FIELDS = new Set(['goal', 'parameters', 'preconditions', 'steps', 'verify', 'traps', 'selectors', 'open', 'read', 'write']);
const PATCH_FIELDS = new Set(['name', 'summary', 'goal', 'task', 'aliases', 'match', 'recipe', 'verification']);

function text(value, field, max = 500, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || required && !value.trim()) throw fail('INVALID_MEMORY', `${field} must be ${required ? 'a nonempty' : 'a'} string of at most ${max} characters`);
  return value.trim();
}

function urlOf(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw fail('INVALID_MEMORY', 'url must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw fail('INVALID_MEMORY', 'url must use HTTP(S)');
  return url;
}

function terms(value) {
  const normalized = String(value).normalize('NFKC').toLowerCase();
  const output = new Set(normalized.match(/[a-z0-9_]+/g) || []);
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    if (run.length === 1) output.add(run);
    for (let index = 0; index + 1 < run.length; index++) output.add(run.slice(index, index + 2));
  }
  return output;
}

function routeMatches(entry, url, dialogTitle) {
  const match = entry.match || {};
  return (match.path === undefined || match.path === url.pathname) &&
    (match.pathPrefix === undefined || url.pathname.startsWith(match.pathPrefix)) &&
    (match.hashPrefix === undefined || url.hash.startsWith(match.hashPrefix)) &&
    (match.dialogTitle === undefined || match.dialogTitle === dialogTitle);
}

function content(value) {
  return typeof value === 'string' ? Boolean(value.trim()) : Array.isArray(value) ? value.length > 0 : plain(value) ? Object.keys(value).length > 0 : Boolean(value);
}

class Memory {
  constructor(store) { this.store = store; }

  pageRules(domain) {
    return this.store.list('memory').filter(entry => entry.scope === 'page' &&
      entry.domain === domain && entry.verification !== 'stale');
  }

  pageMemos(url, dialogTitle) {
    return this.pageRules(url.hostname).filter(entry => routeMatches(entry, url, dialogTitle))
      .map(({ id, name, summary, revision = 0, verification, sourceRunId }) => ({ id, name, summary, revision, verification, sourceRunId }));
  }

  search({ url: value, goal = '', limit = 5 } = {}) {
    const url = urlOf(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw fail('INVALID_MEMORY', 'limit must be 1..10');
    const query = terms(text(goal, 'goal'));
    const candidates = this.store.list('memory').filter(entry => entry.domain === url.hostname).map(entry => {
      const words = terms([entry.key, entry.name, entry.goal, entry.task, entry.summary, ...(entry.aliases || [])].join(' '));
      const overlap = [...query].filter(term => words.has(term)).length;
      const route = routeMatches(entry, url);
      const specificity = Object.values(entry.match || {}).reduce((sum, item) => sum + String(item).length, 0);
      return { entry, route, overlap, score: overlap * 10000 + (route ? 1000 + specificity : 0) + (entry.verification === 'verified' ? 100 : 0) };
    }).filter(item => item.entry.scope === 'domain' || item.route || query.size && item.overlap)
      .sort((a, b) => b.score - a.score || String(b.entry.updatedAt || '').localeCompare(String(a.entry.updatedAt || '')) || a.entry.id.localeCompare(b.entry.id));
    const selected = [...candidates.filter(item => item.entry.scope === 'domain').slice(0, limit), ...candidates.filter(item => item.entry.scope === 'page').slice(0, limit)];
    const compact = item => ({ ...Object.fromEntries(['id', 'key', 'name', 'scope', 'summary', 'verification', 'verificationScope', 'verifiedAt', 'updatedAt', 'match', 'sourceRunId', 'evidenceAvailability']
      .filter(key => item.entry[key] !== undefined).map(key => [key, item.entry[key]])), revision: item.entry.revision ?? 0,
      applicability: item.route ? 'current-route' : 'goal-match-requires-navigation' });
    return clone({ domain: url.hostname, domainRules: selected.filter(item => item.entry.scope === 'domain').map(compact),
      matches: selected.filter(item => item.entry.scope === 'page').map(compact), total: candidates.length, truncated: selected.length < candidates.length });
  }

  get(memoryId) {
    if (typeof memoryId !== 'string' || !memoryId) throw fail('INVALID_MEMORY', 'memoryId is required');
    const entry = this.store.get('memory', memoryId);
    if (!entry) throw fail('NO_SUCH_MEMORY', 'Unknown memory id', { memoryId });
    return entry;
  }

  prepare(input, previous, run, evidenceIds, outcome) {
    if (!plain(input)) throw fail('INVALID_MEMORY', 'memory entry must be an object');
    const url = urlOf(input.url || run.url);
    if (url.hostname !== urlOf(run.url).hostname) throw fail('INVALID_MEMORY', 'Memory must belong to the task URL hostname');
    const scope = input.scope ?? 'page';
    if (!['domain', 'page'].includes(scope)) throw fail('INVALID_MEMORY', 'scope must be domain or page');
    const key = text(input.key, 'key', 160, true);
    const name = text(input.name, 'name', 200, true);
    const summary = text(input.summary, 'summary', 1600, true);
    const goal = text(input.goal ?? input.task, 'goal');
    const aliases = input.aliases === undefined ? [] : input.aliases;
    if (!Array.isArray(aliases) || aliases.length > 30) throw fail('INVALID_MEMORY', 'aliases must be an array of at most 30 strings');
    const match = input.match === undefined ? (scope === 'page' ? { path: url.pathname, ...(url.hash ? { hashPrefix: url.hash } : {}) } : {}) : input.match;
    if (!plain(match) || Object.keys(match).some(field => !['path', 'pathPrefix', 'hashPrefix', 'dialogTitle'].includes(field))) throw fail('INVALID_MEMORY', 'match supports path, pathPrefix, hashPrefix and dialogTitle');
    for (const [field, value] of Object.entries(match)) {
      if (field === 'dialogTitle') {
        if (text(value, 'match.dialogTitle', 200, true) !== value) throw fail('INVALID_MEMORY', 'dialogTitle must be trimmed');
        continue;
      }
      text(value, `match.${field}`, 2000, true);
      if (!value.startsWith(field === 'hashPrefix' ? '#' : '/')) throw fail('INVALID_MEMORY', 'match fields must start with / or #');
    }
    if (match.path !== undefined && match.pathPrefix !== undefined) throw fail('INVALID_MEMORY', 'use path or pathPrefix');
    if (scope === 'domain' && Object.keys(match).length) throw fail('INVALID_MEMORY', 'domain rules cannot contain route restrictions');
    const recipe = input.recipe === undefined ? {} : input.recipe;
    if (!plain(recipe) || Object.keys(recipe).some(field => !RECIPE_FIELDS.has(field))) throw fail('INVALID_MEMORY', 'unsupported recipe field');
    let normalizedRecipe;
    try { normalizedRecipe = clone(recipe); if (!plain(normalizedRecipe)) throw new Error('recipe must remain an object'); }
    catch (_) { throw fail('INVALID_MEMORY', 'recipe must be JSON serializable'); }
    const verification = input.verification ?? 'unverified';
    if (!['unverified', 'verified', 'stale'].includes(verification)) throw fail('INVALID_MEMORY', 'verification must be unverified, verified or stale');
    if (verification === 'verified' && (outcome !== 'succeeded' || !evidenceIds.length || !content(normalizedRecipe.verify))) throw fail('INVALID_MEMORY', 'verified memory requires a succeeded outcome, current evidence and a verification recipe');
    const evidence = [...new Set([...(previous?.evidence || []), ...evidenceIds])];
    const details = { recipe, evidence };
    try { if (JSON.stringify(details).length > 48000) throw fail('INVALID_MEMORY', 'memory details exceed 48000 characters'); }
    catch (error) { if (error.code) throw error; throw fail('INVALID_MEMORY', 'memory details must be JSON serializable'); }
    const now = new Date().toISOString();
    const available = [...new Set([...(previous?.evidenceAvailability?.available || []), ...evidenceIds])];
    const unavailable = (previous?.evidenceAvailability?.unavailable || []).filter(item => !available.includes(item.ref));
    const entry = { ...(previous || {}), id: previous?.id || crypto.randomUUID(), domain: url.hostname, scope, key, name, summary,
      goal, task: goal, aliases: aliases.map(alias => text(alias, 'alias', 160, true)), match: clone(match), recipe: normalizedRecipe, evidence,
      revision: (previous?.revision ?? 0) + 1, verification, verificationScope: verification === 'verified' ? 'mcp' : 'unverified',
      updatedAt: now, sourceRunId: run.runId || run.id,
      evidenceAvailability: { state: available.length ? unavailable.length ? 'partial' : 'available' : 'unavailable', available, unavailable } };
    if (verification === 'verified') entry.verifiedAt = now;
    else delete entry.verifiedAt;
    return entry;
  }

  applyUpdates(run, updates, evidenceIds, outcome) {
    if (!plain(run) || !Array.isArray(updates) || updates.length > 10 || !Array.isArray(evidenceIds) || evidenceIds.some(id => typeof id !== 'string' || !id)) throw fail('INVALID_MEMORY', 'updates and evidenceIds must be arrays; at most 10 updates are supported');
    if (!['succeeded', 'failed', 'cancelled', 'unknown', 'outcome_unknown'].includes(outcome)) throw fail('INVALID_MEMORY', 'invalid memory outcome');
    if (['unknown', 'outcome_unknown'].includes(outcome) && updates.length) throw fail('INVALID_MEMORY', 'Resolve an unknown outcome before changing reusable memory');
    const changed = [];
    for (const update of updates) {
      if (!plain(update)) throw fail('INVALID_MEMORY', 'update must be an object');
      let previous, input;
      if (update.memoryId !== undefined) {
        previous = this.get(update.memoryId);
        if (!plain(update.patch) || Object.keys(update.patch).some(field => !PATCH_FIELDS.has(field))) throw fail('INVALID_MEMORY', 'patch may only change editable memory fields');
        if (update.patch.recipe !== undefined && !plain(update.patch.recipe)) throw fail('INVALID_MEMORY', 'patch.recipe must be an object');
        input = { ...previous, ...update.patch, url: `https://${previous.domain}${previous.match?.path || '/'}`,
          recipe: { ...(previous.recipe || {}), ...(update.patch.recipe || {}) }, verification: update.patch.verification ?? 'unverified' };
      } else {
        if (!plain(update.entry)) throw fail('INVALID_MEMORY', 'new memory requires an entry');
        input = { ...update.entry, url: update.entry.url || run.url };
        const url = urlOf(input.url);
        previous = this.store.list('memory').find(entry => entry.domain === url.hostname && entry.scope === (input.scope ?? 'page') && entry.key === input.key);
      }
      const revision = previous?.revision ?? 0;
      if (!Number.isSafeInteger(update.baseRevision) || update.baseRevision < 0 || update.baseRevision !== revision) throw fail('MEMORY_REVISION_CONFLICT', 'Retrieve the current memory revision before applying changes', { currentRevision: revision, ...(previous ? { memoryId: previous.id } : {}) });
      const entry = this.prepare(input, previous, run, evidenceIds, outcome);
      if (previous && (entry.domain !== previous.domain || entry.scope !== previous.scope || entry.key !== previous.key)) throw fail('INVALID_MEMORY', 'corrections must preserve the domain, scope and logical key');
      if (!previous && this.store.list('memory').length >= 2000) throw fail('MEMORY_CAPACITY', 'Memory is limited to 2000 entries');
      this.store.put('memory', entry.id, entry);
      changed.push(entry.id);
    }
    return changed;
  }
}

module.exports = { Memory, terms };
