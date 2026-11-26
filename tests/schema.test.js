'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readSchema } = require('../src/schema');

test('table lookup scopes the metadata query to the supplied schema and table', async () => {
  const table = "Invoice's archive";
  const result = await readSchema(['table', 'dbo', table], async sql => {
    assert.ok(!sql.includes(table));
    assert.ok(sql.includes(Buffer.from(table, 'utf16le').toString('hex')));
    assert.match(sql, /sys\.foreign_keys/);
    return { databaseName: 'fixture', items: [{ schema: 'dbo', name: table, columns: [{ name: 'id' }] }] };
  });
  assert.equal(result.columns[0].name, 'id');
  assert.deepEqual(result.foreignKeys, []);
});

test('schema search requires a term and fetches a bounded page', async () => {
  await assert.rejects(readSchema(['tables', '']), { code: 'DB_SCHEMA_ARGUMENTS' });
  const page = await readSchema(['columns', 'invoice', '20', '2'], async sql => {
    assert.match(sql, /OFFSET 20 ROWS FETCH NEXT 3 ROWS ONLY/);
    return { items: [{ name: 'first' }, { name: 'second' }, { name: 'third' }] };
  });
  assert.equal(page.nextOffset, 22);
  assert.equal(page.items.length, 2);
});
