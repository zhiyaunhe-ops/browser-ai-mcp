'use strict';

// Runs inside the designer document. Neither the capture nor the opaque field leaves it.
async function interactionRule(input) {
  const { templateId, billNo, ownDomain, ruleCode, operation, expectedName, name } = input;
  if (!location.pathname.startsWith('/iuap-yonbuilder-designer/')) throw Error('Expected a designer page');
  const path = '/iuap-yonbuilder-designer/iuap-front/hpabillstaterule/new/';
  const slot = Symbol.for('browser-ai.interaction-rule.capture');
  const scope = JSON.stringify([templateId, billNo, ownDomain, ruleCode]);
  async function read() {
    const query = new URLSearchParams({ templateId, billNo, ownDomain, caseType: '', pageSize: '1000', pageNumber: '0' });
    const response = await fetch(path + 'listRules?' + query, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || Number(body.code) !== 200 || !Array.isArray(body.data?.rules) ||
        body.data.count > body.data.rules.length) throw Error('Incomplete rule query');
    const rows = body.data.rules.filter(r => r.templateId === templateId && r.billNo === billNo && r.code === ruleCode);
    if (rows.length !== 1) throw Error('Expected one matching rule');
    return rows[0];
  }
  const capture = window[slot];
  if (operation === 'release') {
    if (capture?.scope === scope) { capture.detach(); delete window[slot]; }
    return { released: true };
  }
  const row = await read();
  function summary(rule) {
    const groups = rule.actionGroups.map(g => ({
      conditions: g.conditions.map(c => [c.leftTarget, c.compareOper, c.rightTarget, c.leftExpression, c.rightExpression, c.leftLogicOper]),
      actions: g.actions.map(a => [a.target, a.property, a.srcExprType, a.srcExpression, a.disabled])
    }));
    return { id: rule.id, code: rule.code, templateId, name: rule.name, disabled: rule.disabled,
      eventName: rule.eventName, triggers: rule.triggers, stateConditions: rule.stateConditions.map(c => [c.mode, c.disabled]), groups };
  }
  if (operation === 'read') return summary(row);
  const signature = r => JSON.stringify({ ...summary(r), name: '' });
  if (row.name !== expectedName || row.disabled !== 0) throw Error('Rule name or enabled state changed');
  if (operation === 'capture') {
    if (capture) throw Error('Release the existing capture first');
    const xhr = XMLHttpRequest.prototype;
    const originalOpen = xhr.open, originalSend = xhr.send;
    const requests = new WeakMap();
    const state = { scope, row, detach() {
      if (xhr.open === open) xhr.open = originalOpen;
      if (xhr.send === send) xhr.send = originalSend;
    } };
    function open(method, url, ...rest) {
      const target = new URL(url, location.href);
      if (method.toUpperCase() === 'POST' && target.origin === location.origin &&
          target.pathname === path + 'saveOrUpdateExpression') requests.set(this, target.href);
      return originalOpen.call(this, method, url, ...rest);
    }
    function send(body) {
      const url = requests.get(this);
      if (url && typeof body === 'string') {
        let data;
        try { data = JSON.parse(body); } catch {}
        if (data?.id === row.id && data.code === ruleCode && data.templateId === templateId &&
            data.billNo === billNo && data.ownDomain === ownDomain && data.name === row.name &&
            data.disabled === 0 && typeof data.actionGroupsEncrStr === 'string' && data.actionGroupsEncrStr) {
          this.addEventListener('load', () => {
            let success = false;
            try { success = Number((this.responseType === 'json' ? this.response : JSON.parse(this.responseText)).code) === 200; } catch {}
            if (this.status === 200 && success) state.submit = newName => fetch(url, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...data, name: newName })
            });
            state.detach();
          }, { once: true });
        }
      }
      return originalSend.call(this, body);
    }
    xhr.open = open; xhr.send = send; window[slot] = state;
    return { armed: true, id: row.id };
  }
  if (!name || capture?.scope !== scope || !capture.submit) throw Error('Successful in-page capture required');
  if (signature(row) !== signature(capture.row)) throw Error('Rule configuration changed');
  const response = await capture.submit(name);
  const result = await response.json().catch(() => ({}));
  const after = await read();
  const verified = after.name === name && signature(after) === signature(row);
  return { httpStatus: response.status, businessCode: Number(result.code) || null,
    verified: verified && response.ok && Number(result.code) === 200, readback: summary(after) };
}

module.exports = { interactionRule };
