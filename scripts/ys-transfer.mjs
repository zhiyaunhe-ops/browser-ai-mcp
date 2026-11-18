// Read a scoped transfer widget and move named items using the Ego mouse API.
export const VERSION = '2026-11-18.1';

function optionsFor(opts) {
  if (typeof opts?.scope !== 'string' || !opts.scope.trim()) throw new TypeError('A transfer dialog or container CSS scope is required');
  if (opts.framePath !== undefined && (typeof opts.framePath !== 'string' || !/^0(?:\/\d+)*$/.test(opts.framePath))) throw new TypeError('Expected an observed framePath such as 0/1');
  const limit = opts.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer between 1 and 1000 per list');
  return { scope: opts.scope, framePath: opts.framePath ?? null, limit };
}

// This function runs in the page. It reads DOM state and hit-tests the next target.
// Browser input is dispatched only by the caller, after validating the entire result.
function inspectTransfer({ scope, framePath, limit, target, names }) {
  const tidy = text => String(text ?? '').trim();
  const visible = el => {
    if (!el?.getClientRects().length) return false;
    for (let n = el; n; n = n.parentElement) {
      const s = n.ownerDocument.defaultView.getComputedStyle(n);
      if (n.hidden || s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0) return false;
    }
    return true;
  };
  const scopeMatches = [], unreadFrames = [];
  function visit(doc, path, frames) {
    if (!framePath || path === framePath) {
      for (const root of doc.querySelectorAll(scope)) if (visible(root)) scopeMatches.push({ root, path, frames });
    }
    for (const [i, frame] of [...doc.querySelectorAll('iframe')].entries()) {
      const childPath = path + '/' + i;
      if (framePath && framePath !== childPath && !framePath.startsWith(childPath + '/')) continue;
      if (!visible(frame)) continue;
      let child;
      try { child = frame.contentDocument; } catch {}
      if (child) visit(child, childPath, [...frames, frame]);
      else unreadFrames.push(childPath);
    }
  }
  const empty = () => ({ items: [], complete: false, truncated: false });
  const failure = reason => ({ ok: false, complete: false, businessSaved: false, reason, left: empty(), right: empty(), unreadFrames });
  try { visit(document, '0', []); } catch { return failure('invalid-scope'); }
  if (unreadFrames.length) return failure('unread-frame');
  if (scopeMatches.length !== 1) return failure(scopeMatches.length ? 'ambiguous-scope' : 'scope-not-found');
  const { root, path: frameId, frames } = scopeMatches[0];
  const doc = root.ownerDocument;
  const vendorPanel = '.ant-transfer-list,.u-transfer-list,.wui-transfer-list,.transfer-list';
  const treePanel = '.u-tree,ul.nc-tree';
  const panelSelector = vendorPanel + ',' + treePanel + ',[data-transfer-side],[data-side="left"],[data-side="right"],[role="listbox"]';
  const panels = [...root.querySelectorAll(panelSelector)].filter(visible)
    .filter(node => !node.parentElement?.closest(panelSelector) || !root.contains(node.parentElement.closest(panelSelector)));
  if (panels.length !== 2) return failure('ambiguous-lists');

  function sideOf(panel) {
    const labelledBy = (panel.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => doc.getElementById(id)?.innerText || '').join(' ');
    const title = panel.querySelector('header,h2,h3,h4,[class$="-list-header-title"]')?.innerText;
    const labels = [panel.getAttribute('data-transfer-side'), panel.getAttribute('data-side'),
      panel.getAttribute('aria-label'), labelledBy, title].map(tidy);
    const left = labels.some(s => /^(left|source|available(?: items| options)?|待选(?:项|数据)?|可选(?:项|数据)?|待关联角色用户)$/i.test(s));
    const right = labels.some(s => /^(right|target|selected(?: items| options)?|已选(?:项|数据)?|已关联角色用户)$/i.test(s));
    return left && right ? 'conflict' : left ? 'left' : right ? 'right' : '';
  }
  let [left, right] = panels;
  const [a, b] = panels.map(sideOf);
  if (a === 'right' && b === 'left') [left, right] = [right, left];
  else if (a !== 'left' || b !== 'right') {
    // Only a recognized component with two separated columns has an implicit order.
    if (!panels.every(p => p.matches(vendorPanel)) &&
        !(panels.every(p => p.matches(treePanel)) && root.querySelector('.opr-botton'))) return failure('unidentified-list-sides');
    [left, right] = [...panels].sort((x, y) => x.getBoundingClientRect().left - y.getBoundingClientRect().left);
    if (left.getBoundingClientRect().right > right.getBoundingClientRect().left ||
        !['', 'left'].includes(sideOf(left)) || !['', 'right'].includes(sideOf(right))) return failure('unidentified-list-sides');
  }
  const disabled = el => !!el?.closest(':disabled,[aria-disabled="true"],[inert],[class$="-disabled"],[class*="-disabled "]');
  const checkbox = 'input[type="checkbox"],[role="checkbox"]';
  const chrome = 'header,footer,h1,h2,h3,h4,[class*="-list-header"],[class*="-list-footer"],[class*="-search"],[class*="-empty"],[role="status"]';
  const rowSelector = '[role="option"],[role="treeitem"],[data-transfer-item],.ant-transfer-list-content-item,.u-transfer-list-content-item,.wui-transfer-list-content-item,li';
  function treeRows(panel, gap, side) {
    const rows = [...panel.querySelectorAll('li')];
    const entries = [], hints = [], identities = new Map();
    const roots = rows.filter(row => !panel.contains(row.parentElement.closest('li')));
    for (const row of rows) {
      const own = selector => [...row.querySelectorAll(selector)].filter(el => el.closest('li') === row);
      if (!visible(row)) { gap('partial-tree'); continue; }
      const label = own('.u-tree-title,.nc-tree-title,[data-tree-title]')[0];
      const fieldid = row.getAttribute('fieldid') || row.getAttribute('data-fieldid') || '';
      const name = tidy(label?.innerText || row.getAttribute('aria-label') || row.getAttribute('title') || fieldid);
      if (!name) { gap('unnamed-tree-node'); continue; }
      const parent = row.parentElement.closest('li');
      const ancestors = parent && panel.contains(parent) ? identities.get(parent) : [];
      if (!ancestors) { gap('unidentified-tree-parent'); continue; }
      const path = [...ancestors, fieldid || name];
      identities.set(row, path);
      // In the template-export tree both collapsed folders and terminal leaves
      // have treenode-close. A leaf has a noop switcher and no branch marker.
      const noop = own('.u-tree-switcher-noop').length > 0;
      const expandable = row.querySelector('li') || row.matches('.has-children,[aria-expanded],.u-tree-treenode-open') ||
        own('.u-tree-switcher_open,.u-tree-switcher_close').length || (!noop && row.matches('.u-tree-treenode-close'));
      if (expandable) {
        if (row.matches('[aria-expanded="false"],.u-tree-treenode-close') || own('.u-tree-switcher_close').length) {
          const switches = own('.u-tree-switcher:not(.u-tree-switcher-noop)').filter(visible);
          const canExpand = roots.length === 1 && roots[0] === row && !!fieldid && switches.length === 1 &&
            !disabled(switches[0]) && !switches[0].closest('.u-tree-checkbox');
          hints.push({ side, framePath: frameId, fieldid, label: name, depth: path.length, canExpand, control: switches[0] });
          gap('collapsed-tree');
        } else if (!(row.querySelector('li') || own('ul,[role="group"]').some(visible))) gap('partial-tree');
        continue;
      }
      const wrappers = own('.u-tree-checkbox,.nc-tree-checkbox');
      const native = own('input[type="checkbox"]');
      const wrapper = wrappers[0], control = native[0] || wrapper?.querySelector('.u-tree-checkbox-inner,.nc-tree-checkbox-inner') || wrapper;
      if (!control || wrappers.length > 1 || native.length > 1 ||
          native[0]?.indeterminate || wrapper?.matches('[aria-checked="mixed"],[class*="half-checked"]')) { gap('unreadable-tree-checkbox'); continue; }
      const checked = native[0] ? native[0].checked : wrapper.hasAttribute('aria-checked') ? wrapper.getAttribute('aria-checked') === 'true' :
        wrapper.matches('.u-tree-checkbox-checked,.nc-tree-checkbox-checked');
      entries.push({ row, control, name, fieldid, path, checked, disabled: disabled(control) || disabled(row) });
    }
    return { rows, entries, hints };
  }
  function readList(panel, side) {
    let reason = null;
    const gap = value => { reason ||= value; };
    const trees = panel.matches(treePanel) ? [panel] : [...panel.querySelectorAll(treePanel)];
    if (trees.length > 1) gap('ambiguous-trees');
    const tree = trees[0] && treeRows(trees[0], gap, side);
    const raw = tree ? tree.rows : [...panel.querySelectorAll(rowSelector)].filter(el => !el.closest(chrome));
    // Simple panels can use one label-wrapped checkbox per item without a row role.
    for (const box of panel.querySelectorAll(checkbox)) {
      if (box.closest(chrome) || box.closest(rowSelector)) continue;
      const row = box.closest('label') || box;
      if (!raw.includes(row)) raw.push(row);
    }
    const partial = '[aria-busy="true"],[aria-expanded="false"],[data-virtual="true"],[data-virtualized="true"],[class*="virtual" i],[class*="pagination" i],iframe';
    if (root.matches(partial) || panel.matches(partial) || panel.querySelector(partial) ||
        root.querySelector('[class*="pagination" i]') || panel.querySelectorAll('[role="listbox"]').length > 1) gap('partial-list');
    if (panel.shadowRoot || [...panel.querySelectorAll('*')].some(n => n.shadowRoot || n.localName.includes('-') && !n.childNodes.length)) gap('unread-list-content');
    if ([...panel.querySelectorAll('input[type="search"],input[type="text"],input:not([type])')].some(n => n.value)) gap('filtered-list');
    const entries = tree?.entries || [];
    for (const row of tree ? [] : raw) {
      if (row.querySelector(rowSelector) || !visible(row)) { gap('partial-list'); continue; }
      const boxes = [...row.querySelectorAll(checkbox)];
      if (row.matches(checkbox)) boxes.unshift(row);
      const box = boxes.find(n => n.matches('input[type="checkbox"]')) || boxes[0];
      if (boxes.some(n => n !== box && !n.contains(box))) { gap('ambiguous-checkbox'); continue; }
      const control = box || row;
      const selected = box?.matches('input[type="checkbox"]') ? String(box.checked) :
        (box?.getAttribute('aria-checked') ?? row.getAttribute('aria-selected') ?? row.getAttribute('aria-checked'));
      if (!['true', 'false'].includes(selected) || box?.indeterminate) { gap('unreadable-check-state'); continue; }
      const namedBy = (row.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map(id => doc.getElementById(id)?.innerText || '').join(' ');
      const name = tidy(row.getAttribute('aria-label') || namedBy || row.innerText || control.getAttribute('aria-label') ||
        [...(control.labels || [])].map(label => label.innerText).join(' '));
      if (!name) { gap('unnamed-item'); continue; }
      const blocked = disabled(control) || disabled(row);
      entries.push({ row, control, name, checked: selected === 'true', disabled: blocked });
    }
    // Unknown visible content or unrepresented rows make a set comparison unsafe.
    const walker = doc.createTreeWalker(panel, 4);
    const represented = new Set(raw);
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement, s = tidy(walker.currentNode.textContent);
      if (!s || !visible(el) || el.closest(chrome)) continue;
      let n = el;
      while (n && n !== panel && !represented.has(n)) n = n.parentElement;
      if (!represented.has(n) && !/^(暂无数据|暂无内容|无数据|no data|no items)$/i.test(s)) gap('unrecognized-list-content');
    }
    for (const node of [panel, ...panel.querySelectorAll('[aria-setsize],[aria-rowcount],[data-total],[data-total-count]')]) {
      for (const field of ['aria-setsize', 'aria-rowcount', 'data-total', 'data-total-count']) {
        if (node.hasAttribute(field) && Number(node.getAttribute(field)) !== entries.length) gap('partial-list');
      }
    }
    const truncated = entries.length > limit;
    if (truncated) gap('limit-reached');
    const items = entries.slice(0, limit).map(({ row, control, ...item }) => item);
    const emptyConfirmed = !items.length && (panel.matches('[aria-rowcount="0"],[data-total="0"],[data-total-count="0"]') ||
      [...panel.querySelectorAll('[role="status"],[class*="-empty"]')].some(n => visible(n) && /暂无数据|无数据|no (?:data|items)/i.test(n.innerText)));
    const hints = tree?.hints || [];
    const expandHints = hints.map(({ control, ...hint }) => hint);
    return { entries, hints, state: { items, complete: !reason, truncated, emptyConfirmed, expandHints, ...(reason && { reason }) } };
  }
  const source = readList(left, 'left'), destination = readList(right, 'right');
  const reason = source.state.reason || destination.state.reason;
  const state = { ok: !reason, complete: !reason, businessSaved: false, framePath: frameId, url: doc.URL,
    left: source.state, right: destination.state, truncated: source.state.truncated || destination.state.truncated,
    ...(reason && { reason }) };
  if (target === 'expand') {
    const [side, id] = names;
    const hints = side === 'left' ? source.hints : destination.hints;
    const hint = hints.length === 1 && hints[0];
    const xy = hint?.canExpand && hint.fieldid === id && point(hint.control);
    return xy ? { ...state, point: xy } : { ...state, actionReason: 'root-switcher-not-hittable' };
  }
  if (!target || reason) return state;

  const controls = [...root.querySelectorAll('button,[role="button"],input[type="button"]')].filter(el => visible(el) && !left.contains(el) && !right.contains(el));
  function selectedRight(el) {
    const labels = ['aria-label', 'title', 'data-action'].map(key => tidy(el.getAttribute(key)));
    labels.push(tidy(el.innerText || el.value));
    if (labels.some(s => /all|全部|全选|全選|全移|移全|左移|向左|left|[»≫←]|>>|确认|确定|保存|submit|confirm|save/i.test(s))) return false;
    if (el.querySelector('[class*="double" i],[data-icon*="double" i]') || /double|move-all/i.test(el.className)) return false;
    if (labels.some(s => /^(move(?: selected(?: items)?)? (?:to (?:the )?)?right|move-right|移至右侧|移到右侧|右移|选中项右移|将选中项移至右侧)$/i.test(s))) return true;
    const ncIcon = el.querySelector('.icon-chuansuo-you');
    if (ncIcon && el.closest('.opr-botton')) {
      const operators = [...root.querySelectorAll('.opr-botton')].filter(visible);
      if (operators.length !== 2 || !operators.some(op => op.querySelector('.icon-chuansuo-you-copy'))) return false;
      for (let n = ncIcon; n && n !== root; n = n.parentElement) {
        const style = doc.defaultView.getComputedStyle(n);
        if (style.transform !== 'none' || style.scale && style.scale !== 'none' || style.rotate && style.rotate !== 'none') return false;
      }
      return true;
    }
    const group = el.closest('.ant-transfer-operation,.u-transfer-operation,.wui-transfer-operation,.transfer-operation');
    return !!group && (labels.some(s => /^(>|→|›)$/.test(s)) ||
      el.matches('.ant-transfer-operation-right,.u-transfer-operation-right,.wui-transfer-operation-right') ||
      !!el.querySelector('[data-icon="right"],.uf-arrow-right,.anticon-right'));
  }
  const moves = controls.filter(selectedRight);
  if (moves.length !== 1) return { ...state, actionReason: moves.length ? 'ambiguous-move-right' : 'missing-move-selected-right' };
  const move = moves[0];
  if (move.matches('button') && move.form && move.type === 'submit') return { ...state, actionReason: 'submit-control' };

  function point(el) {
    if (!el || !visible(el) || (window.visualViewport && window.visualViewport.scale !== 1)) return null;
    const rect = el.getBoundingClientRect();
    let x = Math.floor(rect.left + rect.width / 2), y = Math.floor(rect.top + rect.height / 2);
    const hit = doc.elementFromPoint(x, y);
    if (!(rect.width >= 2 && rect.height >= 2 && hit && el.contains(hit))) return null;
    const interactive = hit.closest('button,a[href],input,select,textarea,[role="button"],[role="link"]');
    if (interactive && interactive !== el && el.contains(interactive) && el.control !== interactive) return null;
    for (const frame of [...frames].reverse()) {
      const parent = frame.ownerDocument;
      const inner = frame.contentDocument;
      if (x < 0 || y < 0 || x >= inner.documentElement.clientWidth || y >= inner.documentElement.clientHeight) return null;
      for (let node = frame; node; node = node.parentElement) {
        const s = parent.defaultView.getComputedStyle(node);
        if (s.transform !== 'none' || (s.scale && s.scale !== 'none') || (s.rotate && s.rotate !== 'none') ||
            (s.zoom && !['normal', '1'].includes(s.zoom))) return null;
      }
      const fr = frame.getBoundingClientRect();
      x += fr.left + frame.clientLeft;
      y += fr.top + frame.clientTop;
      if (parent.elementFromPoint(x, y) !== frame) return null;
    }
    return { x, y };
  }
  function itemPoint(entry) {
    const direct = point(entry.control);
    if (direct) return direct;
    const label = entry.control.closest('label');
    // Native labels also toggle visually hidden checkboxes.
    if (label?.control === entry.control && entry.row.contains(label) &&
        !label.querySelector('button,a[href]')) return point(label);
    return null;
  }
  if (target === 'preflight') {
    if (!disabled(move) && doc.defaultView.getComputedStyle(move).pointerEvents !== 'none' && !point(move)) return { ...state, actionReason: 'move-control-not-hittable' };
    if (source.entries.some(e => (names.includes(e.name) || e.fieldid && names.includes(e.fieldid)) && !e.checked && !itemPoint(e))) return { ...state, actionReason: 'item-not-hittable' };
    return state;
  }
  let xy;
  if (target === 'move') {
    if (disabled(move)) return { ...state, actionReason: 'move-disabled' };
    xy = point(move);
  } else {
    const matches = source.entries.filter(e => e.name === names[0] || e.fieldid === names[0]);
    if (matches.length === 1 && !matches[0].disabled) xy = itemPoint(matches[0]);
  }
  return xy ? { ...state, point: xy } : { ...state, actionReason: 'target-not-hittable' };
}

const identity = row => JSON.stringify([row.name, row.fieldid || '', row.path || []]);
// The same field may live under a different target root after the transfer.
const portableIdentity = row => row.fieldid ? JSON.stringify([row.name, row.fieldid]) : identity(row);
function inventory(items, withChecks = false) {
  return items.map(row => withChecks ? JSON.stringify([identity(row), row.checked, row.disabled]) : identity(row)).sort();
}
function equal(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function transferRight(page, names, opts) {
  if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || !n.trim() || n !== n.trim()) ||
      new Set(names).size !== names.length) throw new TypeError('Pass distinct, nonempty exact item names');
  const config = optionsFor(opts);
  const read = (target = null, selected = []) => page.evaluate(inspectTransfer, { ...config, target, names: selected });
  let state = await read();
  const result = { moved: [], alreadyRight: [], selectionClicks: [], expandedRoots: [], moveAttempted: false, verified: false, businessSaved: false };
  const fail = reason => ({ ...result, ok: false, reason, state });
  const success = (moved = [], sourceRetained = [], sourceRemoved = []) => ({
    ok: true, verified: true, businessSaved: false, moved, alreadyRight: result.alreadyRight,
    expandedRoots: result.expandedRoots, sourceRetained, sourceRemoved,
    state: opts.detail === 'full' ? state : {
      framePath: state.framePath, left: { count: state.left.items.length }, right: { count: state.right.items.length }
    }
  });
  const frame = state.framePath, url = state.url;
  if (frame) config.framePath = frame;
  async function expandRoots(phase) {
    for (const side of ['left', 'right']) {
      const sideState = state[side];
      const hints = sideState.expandHints || [];
      if (sideState.complete || sideState.reason !== 'collapsed-tree' || hints.length !== 1 || !hints[0].canExpand) continue;
      if (result.expandedRoots.some(h => h.phase === phase && h.side === side)) continue;
      const { fieldid, label } = hints[0];
      state = await read('expand', [side, fieldid]);
      if (state.framePath !== frame || state.url !== url || !state.point) return false;
      result.expandedRoots.push({ phase, side, fieldid, label });
      await page.mouse.click(state.point.x, state.point.y, { label: 'Expand transfer tree: ' + label });
      const until = Date.now() + 1500;
      let previous = null;
      do {
        state = await read();
        if (state.framePath !== frame || state.url !== url) return false;
        const current = state[side];
        if (!current.expandHints?.some(h => h.fieldid === fieldid)) {
          // Some trees render an open but empty branch before fetching its children.
          const settled = current.items.length > 0 || current.emptyConfirmed || current.expandHints?.length > 0;
          const signature = JSON.stringify([current.reason, current.items, current.expandHints]);
          if (settled && signature === previous) break;
          previous = settled ? signature : null;
        }
        if (Date.now() >= until) return false;
        await wait(60);
      } while (true);
    }
    return true;
  }
  if (!state.complete && !await expandRoots('before-selection')) return fail(state.actionReason || 'root-expansion-unverified');
  if (!state.complete) return fail(state.reason);
  const initial = state;
  config.framePath = initial.framePath;
  const pending = [], targets = new Map(), requested = new Set();
  for (const name of names) {
    const matches = i => i.name === name || i.fieldid === name;
    const l = state.left.items.filter(matches), r = state.right.items.filter(matches);
    if (l.length > 1 || r.length > 1) return fail('ambiguous-item');
    if (!l.length && !r.length) return fail('item-not-found');
    if (l.length && r.length && (!l[0].fieldid || portableIdentity(l[0]) !== portableIdentity(r[0]))) return fail('ambiguous-item');
    const item = r[0] || l[0], key = identity(item);
    if (requested.has(key)) return fail('duplicate-requested-item');
    requested.add(key);
    if (r.length) result.alreadyRight.push(name);
    else if (l[0].disabled) return fail('disabled-item');
    else { pending.push(name); targets.set(key, { name, item }); }
  }
  const alreadySelected = new Set(result.alreadyRight);
  if (state.left.items.some(i => i.checked && !targets.has(identity(i)) &&
      (pending.length || !(alreadySelected.has(i.name) || alreadySelected.has(i.fieldid))))) return fail('unexpected-left-selection');
  if (!pending.length) return success();

  const checked = new Set(state.left.items.filter(i => i.checked).map(identity));
  const rightBefore = inventory(initial.right.items, true);
  const consistent = observed => observed.complete && observed.url === initial.url && observed.framePath === initial.framePath &&
    equal(inventory(observed.right.items, true), rightBefore) &&
    equal(inventory(observed.left.items, true), inventory(initial.left.items.map(i => ({ ...i, checked: checked.has(identity(i)) })), true));
  async function settle(predicate, afterMove = false) {
    const until = Date.now() + 1500;
    do {
      state = await read();
      if (afterMove && !state.complete && !await expandRoots('after-move')) return false;
      if (predicate(state)) return true;
      if (Date.now() >= until) break;
      await wait(60);
    } while (true);
    return false;
  }
  state = await read('preflight', pending);
  if (!consistent(state) || state.actionReason) return fail(state.actionReason || 'selection-changed');
  for (const [key, { name }] of targets) {
    if (checked.has(key)) continue;
    state = await read('item', [name]);
    if (!consistent(state) || !state.point) return fail(state.actionReason || 'selection-changed');
    result.selectionClicks.push(name);
    await page.mouse.click(state.point.x, state.point.y, { label: 'Select transfer item: ' + name });
    checked.add(key);
    if (!await settle(consistent)) return fail('checkbox-change-unverified');
  }
  state = await read('move');
  if (!consistent(state) || !state.point) return fail(state.actionReason || 'selection-changed');
  result.moveAttempted = true;
  await page.mouse.click(state.point.x, state.point.y, { label: 'Move selected transfer items to the right' });
  const beforeRightCounts = new Map();
  for (const key of inventory(initial.right.items)) beforeRightCounts.set(key, (beforeRightCounts.get(key) || 0) + 1);
  const expectedAdded = [...targets.values()].map(t => portableIdentity(t.item)).sort();
  function destinationVerified(items) {
    const counts = new Map(beforeRightCounts), added = [];
    for (const item of items) {
      const key = identity(item), count = counts.get(key) || 0;
      if (count) counts.set(key, count - 1);
      else added.push(portableIdentity(item));
    }
    return ![...counts.values()].some(Boolean) && equal(added.sort(), expectedAdded);
  }
  const retainedOthers = inventory(initial.left.items.filter(i => !targets.has(identity(i))), true);
  const verified = await settle(observed => {
    if (!observed.complete || observed.url !== initial.url || observed.framePath !== initial.framePath ||
        !destinationVerified(observed.right.items)) return false;
    const others = observed.left.items.filter(i => !targets.has(identity(i)));
    const retainedTargets = inventory(observed.left.items.filter(i => targets.has(identity(i))));
    return equal(inventory(others, true), retainedOthers) && new Set(retainedTargets).size === retainedTargets.length;
  }, true);
  if (!verified) return fail('transfer-unverified');
  const retained = new Set(state.left.items.map(identity));
  const sourceRetained = [], sourceRemoved = [];
  for (const [key, { name }] of targets) (retained.has(key) ? sourceRetained : sourceRemoved).push(name);
  return success(pending, sourceRetained, sourceRemoved);
}

export function installTransferHelper(ys, page) {
  ys.transferState = opts => page.evaluate(inspectTransfer, { ...optionsFor(opts), target: null, names: [] });
  ys.transferRight = (names, opts) => transferRight(page, names, opts);
  return ys;
}

export function attach(page) {
  return installTransferHelper(page.ys ||= {}, page);
}
