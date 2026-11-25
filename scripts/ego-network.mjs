// Collect structure from page-scoped CDP events. Raw events stay in the Ego round.
const REQUEST_LIMIT = 128;
const BODY_LIMIT = 65536;
const STRUCTURE_LIMIT = 96;
const SOURCE = 'ego-page';

function safeName(name) {
  return /^[a-z_$][a-z0-9_$.[\]-]{0,63}$/i.test(name) &&
    !/\d{5}|[a-f\d]{16}|[a-z\d]{32}/i.test(name);
}

function safePath(pathname) {
  return pathname.replace(/[^/]+/g, (segment, offset) => {
    const previous = pathname.slice(0, offset - 1).split('/').at(-1);
    if (/^(?:tokens?|session(?:id)?|secrets?|password|credentials?|invite|reset)$/i.test(previous)) return ':value';
    if (/^(?:customers?|clients?|accounts?|contacts?|employees?|users?|people|partners?|vendors?|suppliers?|members?|orders?|invoices?)$/i.test(previous) &&
        !/^(?:list|search|create|find|query|details?|update|delete|export|import|batch|count|validate|metadata|schema)$/i.test(segment)) return ':value';
    if (/^v\d{1,3}$/i.test(segment)) return segment;
    const operation = /^(?:get|list|find|search|query|create|save|update|delete|load)(?:[A-Z][a-z]{2,}){2,}$/.test(segment);
    return /^[a-z][a-z0-9_.-]{0,63}$/i.test(segment) &&
      (operation || !/\d{3}|[a-f\d]{12}|[a-z\d]{24}/i.test(segment)) &&
      !/^[a-z]+[-_.]?\d+$/i.test(segment) ? segment : ':value';
  });
}

function requestShape(request) {
  if (request.postData === undefined) {
    return request.hasPostData ? { captureSkipped: 'request-body-not-in-event' } : {};
  }
  const body = request.postData;
  if (typeof body !== 'string') return { captureSkipped: 'request-body-not-in-event' };
  const contentType = Object.entries(request.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
  const maxDepth = body.length > BODY_LIMIT ? 1 : 5;
  let remaining = STRUCTURE_LIMIT;
  let bounded = false;
  function fields(keys, getShape) {
    const result = [];
    for (const name of new Set(keys)) {
      if (!safeName(name) || remaining <= 0) { bounded = true; continue; }
      remaining--;
      result.push([name, getShape(name)]);
    }
    return Object.fromEntries(result);
  }
  function shape(value, depth = 0) {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (type === 'string' && depth < maxDepth && value.length <= BODY_LIMIT && /^\s*[\[{]/.test(value)) {
      try { return { encoding: 'json-string', ...shape(JSON.parse(value), depth + 1) }; }
      catch { /* A string can resemble JSON without containing a complete value. */ }
    }
    if (!['array', 'object'].includes(type)) return { type };
    if (depth >= maxDepth) { bounded = true; return { type }; }
    if (type === 'object') return { type, properties: fields(Object.keys(value), key => shape(value[key], depth + 1)) };
    if (value.length > 8) bounded = true;
    const items = value.slice(0, 8).map(item => JSON.stringify(shape(item, depth + 1)));
    return { type, items: [...new Set(items)].map(item => JSON.parse(item)) };
  }
  let result;
  if (/(?:\/|\+)json\b/i.test(contentType) || /^\s*[\[{]/.test(body)) {
    try { result = { format: 'json', ...shape(JSON.parse(body)) }; }
    catch { return { captureSkipped: 'request-json-incomplete' }; }
  } else if (body.length > BODY_LIMIT) {
    return { truncated: 'request-body-limit' };
  } else if (/application\/x-www-form-urlencoded\b/i.test(contentType)) {
    result = { format: 'form-urlencoded', type: 'object',
      properties: fields(new URLSearchParams(body).keys(), () => ({ type: 'string' })) };
  } else if (/multipart\/form-data\b/i.test(contentType)) {
    // Field names come only from each part's header, never from part contents.
    const boundary = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    if (!boundary) return { captureSkipped: 'multipart-boundary-unavailable' };
    const delimiter = '--' + (boundary[1] || boundary[2]);
    const parts = body.split('\r\n' + delimiter);
    if (!parts[0]?.startsWith(delimiter) || parts.at(-1).trim() !== '--') {
      return { captureSkipped: 'request-multipart-incomplete' };
    }
    const names = new Map();
    for (const part of parts.slice(0, -1)) {
      const header = part.slice(0, part.indexOf('\r\n\r\n'));
      const disposition = /(?:^|\r\n)Content-Disposition:\s*form-data([^\r\n]*)/i.exec(header)?.[1] || '';
      const name = /;\s*name="([^"]+)"/i.exec(disposition)?.[1];
      if (name) names.set(name, { type: /;\s*filename\*?=/i.test(disposition) ? 'file' : 'string' });
    }
    result = { format: 'multipart', type: 'object', properties: fields(names.keys(), key => names.get(key)) };
  } else return { captureSkipped: 'request-body-format-not-captured' };
  return { requestShape: result, ...(bounded ? { truncated: 'request-shape-limit-or-omitted-keys' } : {}) };
}

export function createNetworkCapture(executionId, startedAt = Date.now()) {
  const pages = new Map();
  const records = [];
  const gaps = [];
  let capturedRequests = 0;
  let overflow = false;
  let finished = false;

  function addGap(kind, pageLabel) {
    if (!gaps.some(gap => gap.kind === kind && gap.pageLabel === pageLabel)) gaps.push({ kind, pageLabel });
  }

  function track(page, label, readEvents = () => page.events()) {
    if (finished || !page || pages.has(label)) return;
    pages.set(label, { readEvents, active: new Map(), drained: false, sawNetwork: false });
  }

  function response(request, status, timestamp) {
    if (request.responded || !Number.isFinite(status)) return;
    request.responded = true;
    const { requestShape, truncated, captureSkipped, ...identity } = request.record;
    const elapsed = timestamp - request.timestamp;
    records.push({ ...identity, netType: 'response', status, t: Number.isFinite(elapsed) ? identity.t + elapsed * 1000 : identity.t });
  }

  function accept(label, events) {
    const state = pages.get(label);
    if (finished || !state || !Array.isArray(events)) return;
    state.drained = true;
    if (events.length >= 10000) addGap('network-event-buffer-limit', label);
    for (const { method, params } of events) {
      if (!method?.startsWith('Network.')) continue;
      state.sawNetwork = true;
      if (!params?.requestId) continue;
      const id = params.requestId;
      const request = state.active.get(id);
      if (method === 'Network.responseReceived' && request) response(request, params.response.status, params.timestamp);
      if (method === 'Network.loadingFailed' && request) request.record.sourceGap = 'request-failed';
      if (method !== 'Network.requestWillBeSent') continue;
      if (request && params.redirectResponse) response(request, params.redirectResponse.status, params.timestamp);
      state.active.delete(id);
      if (!['Fetch', 'XHR'].includes(params.type)) continue;
      const t = params.wallTime * 1000;
      if (!Number.isFinite(t)) { addGap('network-request-time-unavailable', label); continue; }
      if (t < startedAt) continue;
      const url = URL.parse(params.request.url);
      if (!url || !['http:', 'https:'].includes(url.protocol)) continue;
      // Skip identifiable analytics and authentication traffic.
      if (/\/(?:analytics|telemetry|oauth2?|saml2?|login|logout|token)(?:\/|$)/i.test(url.pathname)) continue;
      if (capturedRequests >= REQUEST_LIMIT) { overflow = true; continue; }
      const keys = [...new Set(url.searchParams.keys())];
      const queryKeys = keys.filter(safeName).slice(0, 40).sort();
      const omittedKeys = queryKeys.length < keys.length;
      if (omittedKeys) addGap('query-key-limit-or-omitted-keys', label);
      const record = { src: SOURCE, netType: 'request', requestId: `${executionId}:${++capturedRequests}`,
        tabId: label, resourceType: params.type, method: params.request.method,
        url: url.origin + safePath(url.pathname), queryKeys, t, ...requestShape(params.request),
        ...(request && params.redirectResponse ? { redirectedFromRequestId: request.record.requestId } : {}),
        ...(omittedKeys ? { sourceGap: 'query-key-limit-or-omitted-keys' } : {}) };
      state.active.set(id, { record, timestamp: params.timestamp, responded: false });
      records.push(record);
    }
  }

  async function drain(readEvents, label) {
    try { accept(label, await readEvents()); }
    catch { if (!finished) addGap('network-page-events-unavailable', label); }
  }

  async function finish() {
    // Ego's public API drains one Page session. Drain after the caller's code so
    // page.events() inside that code still returns the batch it would normally see.
    const timeout = Symbol('network-drain-timeout');
    await Promise.all([...pages].map(async ([label, state]) => {
      let timer;
      const expired = new Promise(resolve => { timer = setTimeout(resolve, 500, timeout); });
      const result = await Promise.race([drain(state.readEvents, label), expired]);
      clearTimeout(timer);
      if (result === timeout) addGap('network-final-drain-timeout', label);
    }));
    finished = true;
    if (overflow) addGap('network-request-limit');
    for (const [label, state] of pages) {
      if (state.drained && !state.sawNetwork) addGap('network-events-not-observed', label);
    }
    for (const record of records) {
      if (record.netType !== 'request') continue;
      for (const reason of [record.captureSkipped, record.truncated, record.sourceGap]) {
        if (reason) addGap(reason, record.tabId);
      }
    }
    const responded = new Set(records.filter(record => record.netType === 'response').map(record => record.requestId));
    for (const record of records) {
      if (record.netType === 'request' && !responded.has(record.requestId) && record.sourceGap !== 'request-failed') {
        record.sourceGap ||= 'response-not-observed';
        addGap('response-not-observed', record.tabId);
      }
    }
    const status = ![...pages.values()].some(state => state.drained) ? 'unavailable'
      : gaps.length ? 'partial' : 'captured';
    return { version: 1, source: SOURCE, status, capturedRequests, gaps, records };
  }
  return { track, accept, finish };
}
