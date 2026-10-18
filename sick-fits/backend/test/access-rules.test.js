#!/usr/bin/env node
'use strict';

/**
 * Access-control tests for the sick-fits backend — the executable half of
 * docs/ACCESS-AUDIT.md.
 *
 * WHAT IT CHECKS
 * Every rule in `sick-fits/backend/access.ts` and every list's access config is
 * exercised against the four caller classes that matter:
 *
 *   1. anonymous            (no session)
 *   2. signed in, no rights (a normal customer)
 *   3. signed in, owning    (a normal customer acting on their own rows)
 *   4. permission holder    (admin)
 *
 * The assertions encode the audit's promise: an anonymous or non-owning caller
 * must never receive `true` from a management rule, and may only ever receive a
 * FILTER that scopes them to their own rows. The single exception is
 * `canReadProducts`, which deliberately hands anonymous callers the filter
 * `{ status: 'Available' }` — and the test proves it is a filter, not `true`,
 * because `true` there would publish Draft and Unavailable products.
 *
 * HOW IT LOADS TYPESCRIPT
 * `access.ts` and `schemas/fields.ts` are compiled in-process with the project's
 * own `typescript` devDependency (`ts.transpileModule`) and evaluated with a
 * small `require` shim. That means the tests run against the REAL rule source,
 * not a copy of it — if someone edits the rules, these assertions change
 * behaviour immediately. Only the two leaf imports are shimmed:
 *
 *   '@keystone-next/fields'  -> { checkbox: () => ({}) }   (field factory)
 *   './types'                -> {}                          (types only)
 *
 * THE FINDINGS ARE CLOSED (day 19)
 * Section 4 of the audit listed F1, F2, F3, F4, F5 and F6. All six were fixed and
 * section 4 now records each fix. These tests used to pin the broken behaviour;
 * they now PROVE the holes are shut, reading the real rule or the real schema and
 * asserting the closed shape. A regression fails the suite with the finding named.
 * If you deliberately reopen one, change the test AND the audit doc in the same commit.
 *
 * RUN
 *   npm run test:access
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BACKEND = path.resolve(__dirname, '..');
const ACCESS_TS = path.join(BACKEND, 'access.ts');
const FIELDS_TS = path.join(BACKEND, 'schemas', 'fields.ts');
const SCHEMAS = path.join(BACKEND, 'schemas');

// Source-level assertions must read CODE, not commentary: the fix comments name the
// very patterns being checked for, so comments are stripped before matching. That
// keeps these checks about behaviour instead of about prose.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const read = (f) => stripComments(fs.readFileSync(path.join(SCHEMAS, f), 'utf8'));

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

// ---------------------------------------------------------------- load source
const fields = loadTs(FIELDS_TS, { '@keystone-next/fields': { checkbox: () => ({}) } });
const permissionsList = fields.permissionsList;
assert(Array.isArray(permissionsList) && permissionsList.length > 0,
  'schemas/fields.ts did not export a non-empty permissionsList');

const access = loadTs(ACCESS_TS, {
  './schemas/fields': fields,
  './types': {},
});
const { rules, permissions } = access;
assert(rules && permissions, 'access.ts did not export both rules and permissions');

// ---------------------------------------------------------------- caller fixtures
const OWNER = 'user-1';
const OTHER = 'user-2';

function sessionFor(id, granted = {}, name = 'Ada') {
  const role = {};
  permissionsList.forEach((p) => { role[p] = Boolean(granted[p]); });
  return { session: { itemId: id, data: { name, role } } };
}

const ANON = { session: null };
const NO_RIGHTS = sessionFor(OWNER);
const CART_RIGHTS = sessionFor(OWNER, { canManageCart: true });
const PRODUCT_RIGHTS = sessionFor(OWNER, { canManageProducts: true });
const USER_RIGHTS = sessionFor(OWNER, { canManageUsers: true });
const CATEGORY_RIGHTS = sessionFor(OWNER, { canManageCategories: true });
const ORDER_RIGHTS = sessionFor(OWNER, { canManageOrders: true });

console.log('\nAnonymous callers are denied every management rule');
['canManageProducts', 'canOrder', 'canManageOrderItems', 'canManageUsers', 'canManageCategories']
  .forEach((rule) => {
    check(`rules.${rule}(anonymous) === false`, () => {
      assert.strictEqual(rules[rule](ANON), false);
    });
  });

check('rules.canReadProducts(anonymous) is a FILTER, never true', () => {
  const result = rules.canReadProducts(ANON);
  assert.notStrictEqual(result, true,
    'canReadProducts returned true for an anonymous caller — that publishes Draft and Unavailable products');
  assert.deepStrictEqual(result, { status: 'Available' });
});

console.log('\nA permission holder is unrestricted');
check('rules.canManageProducts(with permission) === true', () => {
  assert.strictEqual(rules.canManageProducts(PRODUCT_RIGHTS), true);
});
check('rules.canOrder(with canManageCart) === true', () => {
  assert.strictEqual(rules.canOrder(CART_RIGHTS), true);
});
check('rules.canManageOrderItems(with canManageCart) === true', () => {
  assert.strictEqual(rules.canManageOrderItems(CART_RIGHTS), true);
});
check('rules.canManageUsers(with permission) === true', () => {
  assert.strictEqual(rules.canManageUsers(USER_RIGHTS), true);
});
check('rules.canManageCategories(with permission) === true', () => {
  assert.strictEqual(rules.canManageCategories(CATEGORY_RIGHTS), true);
});
check('rules.canReadProducts(with canManageProducts) === true', () => {
  assert.strictEqual(rules.canReadProducts(PRODUCT_RIGHTS), true);
});

console.log('\nA signed-in user with no rights is scoped to their own rows');
check('canManageProducts -> own products only', () => {
  assert.deepStrictEqual(rules.canManageProducts(NO_RIGHTS), { user: { id: OWNER } });
});
check('canOrder -> own cart items only', () => {
  assert.deepStrictEqual(rules.canOrder(NO_RIGHTS), { user: { id: OWNER } });
});
check('canManageOrderItems -> items of own orders only', () => {
  assert.deepStrictEqual(rules.canManageOrderItems(NO_RIGHTS), { order: { user: { id: OWNER } } });
});
check('canReadOrders -> own orders only, for a customer (day 26)', () => {
  assert.deepStrictEqual(rules.canReadOrders(NO_RIGHTS), { user: { id: OWNER } });
});
check('canManageUsers -> self only', () => {
  assert.deepStrictEqual(rules.canManageUsers(NO_RIGHTS), { id: OWNER });
});
check('a non-owner cannot reach another user\'s rows', () => {
  const other = sessionFor(OTHER);
  assert.deepStrictEqual(rules.canManageProducts(other), { user: { id: OTHER } });
  assert.notDeepStrictEqual(rules.canManageProducts(other), { user: { id: OWNER } });
});

console.log('\nPermission checks read the role from the session');
check('permissions.* deny an anonymous caller', () => {
  permissionsList.forEach((p) => assert.strictEqual(permissions[p](ANON), false, `${p} allowed anon`));
});
check('permissions.* return true when the role grants them', () => {
  permissionsList.forEach((p) => {
    const granted = sessionFor(OWNER, { [p]: true });
    assert.strictEqual(permissions[p](granted), true, `${p} ignored its own grant`);
  });
});
check('every permission declared in fields.ts has a callable checker', () => {
  permissionsList.forEach((p) => {
    assert.strictEqual(typeof permissions[p], 'function', `${p} has no checker in access.ts`);
  });
});
check('F4 closed: nothing is declared that the code does not enforce', () => {
  const accessText = stripComments(fs.readFileSync(ACCESS_TS, 'utf8'));
  assert.strictEqual((accessText.match(/isAwesome/g) || []).length, 0,
    'isAwesome is back in access.ts — F4 has regressed');
  assert.ok(!permissionsList.includes('canSeeOtherUsers'),
    'canSeeOtherUsers is back in permissionFields, offering a capability no rule grants — F4 has regressed');
  // every permission the Role screen can tick must be referenced by a schema or a rule
  const sourceText = fs.readdirSync(SCHEMAS)
    .filter((f) => f.endsWith('.ts') && f !== 'fields.ts')
    .map(read)
    .join('\n');
  permissionsList.forEach((p) => {
    assert.ok(sourceText.includes(p) || accessText.includes(p),
      `${p} is offered by the Role UI but enforced nowhere — F4 has regressed`);
  });
});

console.log('\nThe findings in docs/ACCESS-AUDIT.md are closed — each proved below');

const allSchemas = fs.readdirSync(SCHEMAS).filter((f) => f.endsWith('.ts') && f !== 'fields.ts');
const schemaText = allSchemas.map(read).join('\n');

check('F6 closed: a session without `data` denies instead of throwing', () => {
  const partial = { session: { itemId: OWNER } };
  permissionsList.forEach((p) => {
    assert.strictEqual(permissions[p](partial), false, `${p} allowed or threw on a partial session`);
  });
  ['canManageProducts', 'canOrder', 'canManageOrderItems', 'canManageUsers', 'canManageCategories',
   'canReadProducts', 'canReadOrders', 'canReadProductImages', 'canManageProductImages']
    .forEach((r) => assert.doesNotThrow(() => rules[r](partial), `rules.${r} threw on a partial session`));
});

check('F1 closed: a product image is only as public as its product', () => {
  const anon = rules.canReadProductImages(ANON);
  assert.notStrictEqual(anon, true,
    'canReadProductImages returned true for an anonymous caller — unpublished product images are public again');
  assert.deepStrictEqual(anon, { product: { status: 'Available' } });
  assert.strictEqual(rules.canReadProductImages(PRODUCT_RIGHTS), true);
  const src = read('ProductImage.ts');
  assert.match(src, /read:\s*rules\.canReadProductImages/,
    'ProductImage.read no longer uses the status-aware rule — F1 has regressed');
  assert.ok(!/read:\s*true/.test(src), 'ProductImage.read is world-readable again');
});

check('F2 closed: image writes mirror product ownership, not permission-only', () => {
  assert.strictEqual(rules.canManageProductImages(ANON), false);
  assert.deepStrictEqual(rules.canManageProductImages(NO_RIGHTS), { product: { user: { id: OWNER } } });
  assert.strictEqual(rules.canManageProductImages(PRODUCT_RIGHTS), true);
  assert.ok(!/permissions\.canManageProducts/.test(read('ProductImage.ts')),
    'ProductImage writes are permission-only again — F2 has regressed');
});

check('F3 closed: Category uses a rule it can actually satisfy', () => {
  const src = read('Category.ts');
  assert.ok(!/rules\.canManageProducts/.test(src),
    'Category is borrowing the product rule again — F3 has regressed');
  assert.match(src, /rules\.canManageCategories/);
  // the borrowed rule filtered on a column Category does not have; this one only answers
  assert.strictEqual(rules.canManageCategories(NO_RIGHTS), false);
  assert.strictEqual(rules.canManageCategories(CATEGORY_RIGHTS), true);
});

check('day 26: the order permission also lets staff SEE orders — and only orders', () => {
  // The status flow is unusable if a staff member cannot list the orders they may
  // move. `canReadOrders` grants that, while `canOrder` (which also guards
  // CartItem) deliberately does not widen: every basket in the shop stays private.
  assert.strictEqual(rules.canReadOrders(ORDER_RIGHTS), true);
  assert.strictEqual(rules.canReadOrders(CART_RIGHTS), true);
  assert.strictEqual(rules.canReadOrders(ANON), false);
  assert.deepStrictEqual(rules.canReadOrders(NO_RIGHTS), { user: { id: OWNER } });
  assert.match(read('Order.ts'), /read:\s*rules\.canReadOrders/,
    'Order.read no longer uses the order-specific rule');
  assert.deepStrictEqual(rules.canOrder(ORDER_RIGHTS), { user: { id: OWNER } },
    'canOrder was widened — an order manager can now read every customer basket');
  assert.strictEqual(rules.canManageOrderItems(ORDER_RIGHTS), true,
    'a staff member who may move an order cannot read its line items');
});

check('F5 closed: order corrections are gated on canManageOrders; nothing is deleted', () => {
  [['Order.ts', read('Order.ts')], ['OrderItems.ts', read('OrderItems.ts')]].forEach(([name, src]) => {
    assert.ok(!/update:\s*\(\)\s*=>\s*false/.test(src),
      `${name} still denies every update, so nobody can correct an order — F5 is open`);
    assert.match(src, /update:\s*permissions\.canManageOrders/, `${name}.update is not gated on canManageOrders`);
    assert.match(src, /delete:\s*\(\)\s*=>\s*false/,
      `${name}.delete changed — deleting financial history must stay impossible`);
  });
  assert.strictEqual(permissions.canManageOrders(ANON), false);
  assert.strictEqual(permissions.canManageOrders(NO_RIGHTS), false);
  assert.strictEqual(permissions.canManageOrders(ORDER_RIGHTS), true);
  assert.ok(schemaText.includes('canManageOrders'),
    'canManageOrders is declared but enforced nowhere — F4 has regressed');
});

console.log('\nAll access rules in every list are accounted for');
check('each list declares an access block with all four operations', () => {
  const lists = fs.readdirSync(SCHEMAS)
    .filter((f) => f.endsWith('.ts') && f !== 'fields.ts');
  assert.ok(lists.length >= 8, `expected the 8 audited lists, found ${lists.length}`);
  lists.forEach((file) => {
    const src = fs.readFileSync(path.join(SCHEMAS, file), 'utf8');
    assert.match(src, /access:\s*\{/, `${file} has no access block`);
    ['create', 'read', 'update', 'delete'].forEach((op) => {
      assert.match(src, new RegExp(`${op}\\s*:`), `${file} does not declare an access.${op} rule`);
    });
  });
});

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`FAIL: ${failures} access-control check(s) failed`);
  process.exit(1);
}
console.log('PASS: access rules deny anonymous and non-owning callers as documented in docs/ACCESS-AUDIT.md');
