'use strict';

const http = require('node:http');

function startFixtureSite() {
  const customers = new Map();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/node-links') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Node links fixture</title></head>
<body><main id="view"><h1>Records</h1><button id="mapping">对照表</button>
<p id="status" style="color: green">Active</p>
<iframe id="grid-frame" title="Record grid" src="/node-grid" style="width:900px;height:420px;border:0"></iframe>
</main></body></html>`);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/node-grid') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Record grid</title>
<style>.row-edit-option{display:none;cursor:pointer} tr:hover .row-edit-option{display:inline-block}</style></head>
<body><main id="view"><h1>Grid</h1><table id="grid"><tbody>
<tr data-row-key="product-a"><td>Product A</td><td><a>View</a></td><td><span class="inline-link" style="cursor:pointer">Open mapping</span></td><td><span class="row-edit-option row-btn-ViewAction">对照表</span></td></tr>
<tr data-row-key="product-b"><td>Product B</td><td><a>View</a></td><td><span class="inline-link" style="cursor:pointer">Open mapping</span></td><td><span class="row-edit-option row-btn-ViewAction">对照表</span></td></tr>
</tbody></table><output id="clicks">0</output></main>
<script>
let clicks = 0;
const openChild = (label, source) => {
  clicks++;
  document.querySelector('#view').innerHTML = '<h1>Child: ' + source + '</h1><a href="#detail">Child details</a><output id="child-clicks">' + clicks + '</output>';
};
document.querySelector('#view').addEventListener('click', event => {
  if (event.target.closest('a[href="#detail"]')) {
    event.preventDefault();
    document.querySelector('#view').innerHTML = '<h1>Details: Product record</h1><p>Read-only child detail view</p>';
  }
});
document.querySelector('#grid').addEventListener('click', event => {
  const link = event.target.closest('a,.inline-link,.row-btn-ViewAction');
  if (!link) return;
  event.preventDefault();
  openChild(link.textContent.trim(), event.target.closest('tr')?.cells[0]?.textContent.trim());
});
</script></body></html>`);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/loading-view') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Loading fixture</title></head>
<body><main id="loading-view" aria-busy="true"><div class="loading-mask" role="progressbar">Loading records</div><p>Current records</p></main></body></html>`);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/yonyou-transfer') {
      const collapsed = url.searchParams.get('collapsed') === '1';
      const rightRootClass = collapsed ? 'u-tree-treenode-close' : 'u-tree-treenode-open';
      const rightChild = collapsed
        ? '<li class="u-tree-node" fieldid="基础档案对照_node|existing-a"><span class="u-tree-checkbox u-tree-checkbox-checked"><span class="u-tree-checkbox-inner"></span></span><span class="u-tree-title">Existing mapping A</span></li><li class="u-tree-node" fieldid="基础档案对照_node|existing-b"><span class="u-tree-checkbox u-tree-checkbox-checked"><span class="u-tree-checkbox-inner"></span></span><span class="u-tree-title">Existing mapping B</span></li><li class="u-tree-node" fieldid="基础档案对照_node|existing-c"><span class="u-tree-checkbox u-tree-checkbox-checked"><span class="u-tree-checkbox-inner"></span></span><span class="u-tree-title">Existing mapping C</span></li>'
        : '';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Yonyou transfer fixture</title>
<style>.u-tree{width:280px;height:260px;overflow:auto;border:1px solid #aaa;padding:8px}.u-tree ul{list-style:none;padding-left:22px}.u-tree-checkbox-inner{display:inline-block;width:14px;height:14px;border:1px solid #888}.u-tree-checkbox-checked .u-tree-checkbox-inner{background:#2468a0}.u-tree-title{padding:4px}.template-export{display:flex;gap:14px}.opr-botton{margin:12px}.opr-botton button{display:block;width:36px;height:30px;margin:8px}.u-tree-treenode-close>.u-tree-child-tree{display:none}.u-tree-switcher{display:inline-block;width:16px;height:16px}</style></head>
<body><main id="template-export" class="template-export"><ul class="u-tree" aria-label="Source" id="source-tree" data-fieldid="来源档案值1_node"><li fieldid="基础档案对照_node" class="u-tree-node has-children u-tree-treenode-open">
<span class="u-tree-switcher u-tree-switcher_open"></span><span class="u-tree-title">基础档案对照_node</span><ul class="u-tree-child-tree">
<li class="u-tree-node" fieldid="来源档案值1_node|department"><span class="u-tree-checkbox"><span class="u-tree-checkbox-inner"></span></span><span class="u-tree-title">部门级别</span></li>
<li class="u-tree-node" fieldid="来源档案值1_node|income"><span class="u-tree-checkbox"><span class="u-tree-checkbox-inner"></span></span><span class="u-tree-title">收支项目</span></li>
</ul></li></ul>
<div class="opr-botton"><button type="button"><span><i class="icon iconfont icon-chuansuo-you"></i></span></button></div>
<div class="opr-botton"><button type="button"><span><i class="icon iconfont icon-chuansuo-you-copy"></i></span></button></div>
<ul class="u-tree" aria-label="Target" id="target-tree" data-fieldid="来源档案值2_node"><li fieldid="基础档案对照_node" class="u-tree-node has-children ${rightRootClass}">
<span class="u-tree-switcher ${collapsed ? 'u-tree-switcher_close' : 'u-tree-switcher_open'}"></span><span class="u-tree-title">基础档案对照_node</span><ul class="u-tree-child-tree" id="target-items">${rightChild}</ul></li></ul></main>
<output id="selected-moves">0</output><output id="all-moves">0</output>
<script>
const wrappers = document.querySelectorAll('.u-tree-checkbox');
for (const wrapper of wrappers) wrapper.addEventListener('click', () => {
  wrapper.classList.toggle('u-tree-checkbox-checked');
});
document.querySelector('#target-tree .u-tree-switcher').addEventListener('click', event => {
  const root = event.target.closest('li');
  const close = root.classList.toggle('u-tree-treenode-close');
  root.classList.toggle('u-tree-treenode-open', !close);
  event.target.classList.toggle('u-tree-switcher_close', close);
  event.target.classList.toggle('u-tree-switcher_open', !close);
});
document.querySelector('.icon-chuansuo-you').closest('button').addEventListener('click', () => {
  const count = Number(document.querySelector('#selected-moves').textContent) + 1;
  document.querySelector('#selected-moves').textContent = String(count);
  for (const leaf of [...document.querySelectorAll('#source-tree li[fieldid] .u-tree-checkbox-checked')].map(box => box.closest('li[fieldid]'))) {
    leaf.querySelector('.u-tree-checkbox')?.classList.remove('u-tree-checkbox-checked');
    document.querySelector('#target-items').append(leaf);
  }
});
document.querySelector('.icon-chuansuo-you-copy').closest('button').addEventListener('click', () => {
  const count = Number(document.querySelector('#all-moves').textContent) + 1;
  document.querySelector('#all-moves').textContent = String(count);
  for (const leaf of [...document.querySelectorAll('#source-tree li[fieldid] .u-tree-child-tree > li')]) document.querySelector('#target-items').append(leaf);
});
</script></body></html>`);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/transfer') {
      const prechecked = url.searchParams.get('prechecked') === '1';
      const option = (name, extra = '') => `<div class="ant-transfer-list-content-item" role="option" aria-selected="${extra.includes('checked') ? 'true' : 'false'}" ${extra.includes('disabled') ? 'aria-disabled="true"' : ''}><label><input type="checkbox" ${extra.includes('checked') ? 'checked' : ''} ${extra.includes('disabled') ? 'disabled' : ''}><span>${name}</span></label></div>`;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Transfer fixture</title>
<style>.ant-transfer{display:flex;gap:12px}.ant-transfer-list{width:240px;height:300px;border:1px solid #aaa}.ant-transfer-list-content-item{padding:8px}</style></head>
<body><main><h1>Available and selected</h1><div class="ant-transfer" id="chooser">
<section class="ant-transfer-list" data-side="left" aria-label="Source" role="listbox">
<div class="ant-transfer-list-header">Available</div><div id="source-items">
${option('Inventory')}${option('Inventory Control')}${option('Duplicate')}${option('Duplicate')}${option('Locked option', 'disabled')}${option('Extra preselection', prechecked ? 'checked' : '')}</div></section>
<div class="ant-transfer-operation"><button type="button" class="ant-transfer-operation-right" aria-label="Move selected right">Move selected right</button></div>
<section class="ant-transfer-list" data-side="right" aria-label="Target" role="listbox">
<div class="ant-transfer-list-header">Selected</div><div id="target-items">${option('Already in target')}</div></section></div>
<output id="move-count">0</output></main><script>
let moves = 0;
document.querySelector('#source-items').addEventListener('change', event => {
  if (event.target.matches('input[type="checkbox"]')) event.target.closest('[role="option"]')?.setAttribute('aria-selected', String(event.target.checked));
});
document.querySelector('.ant-transfer-operation-right').addEventListener('click', () => {
  moves++;
  for (const row of [...document.querySelectorAll('#source-items [role="option"]')]) {
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (!checkbox?.checked || checkbox.disabled) continue;
    checkbox.checked = false;
    row.setAttribute('aria-selected', 'false');
    document.querySelector('#target-items').append(row);
  }
  document.querySelector('#move-count').textContent = String(moves);
});
</script></body></html>`);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/customers') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Customer fixture</title></head>
<body><main><h1>Customer form</h1><form id="customer-form">
<label for="code">Customer code</label><input id="code" name="code" required>
<label for="name">Customer name</label><input id="name" name="name" required>
<button type="submit">Save customer</button></form><p id="status" data-saved="false">Not saved</p></main>
<script>
document.querySelector('#customer-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const response = await fetch('/api/customers', {method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({code:form.get('code'), name:form.get('name')})});
  const result = await response.json();
  document.querySelector('#status').dataset.saved = result.ok ? 'true' : 'false';
  document.querySelector('#status').textContent = result.ok ? 'Saved' : 'Save failed';
});
</script></body></html>`);
      return;
    }
    const match = url.pathname.match(/^\/api\/customers\/([^/]+)$/);
    if (request.method === 'GET' && match) {
      const customer = customers.get(decodeURIComponent(match[1]));
      response.writeHead(customer ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(customer ? { customer } : { error: 'not found' }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/customers') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        try {
          const input = JSON.parse(body);
          if (!input.code || !input.name) throw new Error('code and name are required');
          const customer = { code: input.code, name: input.name };
          customers.set(customer.code, customer);
          response.writeHead(201, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, customer }));
        } catch (error) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: false, error: error.message }));
        }
      });
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}/customers`, customers });
    });
  });
}

module.exports = { startFixtureSite };

