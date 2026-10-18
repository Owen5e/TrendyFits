#!/usr/bin/env node
'use strict';

/**
 * Day 26 — order history and the status flow, exercised.
 *
 * WHAT IT CHECKS
 * The day's acceptance check was: "A customer sees only their own orders; staff
 * can move an order through its statuses." Those are two different promises, so
 * they are proved two different ways:
 *
 *   1. VISIBILITY — `Order.access.read` is loaded from the REAL `schemas/Order.ts`
 *      and its result is applied to a small table of orders belonging to two
 *      customers. The filter a signed-in customer gets back must select their rows
 *      and no one else's, and an anonymous caller must get `false`, not a filter.
 *   2. THE FLOW — `lib/orderStatus.ts` is loaded from its real source. Staff walk
 *      an order CREATED → PAID → FULFILLED → DELIVERED; every illegal edge, every
 *      backwards move and every move out of a final state is refused with a
 *      sentence that names both ends; a customer cannot set or move it at all,
 *      even if the layers above the hook were to let the write through.
 *
 * HOW IT LOADS TYPESCRIPT
 * Same harness as `access-rules.test.js`: the project's own `typescript`
 * (`ts.transpileModule`) plus a small `require` shim, so the assertions run
 * against the real schema and the real state machine rather than a copy. Only the
 * leaf imports are shimmed: the field factories record their config, `list()`
 * returns the config it was given, and `formatMoney` returns a placeholder.
 *
 * This is NOT a database test. There is no Postgres/Mongo in the loop: what is
 * proved is the access FILTER's semantics and the hook's decision, which is
 * exactly the logic that decides both promises. `docs/ORDER-STATUS.md` records
 * that boundary rather than pretending a live end-to-end run happened.
 *
 * RUN
 *   npm run test:orders
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BACKEND = path.resolve(__dirname, '..');
const ACCESS_TS = path.join(BACKEND, 'access.ts');
const FIELDS_TS = path.join(BACKEND, 'schemas', 'fields.ts');
const ORDER_TS = path.join(BACKEND, 'schemas', 'Order.ts');
const STATUS_TS = path.join(BACKEND, 'lib', 'orderStatus.ts');

// Comments quote the very patterns assertions look for, so they are stripped
// before any source-level check (day 19's lesson, kept).
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

let failures = 0;
let checks = 0;

function check(label, fn) {
  checks++;
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${label}`);
    console.error(`       ${err.message}`);
  }
}

function loadTs(file, shim) {
  const ts = require('typescript');
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;
  const mod = { exports: {} };
  const req = (id) => {
    if (Object.prototype.hasOwnProperty.call(shim, id)) return shim[id];
    throw new Error(`unexpected require(${id}) while loading ${path.basename(file)}`);
  };
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', js)(req, mod, mod.exports);
  return mod.exports;
}

// ---------------------------------------------------------------- load the real source
const fieldsModule = loadTs(FIELDS_TS, { '@keystone-next/fields': { checkbox: () => ({}) } });
const permissionsList = fieldsModule.permissionsList;

const access = loadTs(ACCESS_TS, {
  './schemas/fields': fieldsModule,
  './types': {},
});

const status = loadTs(STATUS_TS, {});
const fieldAccess = loadTs(path.join(BACKEND, 'lib', 'fieldAccess.ts'), {});

// Field factories record what the schema asked for.
const recorded = {};
const fieldFactory = (name) => (config) => {
  recorded[name] = config;
  return { __field: name, config };
};

const schema = loadTs(ORDER_TS, {
  '@keystone-next/fields': {
    integer: fieldFactory('integer'),
    relationship: fieldFactory('relationship'),
    select: fieldFactory('select'),
    text: fieldFactory('text'),
    timestamp: fieldFactory('timestamp'),
    virtual: fieldFactory('virtual'),
  },
  '@keystone-next/keystone/schema': { list: (config) => config },
  '../lib/formatMoney': () => '$0.00',
  '../lib/orderStatus': status,
  '../lib/fieldAccess': fieldAccess,
  '../access': access,
});

const Order = schema.Order;
assert(Order && Order.fields, 'schemas/Order.ts did not export an Order list config');

// ---------------------------------------------------------------- caller fixtures
const OWNER = 'user-1';
const OTHER = 'user-2';

function sessionFor(id, granted = {}) {
  const role = {};
  permissionsList.forEach((p) => { role[p] = Boolean(granted[p]); });
  return { session: { itemId: id, data: { name: 'Ada', role } } };
}

const ANON = { session: null };
const CUSTOMER_A = sessionFor(OWNER);
const CUSTOMER_B = sessionFor(OTHER);
const STAFF = sessionFor('staff-9', { canManageOrders: true });

const accessArgs = (fixture, operation = 'read') => ({
  ...fixture,
  listKey: 'Order',
  context: {},
  operation,
});

const callAccess = (fn, fixture, operation) => {
  assert.strictEqual(typeof fn, 'function', 'expected an access function, got ' + typeof fn);
  return fn(accessArgs(fixture, operation));
};

// ---------------------------------------------------------------- 1. visibility
console.log('\nA customer sees only their own orders');

check('Order.read denies an anonymous caller outright', () => {
  assert.strictEqual(callAccess(Order.access.read, ANON), false);
});

check('Order.read hands a customer a FILTER scoped to their own user id', () => {
  assert.deepStrictEqual(callAccess(Order.access.read, CUSTOMER_A), { user: { id: OWNER } });
  assert.deepStrictEqual(callAccess(Order.access.read, CUSTOMER_B), { user: { id: OTHER } });
});

check('Order.read is unrestricted only for a permission holder', () => {
  assert.strictEqual(callAccess(Order.access.read, STAFF), true);
});

check('the shop-wide cart rule is NOT widened by the order permission', () => {
  // canOrder also guards CartItem: an order manager may read every order, but not
  // every customer's basket. Proving the negative is the whole point of a separate
  // rule (day 26 finding F1).
  assert.deepStrictEqual(
    callAccess(access.rules.canOrder, STAFF),
    { user: { id: 'staff-9' } },
  );
  assert.strictEqual(callAccess(access.rules.canManageOrderItems, STAFF), true);
});

check('applied to real rows, the customer filter returns their orders and no one else\'s', () => {
  const orders = [
    { id: 'o1', user: { id: OWNER }, total: 1200, charge: 'ch_1' },
    { id: 'o2', user: { id: OTHER }, total: 3400, charge: 'ch_2' },
    { id: 'o3', user: { id: OWNER }, total: 500, charge: 'ch_3' },
    { id: 'o4', user: { id: OTHER }, total: 9000, charge: 'ch_4' },
  ];

  // Keystone turns the returned object into a where-clause. This is that
  // clause's semantics on the rows: relationship match by id.
  const selectFor = (filter) => (rows) => {
    if (filter === false) return [];
    if (filter === true) return rows.slice();
    return rows.filter((row) => row.user && row.user.id === filter.user.id);
  };

  const visibleToA = selectFor(callAccess(Order.access.read, CUSTOMER_A))(orders);
  const visibleToB = selectFor(callAccess(Order.access.read, CUSTOMER_B))(orders);
  const visibleToAnon = selectFor(callAccess(Order.access.read, ANON))(orders);

  assert.deepStrictEqual(visibleToA.map((o) => o.id), ['o1', 'o3']);
  assert.deepStrictEqual(visibleToB.map((o) => o.id), ['o2', 'o4']);
  assert.deepStrictEqual(visibleToAnon, []);
  // The explicit negative: B's order id can never appear in A's result.
  assert.ok(!visibleToA.some((o) => o.id === 'o2' || o.id === 'o4'));
  // And staff still see everything, which is what the admin UI needs.
  assert.deepStrictEqual(selectFor(callAccess(Order.access.read, STAFF))(orders).length, 4);
});

check('order history is immutable from the customer side and undeletable from all sides', () => {
  assert.strictEqual(callAccess(Order.access.update, CUSTOMER_A, 'update'), false);
  assert.strictEqual(callAccess(Order.access.update, CUSTOMER_B, 'update'), false);
  assert.strictEqual(callAccess(Order.access.update, STAFF, 'update'), true);
  assert.strictEqual(Order.access.delete(accessArgs(ANON, 'delete')), false);
  assert.strictEqual(Order.access.delete(accessArgs(CUSTOMER_A, 'delete')), false);
  assert.strictEqual(Order.access.delete(accessArgs(STAFF, 'delete')), false);
});

// ---------------------------------------------------------------- 2. the status field
console.log('\nThe status field exists, is staff-only, and starts at Created');

const statusField = Order.fields.status && Order.fields.status.config;

check('Order has a status select field', () => {
  assert.ok(statusField, 'Order.fields.status is missing — the admin flow has nothing to move');
  assert.strictEqual(Order.fields.status.__field, 'select');
});

check('its options are exactly the known statuses, labelled for humans', () => {
  assert.deepStrictEqual(
    statusField.options.map((o) => o.value),
    status.ORDER_STATUSES.slice(),
  );
  statusField.options.forEach((option) => {
    assert.strictEqual(option.label, status.STATUS_LABELS[option.value]);
  });
});

check('it defaults to CREATED and is required', () => {
  assert.strictEqual(statusField.defaultValue, 'CREATED');
  assert.strictEqual(statusField.isRequired, true);
});

check('a customer cannot set the status on create, nor move it on update', () => {
  assert.strictEqual(statusField.access.create(accessArgs(ANON, 'create')), false);
  assert.strictEqual(statusField.access.create(accessArgs(CUSTOMER_A, 'create')), false);
  assert.strictEqual(statusField.access.update(accessArgs(CUSTOMER_A, 'update')), false);
  assert.strictEqual(statusField.access.create(accessArgs(STAFF, 'create')), true);
  assert.strictEqual(statusField.access.update(accessArgs(STAFF, 'update')), true);
});

check('the timestamps are facts, not editable fields', () => {
  const createdAt = Order.fields.createdAt.config;
  const changedAt = Order.fields.statusChangedAt.config;
  assert.strictEqual(createdAt.access.create(accessArgs(STAFF, 'create')), false);
  assert.strictEqual(createdAt.access.update(accessArgs(STAFF, 'update')), false);
  assert.strictEqual(changedAt.access.create(accessArgs(STAFF, 'create')), false);
  assert.strictEqual(changedAt.access.update(accessArgs(STAFF, 'update')), false);
  // A function, so every order gets its own time rather than the boot time.
  assert.strictEqual(typeof createdAt.defaultValue, 'function');
  assert.ok(!Number.isNaN(Date.parse(createdAt.defaultValue())), 'createdAt default is not a date');
  assert.strictEqual(typeof changedAt.defaultValue, 'function');
});

check('no admin-UI config is shipped that the pinned Keystone version silently drops', () => {
  // Found on 2026-10-18: @keystone-next/keystone 9.3.1 accepts ui.labelField,
  // ui.listView and ui.displayMode in its TYPES but never wires them into
  // createList (its initConfig has a FIXME listing them as unsupported). The
  // first draft of this day shipped all four and they were dead config that the
  // admin UI never saw. They are gone; `npm run check:schema` prints what the
  // admin meta really contains. See docs/ORDER-STATUS.md, finding F2.
  assert.strictEqual(Order.ui, undefined, 'Order.ui is dropped by this Keystone version');
  assert.strictEqual(statusField.ui, undefined, 'field ui is dropped by this Keystone version');
});

// ---------------------------------------------------------------- 3. the state machine
console.log('\nThe state machine moves forward only');

check('the happy path walks CREATED -> PAID -> FULFILLED -> DELIVERED', () => {
  const path = ['CREATED', 'PAID', 'FULFILLED', 'DELIVERED'];
  for (let i = 0; i < path.length - 1; i++) {
    assert.strictEqual(status.canTransition(path[i], path[i + 1]), true,
      `${path[i]} -> ${path[i + 1]} should be legal`);
    assert.strictEqual(status.assertTransition(path[i], path[i + 1]), path[i + 1]);
  }
  assert.deepStrictEqual(status.STATUS_FLOW, path);
});

check('cancellation is reachable before fulfilment and nowhere after it', () => {
  assert.strictEqual(status.canTransition('CREATED', 'CANCELLED'), true);
  assert.strictEqual(status.canTransition('PAID', 'CANCELLED'), true);
  assert.strictEqual(status.canTransition('FULFILLED', 'CANCELLED'), false);
  assert.strictEqual(status.canTransition('DELIVERED', 'CANCELLED'), false);
});

check('a skipped step is refused, not silently accepted', () => {
  assert.strictEqual(status.canTransition('CREATED', 'DELIVERED'), false);
  assert.strictEqual(status.canTransition('CREATED', 'FULFILLED'), false);
  assert.throws(() => status.assertTransition('CREATED', 'DELIVERED'), (err) => {
    assert.strictEqual(err.code, 'invalid_status_transition');
    assert.match(err.message, /Created/);
    assert.match(err.message, /Delivered/);
    assert.match(err.message, /Paid/); // names the legal alternative
    return true;
  });
});

check('a backwards move is refused', () => {
  assert.strictEqual(status.canTransition('PAID', 'CREATED'), false);
  assert.strictEqual(status.canTransition('FULFILLED', 'PAID'), false);
});

check('final states are final and say so', () => {
  assert.deepStrictEqual(status.nextStatuses('DELIVERED'), []);
  assert.deepStrictEqual(status.nextStatuses('CANCELLED'), []);
  assert.throws(() => status.assertTransition('DELIVERED', 'PAID'), /final state/);
  assert.throws(() => status.assertTransition('CANCELLED', 'PAID'), /final state/);
});

check('an invented status is refused by name, not swallowed', () => {
  assert.strictEqual(status.canTransition('PAID', 'SHIPPED'), false);
  assert.throws(() => status.assertTransition('PAID', 'SHIPPED'), (err) => {
    assert.strictEqual(err.code, 'unknown_target_status');
    assert.match(err.message, /SHIPPED/);
    return true;
  });
});

check('re-saving the same status is a no-op, not an error', () => {
  assert.strictEqual(status.canTransition('PAID', 'PAID'), true);
});

check('nextStatuses lists only legal edges', () => {
  assert.deepStrictEqual(status.nextStatuses('CREATED'), ['PAID', 'CANCELLED']);
  assert.deepStrictEqual(status.nextStatuses('PAID'), ['FULFILLED', 'CANCELLED']);
  assert.deepStrictEqual(status.nextStatuses('FULFILLED'), ['DELIVERED']);
});

// ---------------------------------------------------------------- 4. the hook
console.log('\nThe hook that every write passes through');

check('the hook is wired into the Order list', () => {
  assert.strictEqual(typeof Order.hooks.resolveInput, 'function');
});

const runHook = (args) => Order.hooks.resolveInput(args);

check('a new order starts at Created, with a stamp', () => {
  const out = runHook({
    operation: 'create',
    resolvedData: { total: 1200, charge: 'ch_1' },
    context: CUSTOMER_A,
  });
  assert.strictEqual(out.status, 'CREATED');
  assert.ok(!Number.isNaN(Date.parse(out.statusChangedAt)), 'statusChangedAt was not stamped');
  assert.strictEqual(out.total, 1200);
});

check('a customer cannot smuggle a status in on create', () => {
  assert.throws(
    () => runHook({
      operation: 'create',
      resolvedData: { total: 1200, status: 'DELIVERED' },
      context: CUSTOMER_A,
    }),
    /Only staff can create an order in a status other than Created/,
  );
});

check('staff may create a phone order already PAID, and it is stamped', () => {
  const out = runHook({
    operation: 'create',
    resolvedData: { total: 1200, status: 'PAID' },
    context: STAFF,
  });
  assert.strictEqual(out.status, 'PAID');
  assert.ok(!Number.isNaN(Date.parse(out.statusChangedAt)));
});

check('staff moving CREATED -> PAID gets the new status and a fresh stamp', () => {
  const out = runHook({
    operation: 'update',
    existingItem: { status: 'CREATED', statusChangedAt: '2026-10-01T00:00:00.000Z' },
    resolvedData: { status: 'PAID' },
    context: STAFF,
  });
  assert.strictEqual(out.status, 'PAID');
  assert.notStrictEqual(out.statusChangedAt, '2026-10-01T00:00:00.000Z');
});

check('staff walking the whole flow is allowed end to end', () => {
  let item = { status: 'CREATED' };
  ['PAID', 'FULFILLED', 'DELIVERED'].forEach((next) => {
    const out = runHook({
      operation: 'update',
      existingItem: item,
      resolvedData: { status: next },
      context: STAFF,
    });
    assert.strictEqual(out.status, next);
    item = { status: out.status };
  });
});

check('an illegal jump is refused through the hook, with the reason', () => {
  assert.throws(
    () => runHook({
      operation: 'update',
      existingItem: { status: 'CREATED' },
      resolvedData: { status: 'DELIVERED' },
      context: STAFF,
    }),
    /cannot go from Created to Delivered.*Paid or Cancelled/s,
  );
});

check('a customer cannot move it even if the write reaches the hook', () => {
  assert.throws(
    () => runHook({
      operation: 'update',
      existingItem: { status: 'CREATED' },
      resolvedData: { status: 'PAID' },
      context: CUSTOMER_A,
    }),
    /Only staff can change an order status/,
  );
});

check('a non-status edit leaves the status and its stamp untouched', () => {
  const out = runHook({
    operation: 'update',
    existingItem: { status: 'PAID' },
    resolvedData: { charge: 'ch_corrected' },
    context: STAFF,
  });
  assert.strictEqual(out.charge, 'ch_corrected');
  assert.strictEqual(out.status, undefined);
  assert.strictEqual(out.statusChangedAt, undefined);
});

check('re-saving the same status does not restamp the move time', () => {
  const out = runHook({
    operation: 'update',
    existingItem: { status: 'PAID' },
    resolvedData: { status: 'PAID' },
    context: STAFF,
  });
  assert.strictEqual(out.status, 'PAID');
  assert.strictEqual(out.statusChangedAt, undefined);
});

check('a final order cannot be moved back through the hook', () => {
  assert.throws(
    () => runHook({
      operation: 'update',
      existingItem: { status: 'DELIVERED' },
      resolvedData: { status: 'PAID' },
      context: STAFF,
    }),
    /final state/,
  );
});

// ---------------------------------------------------------------- report
const source = stripComments(fs.readFileSync(ORDER_TS, 'utf8'));
check('the schema and the state machine are the same source of truth', () => {
  assert.match(source, /from "\.\.\/lib\/orderStatus"/);
  assert.ok(!/options:\s*\[\s*\{\s*label/.test(source),
    'the status options look hand-copied instead of read from ORDER_STATUSES');
});

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
