'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const designerUrl = 'https://example.test/designer';

function propertyPanel(initial) {
  let required = initial;
  let field = '';
  let toggleClicks = 0;
  let saveClicks = 0;
  const toggle = {
    disabled: false,
    classList: { contains: name => name === 'is-checked' && required },
    click() { toggleClicks++; required = !required; },
  };
  const save = { disabled: false };
  const label = {
    title: 'Department',
    getAttribute: () => 'znbzbx_expensebill|department_tips',
    click() { field = 'department'; },
  };
  const document = {
    querySelector(selector) {
      if (selector.startsWith('.labelWrapper')) return label;
      if (selector.includes('cItemName')) return { value: field };
      if (selector.includes('UI#required')) return toggle;
      if (selector.includes('saveBtn')) return save;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    querySelectorAll(selector) {
      assert.ok(selector.startsWith('.labelWrapper'));
      return [label];
    },
  };
  const page = {
    async url() { return designerUrl; },
    async evaluate(fn, arg) {
      const previous = global.document;
      global.document = document;
      try { return fn(arg); } finally { global.document = previous; }
    },
    async click(selector) {
      assert.equal(selector, '.designLayoutTopRight button.saveBtn');
      saveClicks++;
      save.disabled = true;
    },
  };
  return { page, state: () => ({ required, field, toggleClicks, saveClicks }) };
}

test('update switches the selected field to the requested value and saves once', async () => {
  const { update } = await import('../scripts/asp-template.mjs');
  for (const desired of [true, false]) {
    const { page, state } = propertyPanel(!desired);
    assert.deepEqual(await update({}, page, { designerUrl, field: 'department', desired }), { changed: true });
    assert.deepEqual(state(), { required: desired, field: 'department', toggleClicks: 1, saveClicks: 1 });
  }
});

test('update does not switch or save an already matching property', async () => {
  const { update } = await import('../scripts/asp-template.mjs');
  const { page, state } = propertyPanel(true);
  assert.deepEqual(await update({}, page, { designerUrl, field: 'department', desired: true }), { changed: false });
  assert.deepEqual(state(), { required: true, field: 'department', toggleClicks: 0, saveClicks: 0 });
});
