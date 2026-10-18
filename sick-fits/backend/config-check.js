#!/usr/bin/env node
'use strict';

/**
 * Day 26 — prove Keystone itself accepts the order schema, and record what the
 * admin UI actually gets.
 *
 * `npm run build` needs Node 16 and several minutes, and boots the admin-UI
 * compiler. This does the cheap half in seconds: Keystone's own `createSystem()`
 * validates the config and generates the GraphQL schema and the admin meta
 * WITHOUT connecting to a database. If the status field, its access, the hook or
 * the timestamp fields were malformed, this throws here.
 *
 * It reads the JavaScript that `tsc` emits into `.tmp-check/` (gitignored, and
 * safe to delete).
 *
 * WHY IT ALSO PRINTS THE ADMIN META
 * The day shipped `ui.labelField` / `ui.listView` / `ui.displayMode` in its first
 * draft. All four are accepted by @keystone-next/types 12 but DROPPED by
 * @keystone-next/keystone 9.3.1's initConfig, which passes only
 * fields/access/hooks through to createList (with a FIXME naming labelField and
 * adminConfig as unsupported). `npx tsc` could not catch that: the types are
 * newer than the runtime. So this probe asserts what the ADMIN META contains —
 * the thing the admin UI reads — rather than what the config file asked for.
 *
 * RUN (from sick-fits/backend, on Node 16 — see docs/STATUS.md)
 *   npm run check:schema
 */

const path = require('path');
const { execFileSync } = require('child_process');

const EMIT_DIR = path.join(__dirname, '.tmp-check');

// Emit JS from the TypeScript sources. tsc exits non-zero on this repo because of
// the pre-existing type errors recorded in docs/STATUS.md; it still writes the
// output, so the exit code is ignored here and the error COUNT is checked
// separately (16 before this day's work, 16 after).
try {
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', '-p', 'tsconfig.json', '--outDir', '.tmp-check',
      '--declaration', 'false', '--declarationMap', 'false', '--sourceMap', 'false'],
    { cwd: __dirname, stdio: ['ignore', 'ignore', 'inherit'] },
  );
} catch (err) {
  // expected: pre-existing type errors. Output is still emitted.
}

let config = require(path.join(EMIT_DIR, 'keystone.js')).default;
// `withAuth(...)` may hand back a factory rather than a config value.
if (typeof config === 'function') {
  config = config();
}

const { createSystem } = require('@keystone-next/keystone');
const system = createSystem(config, path.join(EMIT_DIR, '.keystone-check'), 'build');

const sys = system.keystone;
const list = sys.lists.Order;
const field = list.fields.find((f) => f.path === 'status');
const meta = sys.getAdminMeta({ schemaName: 'public' }).lists.Order;
const metaField = meta.fields.find((f) => f.path === 'status');

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${label}`);
    console.error(`       ${err.message}`);
  }
};

const assert = require('assert');

console.log('\nKeystone accepts the schema');

check('the Order list builds with a status field', () => {
  assert.ok(field, 'no status field on the built list');
});

check('status carries the five lifecycle values, labelled for humans', () => {
  const options = (field.config && field.config.options) || [];
  assert.deepStrictEqual(options, [
    { label: 'Created', value: 'CREATED' },
    { label: 'Paid', value: 'PAID' },
    { label: 'Fulfilled', value: 'FULFILLED' },
    { label: 'Delivered', value: 'DELIVERED' },
    { label: 'Cancelled', value: 'CANCELLED' },
  ]);
});

check('status defaults to CREATED and is required', () => {
  assert.strictEqual(field.defaultValue, 'CREATED');
  assert.strictEqual(field.isRequired, true);
});

check('both timestamps map onto a real adapter type', () => {
  const created = list.fields.find((f) => f.path === 'createdAt');
  const moved = list.fields.find((f) => f.path === 'statusChangedAt');
  assert.strictEqual(created.adapter.constructor.name, 'MongoDateTimeUtcInterface');
  assert.strictEqual(moved.adapter.constructor.name, 'MongoDateTimeUtcInterface');
  assert.notStrictEqual(created.defaultValue, undefined);
});

check('the GraphQL schema takes a status on both create and update', () => {
  const create = system.graphQLSchema.getType('OrderCreateInput').getFields();
  const update = system.graphQLSchema.getType('OrderUpdateInput').getFields();
  assert.ok(create.status, 'OrderCreateInput has no status');
  assert.ok(update.status, 'OrderUpdateInput has no status');
  // This field version maps a select onto a String, not a GraphQL enum: its
  // implementation never reads `dataType: 'enum'`. Asserted so nobody goes
  // hunting for an enum that this stack will never generate.
  const order = system.graphQLSchema.getType('Order').getFields();
  assert.strictEqual(String(order.status.type), 'String');
});

console.log('\nWhat the admin UI actually receives');

check('the status field is in the admin meta, labelled Status', () => {
  assert.ok(metaField, 'status is missing from the admin meta');
  assert.strictEqual(metaField.label, 'Status');
  assert.strictEqual(metaField.isRequired, true);
  assert.strictEqual(metaField.defaultValue, 'CREATED');
});

check('the admin UI renders it as a plain value, not a select (version limit)', () => {
  // Documented, not desired: this is the reason the state machine lives in the
  // hook. When the pinned version is upgraded and `views` becomes non-empty,
  // this check flips and finding F2 can be closed for real.
  assert.deepStrictEqual(Object.keys(field.views || {}), []);
  assert.strictEqual(field.adapter.constructor.name, 'MongoTextInterface');
});

check('the list ui config is not honoured (so none is shipped)', () => {
  // The shipped default is the first fields: `label,total`. Had ui.listView been
  // honoured it would name status/user/createdAt, and had ui.labelField been
  // honoured meta.labelField would be 'label'. Neither is true here.
  assert.strictEqual(meta.labelField, undefined);
  assert.strictEqual(meta.adminConfig.defaultColumns, 'label,total');
  assert.ok(!/status/.test(meta.adminConfig.defaultColumns),
    'ui.listView WAS honoured — re-read finding F2 in docs/ORDER-STATUS.md');
  console.log(`  --  admin list columns: ${meta.adminConfig.defaultColumns} (ui.listView ignored)`);
});

console.log(`\nAdmin meta: Order fields = ${meta.fields.map((f) => f.path).join(', ')}`);
console.log('\nGraphQL surface touching status:');
console.log(
  require('graphql')
    .printSchema(system.graphQLSchema)
    .split('\n')
    .filter((line) => /status/i.test(line))
    .map((line) => `  ${line.trim()}`)
    .join('\n'),
);

if (failures) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nPASS: Keystone generated the schema and admin meta for the order lifecycle');
