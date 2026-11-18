'use strict';

// Observations retain their provenance. A nearby event is never causal proof.
const SCOPE = ['sessionId', 'tabId', 'frameId', 'documentId'];
const scopeOf = event => Object.fromEntries(SCOPE.filter(key => event[key] !== undefined).map(key => [key, event[key]]));
const scopeKey = event => JSON.stringify(SCOPE.map(key => event[key] ?? null));
const source = event => ({ eventId: event.eventId || event.id || null, cursor: event.cursor ?? null,
  sessionId: event.sessionId ?? null, seq: event.seq ?? null });
const timeOf = event => Number.isFinite(Number(event.t)) ? Number(event.t) : null;
const replayOf = event => event.replay || event.params?.replay || null;
const eventKey = (event, index) => event.eventId || event.id || `cursor:${event.cursor ?? index}`;
const ordered = events => [...events].filter(event => event && typeof event === 'object').sort((a, b) =>
  (a.cursor ?? Infinity) - (b.cursor ?? Infinity) || (timeOf(a) ?? 0) - (timeOf(b) ?? 0));
const unique = values => [...new Set(values)];
const isDOM = event => event.type === 'dom-change' || event.type === 'domChange' || event.kind === 'dom-change';
const isNet = event => event.kind === 'net' || !!event.netType || !!event.requestId && !isDOM(event);
const isAction = event => !isNet(event) && !isDOM(event) &&
  (event.type === 'action-start' || !!replayOf(event) ||
    ['click', 'dblclick', 'input', 'change', 'keydown', 'keyup', 'submit', 'select', 'scroll', 'focus', 'blur', 'pointerdown'].includes(event.type));
function commonScope(events) {
  return Object.fromEntries(SCOPE.filter(key => events.length && events.every(event => event[key] === events[0][key]) &&
    events[0][key] !== undefined).map(key => [key, events[0][key]]));
}

function buildTrace(events = [], options = {}) {
  const rows = ordered(events), actions = [], network = [], dom = [], links = [];
  const actionGroups = new Map(), netGroups = new Map();
  rows.forEach((event, index) => {
    if (isAction(event)) {
      const identity = event.actionId || event.commandId || eventKey(event, index);
      const key = scopeKey(event) + ':' + identity;
      let action = actionGroups.get(key);
      if (!action) {
        action = { id: `action:${actions.length + 1}`, ...scopeOf(event), t: timeOf(event), actor: event.actor,
          actionId: event.actionId, commandId: event.commandId, traceId: event.traceId,
          action: replayOf(event)?.action || event.action || event.type, replay: replayOf(event),
          _replayTime: replayOf(event) ? timeOf(event) : null,
          _authoritativeReplay: event.type === 'action-start' && !!replayOf(event), evidence: [] };
        actions.push(action); actionGroups.set(key, action);
      }
      action.evidence.push(source(event));
      action.commandId ||= event.commandId; action.traceId ||= event.traceId;
      if (event.type === 'action-start' && replayOf(event)) {
        action.replay = replayOf(event); action.action = action.replay.action; action.actor = event.actor;
        action._authoritativeReplay = true; action._replayTime = timeOf(event); action.t = timeOf(event) ?? action.t;
      } else if (!action._authoritativeReplay && replayOf(event) &&
          (!action.replay || event.actor === 'user' && (timeOf(event) ?? -Infinity) >= (action._replayTime ?? -Infinity))) {
        action.replay = replayOf(event); action.action = action.replay.action;
        action._replayTime = timeOf(event); action.t = timeOf(event) ?? action.t;
      }
      return;
    }
    if (isDOM(event)) {
      dom.push({ id: `dom:${dom.length + 1}`, ...scopeOf(event), t: timeOf(event), type: 'dom-change',
        css: event.css || event.selector, summary: event.summary || event.changes || event.counts || null,
        requestId: event.association?.requestId || event.requestId || null,
        networkSource: event.association?.networkSource || event.networkSource || null,
        associationKind: event.association?.kind || null,
        evidence: [source(event)], _events: [event] });
      return;
    }
    if (isNet(event)) {
      const src = event.src || event.source || 'unknown';
      const key = scopeKey(event) + ':' + src + ':' + (event.requestId || eventKey(event, index));
      let request = netGroups.get(key);
      if (!request) {
        request = { id: `network:${network.length + 1}`, ...scopeOf(event), source: src,
          requestId: event.requestId || null, t: timeOf(event), method: event.method || null,
          url: event.url || null, statuses: [], phases: [], evidence: [], captureGaps: [], _events: [] };
        network.push(request); netGroups.set(key, request);
      }
      request.method ||= event.method || null; request.url ||= event.url || null;
      if (Number.isFinite(event.status)) request.statuses = unique([...request.statuses, event.status]);
      request.phases = unique([...request.phases, event.netType || event.type || event.kind]);
      for (const key of ['truncated', 'captureSkipped', 'captureError', 'error', 'sourceGap']) {
        if (event[key]) request.captureGaps.push({ kind: key, detail: event[key], evidence: source(event) });
      }
      request.evidence.push(source(event)); request._events.push(event);
    }
  });
  // Debounced input delivery can follow a later click's cursor. Semantic action
  // order follows capture time, while evidence retains journal order and cursors.
  actions.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity) ||
    (a.evidence[0]?.cursor ?? Infinity) - (b.evidence[0]?.cursor ?? Infinity));
  const configuredWindow = Number(options.windowMs ?? 5000);
  const windowMs = Number.isFinite(configuredWindow) && configuredWindow >= 0 ? configuredWindow : 5000;
  const gaps = [...(options.gaps || [])], scopes = new Map();
  const lowerBound = (items, value, get = item => item) => {
    let low = 0, high = items.length;
    while (low < high) { const mid = (low + high) >>> 1; if (get(items[mid]) < value) low = mid + 1; else high = mid; }
    return low;
  };
  for (const action of actions) {
    const key = scopeKey(action);
    if (!scopes.has(key)) scopes.set(key, { timed: [], commands: new Map(), ids: new Map() });
    scopes.get(key).timed.push(action);
  }
  for (const scope of scopes.values()) {
    scope.timed.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));
    scope.timed.forEach((action, position) => {
      action._position = position;
      if (action.commandId) {
        if (!scope.commands.has(action.commandId)) scope.commands.set(action.commandId, []);
        scope.commands.get(action.commandId).push(action);
      }
      if (action.actionId) scope.ids.set(action.actionId, action);
    });
  }
  const MAX_NODE_LINKS = 32, MAX_LINKS = 20000;
  for (const node of [...network, ...dom]) {
    const precedingNetwork = node.type === 'dom-change' && node.requestId && node.networkSource &&
      node.associationKind === 'temporal-candidate' ?
      netGroups.get(scopeKey(node) + ':' + node.networkSource + ':' + node.requestId) : null;
    const scope = scopes.get(scopeKey(node)), ranges = [], commands = new Set(), ids = new Set();
    let contextOmitted = 0;
    if (scope) for (const event of node._events) {
      const temporal = event.association?.kind === 'temporal-candidate';
      const directCommand = !temporal && event.commandId && scope.commands.has(event.commandId);
      const directAction = !temporal && event.actionId && scope.ids.has(event.actionId);
      if (directCommand) commands.add(event.commandId);
      if (directAction) ids.add(event.actionId);
      if (directCommand || directAction) continue;
      const t = timeOf(event);
      if (t !== null) {
        const start = lowerBound(scope.timed, t - windowMs, action => action.t ?? Infinity);
        const end = lowerBound(scope.timed, t + Number.EPSILON * Math.max(1, Math.abs(t)), action => action.t ?? Infinity);
        if (end > start) ranges.push([start, end]);
      }
      const context = event.association || event.actionContext;
      if (context?.actionId && scope.ids.has(context.actionId)) {
        const position = scope.ids.get(context.actionId)._position; ranges.push([position, position + 1]);
      } else if (context?.commandId && scope.commands.has(context.commandId)) {
        const matches = scope.commands.get(context.commandId);
        for (const action of matches.slice(0, MAX_NODE_LINKS)) ranges.push([action._position, action._position + 1]);
        contextOmitted += Math.max(0, matches.length - MAX_NODE_LINKS);
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    const inRanges = position => {
      const index = lowerBound(merged, position + 1, range => range[0]) - 1;
      return index >= 0 && position < merged[index][1];
    };
    const temporalCount = merged.reduce((sum, range) => sum + range[1] - range[0], 0);
    const selected = action => commands.has(action.commandId) || ids.has(action.actionId);
    const extraActions = scope ? [...ids].map(id => scope.ids.get(id)).filter(action => !commands.has(action.commandId)) : [];
    let explicitCount = extraActions.length;
    for (const command of commands) explicitCount += scope.commands.get(command).length;
    // Count common members with binary searches; bound work for adversarial split histories.
    let overlap = 0;
    const exact = commands.size * merged.length + extraActions.length <= 4096;
    if (exact) {
      for (const command of commands) for (const [start, end] of merged) {
        const matches = scope.commands.get(command);
        overlap += lowerBound(matches, end, action => action._position) - lowerBound(matches, start, action => action._position);
      }
      for (const action of extraActions) if (inRanges(action._position)) overlap++;
    }
    const candidateCount = explicitCount + temporalCount - overlap;
    const reserve = precedingNetwork ? 1 : 0;
    const limit = Math.min(MAX_NODE_LINKS - reserve, Math.max(0, MAX_LINKS - links.length - reserve));
    const retained = [];
    for (const command of commands) {
      for (const action of scope.commands.get(command).slice(0, limit - retained.length)) retained.push({ action, kind: 'explicit', basis: 'commandId' });
      if (retained.length >= limit) break;
    }
    for (const action of extraActions.slice(0, Math.max(0, limit - retained.length))) retained.push({ action, kind: 'explicit', basis: 'actionId' });
    if (scope && retained.length < limit) for (const [start, end] of merged) {
      for (let position = start; position < end && retained.length < limit; position++) {
        const action = scope.timed[position];
        if (!selected(action)) retained.push({ action, kind: 'temporal-candidate', basis: 'same-scope-time-window-or-context' });
      }
      if (retained.length >= limit) break;
    }
    const ambiguity = candidateCount > 1 || contextOmitted > 0;
    node.correlation = { candidateActionCount: candidateCount, countKind: exact ? 'exact' : 'upper-bound',
      explicitCount, temporalCount, retainedLinks: retained.length, omittedLinks: Math.max(0, candidateCount - retained.length),
      ...(contextOmitted ? { omittedContextMatches: contextOmitted } : {}) };
    for (const { action, kind, basis } of retained) links.push({ from: action.id, to: node.id, kind, basis,
      ...(kind === 'temporal-candidate' ? { windowMs } : {}), ambiguous: ambiguity,
      candidateActionCount: candidateCount, candidateCountKind: node.correlation.countKind,
      candidateActionIds: retained.map(item => item.action.id), causal: false,
      evidence: [...action.evidence.slice(0, 8), ...node.evidence.slice(0, 8)],
      evidenceOmitted: Math.max(0, action.evidence.length - 8) + Math.max(0, node.evidence.length - 8) });
    if (precedingNetwork) {
      if (links.length < MAX_LINKS) {
        links.push({ from: precedingNetwork.id, to: node.id, kind: 'temporal-candidate',
          basis: 'same-scope-source-requestId', requestId: node.requestId, networkSource: node.networkSource,
          causal: false, ambiguous: ambiguity,
          evidence: [...precedingNetwork.evidence.slice(0, 8), ...node.evidence.slice(0, 8)],
          evidenceOmitted: Math.max(0, precedingNetwork.evidence.length - 8) + Math.max(0, node.evidence.length - 8) });
        node.correlation.networkLinks = 1;
      } else gaps.push({ kind: 'network-dom-correlation-truncated', nodeId: node.id,
        networkId: precedingNetwork.id, totalLimit: MAX_LINKS });
    }
    if (node.correlation.omittedLinks || contextOmitted || !exact) gaps.push({ kind: 'correlation-truncated',
      nodeId: node.id, ...node.correlation, perNodeLimit: MAX_NODE_LINKS, totalLimit: MAX_LINKS });
    delete node._events;
  }
  for (const action of actions) { delete action._position; delete action._replayTime; delete action._authoritativeReplay; }
  return { version: '0.6', state: 'observed', scope: options.scope || commonScope(rows), windowMs,
    actions, network, dom, links, gaps, evidence: rows.map(source),
    limitations: ['Temporal links are candidates; explicit IDs describe attribution, not causality.',
      'HTTP status and DOM changes do not establish business success.'] };
}

function shapeOf(value, depth = 0) {
  if (value === null) return { type: 'null' };
  if (value === undefined) return { type: 'unobserved' };
  if (typeof value === 'string') {
    if (value.length <= 262144) {
      try { return { format: 'json', ...shapeOf(JSON.parse(value), depth + 1) }; } catch (_) {}
    }
    return { type: 'string' };
  }
  if (depth >= 5) return { type: Array.isArray(value) ? 'array' : typeof value, bounded: true };
  if (Array.isArray(value)) return { type: 'array', items: unique(value.slice(0, 10).map(item => JSON.stringify(shapeOf(item, depth + 1)))).map(item => JSON.parse(item)) };
  if (typeof value === 'object') return { type: 'object', properties: Object.fromEntries(Object.keys(value).slice(0, 40).sort().map(key => [key, shapeOf(value[key], depth + 1)])),
    ...(Object.keys(value).length > 40 ? { bounded: true } : {}) };
  return { type: typeof value };
}

function discoverAPI(events = [], options = {}) {
  const rows = ordered(events), groups = new Map(), unresolved = [];
  const networkRows = rows.filter(isNet), metadata = new Map();
  const requestKey = event => scopeKey(event) + ':' + (event.src || event.source || 'unknown') + ':' + event.requestId;
  for (const event of networkRows) if (event.requestId) {
    const previous = metadata.get(requestKey(event)) || {};
    metadata.set(requestKey(event), { method: previous.method || event.method, url: previous.url || event.url,
      pageURL: previous.pageURL || event.pageURL || event.documentURL || event.frameUrl });
  }
  for (const original of networkRows) {
    const inherited = original.requestId ? metadata.get(requestKey(original)) : {};
    const event = { ...inherited, ...original };
    let url;
    try { url = new URL(event.url, event.pageURL || event.documentURL || event.frameUrl || options.baseURL); }
    catch (_) { unresolved.push(source(event)); continue; }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    const method = event.method ? String(event.method).toUpperCase() : null, key = `${method || 'UNKNOWN'} ${url.origin}${url.pathname}`;
    if (!groups.has(key)) groups.set(key, { id: key, method, origin: url.origin, pathname: url.pathname,
      state: 'observed', sources: [], statuses: [], queryKeys: [], requestShapes: [], responseShapes: [], evidence: [], captureGaps: [] });
    const api = groups.get(key);
    api.sources = unique([...api.sources, event.src || event.source || 'unknown']);
    api.queryKeys = unique([...api.queryKeys, ...url.searchParams.keys()]).sort();
    if (Number.isFinite(event.status)) api.statuses = unique([...api.statuses, event.status]).sort((a, b) => a - b);
    for (const [fields, output] of [[['reqBody', 'requestBody', 'body'], 'requestShapes'], [['resBody', 'responseBody'], 'responseShapes']]) {
      for (const field of fields) if (event[field] !== undefined && event[field] !== null) {
        const responseBody = field === 'body' && /response|body/.test(event.type || event.netType || '') && !/request/.test(event.type || event.netType || '');
        const destination = responseBody ? 'responseShapes' : output;
        const shape = shapeOf(event[field]);
        if (!api[destination].some(existing => JSON.stringify(existing) === JSON.stringify(shape))) api[destination].push(shape);
      }
    }
    for (const name of ['truncated', 'captureSkipped', 'captureError', 'sourceGap']) if (event[name]) api.captureGaps.push({ kind: name, evidence: source(event) });
    api.evidence.push(source(event));
  }
  return { version: '0.6', state: 'observed', scope: options.scope || commonScope(rows),
    endpoints: [...groups.values()], unresolved, gaps: options.gaps || [],
    limitations: ['Only observed methods, paths and payload shapes are listed.', 'No API is executed; status codes do not establish business success.'] };
}

module.exports = { buildTrace, discoverAPI };
