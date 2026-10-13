#!/usr/bin/env node
'use strict';

/**
 * Day 21's write path: `mergeCart`, the mutation that folds a browser-held cart
 * into a signed-in customer's account.
 *
 * WHY IT IS SEPARATE FROM cart-rules.test.js
 * That file proves the RULES (how many, clamped how, merged how). This file proves
 * the WRITE PATH uses them: what actually gets written, what is deliberately left
 * alone, and what is dropped. `mergeCart.ts` is compiled in-process with the
 * project's own `typescript` devDependency and given a fake Keystone context, so
 * every assertion below is about real behaviour rather than a copy of the source.
 * No database, no server, no Stripe.
 *
 * The acceptance check this proves (day 21): "Add items signed out, sign in, and
 * nothing is lost or double-counted."
 *
 * RUN
 *   npm run test:merge
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BACKEND = path.resolve(__dirname, '..');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

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

let failures = 0;
let checks = 0;
const pending = [];

function check(label, fn) {
  checks++;
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(() => console.log(`  ok  ${label}`))
      .catch((err) => {
        failures++;
        console.error(`  FAIL ${label}`);
        console.error(`       ${err.message}`);
      }),
  );
}

// The real rules, loaded from source — same module the mutation imports.
const rules = loadTs(path.join(BACKEND, 'lib', 'cartRules.ts'), {});
const mergeCart = loadTs(path.join(BACKEND, 'mutations', 'mergeCart.ts'), {
  '../lib/cartRules': rules,
}).default;

assert(typeof mergeCart === 'function', 'mutations/mergeCart.ts has no default export');
assert(typeof rules.mergeQuantity === 'function', 'lib/cartRules.ts has no mergeQuantity');

const USER = 'user-1';
const OTHER_USER = 'user-2';

function fakeContext({
  product = { id: 'p1', name: 'Yeti Hondo', stock: 5 },
  existing = [],
  session = { itemId: USER },
} = {}) {
  const calls = { findMany: [], findOne: [], writes: [] };
  return {
    calls,
    session,
    lists: {
      CartItem: {
        findMany: async (args) => {
          calls.findMany.push(args);
          return existing;
        },
      },
      Product: {
        findOne: async (args) => {
          calls.findOne.push(args);
          return product;
        },
      },
    },
    graphql: {
      run: async (args) => {
        calls.writes.push(args);
        if (args.query.includes('updateCartItem')) {
          return { updateCartItem: { id: args.variables.id, quantity: args.variables.quantity } };
        }
        if (args.query.includes('createCartItem')) {
          return { createCartItem: { id: 'cart-new', quantity: args.variables.quantity } };
        }
        throw new Error(`unexpected query in mergeCart: ${args.query}`);
      },
    },
  };
}

console.log('\nWhat the merge is allowed to write');

check('browser 3 + server 1 writes 3 — the larger wins, never the sum', async () => {
  const context = fakeContext({ existing: [{ id: 'cart-1', quantity: 1, product: 'p1' }] });
  const result = await mergeCart({}, { items: [{ productId: 'p1', quantity: 3 }] }, context);

  assert.strictEqual(context.calls.writes.length, 1, 'expected exactly one write');
  assert.strictEqual(
    context.calls.writes[0].variables.quantity,
    3,
    'mergeCart summed the quantities — an item added twice would be double-counted',
  );
  assert.deepStrictEqual(result, [{ id: 'cart-1', quantity: 3 }]);
});

check('browser 2 + server 4 writes NOTHING and returns the server line untouched', async () => {
  const context = fakeContext({ existing: [{ id: 'cart-1', quantity: 4, product: { id: 'p1' } }] });
  const result = await mergeCart({}, { items: [{ productId: 'p1', quantity: 2 }] }, context);

  assert.strictEqual(context.calls.writes.length, 0, 'the server already had more — nothing to write');
  assert.deepStrictEqual(
    result,
    [{ id: 'cart-1', quantity: 4 }],
    'the server line came back replaced by the smaller browser quantity — that loses data',
  );
});

check('browser 2 + server 2 writes NOTHING — neither double-counted nor lost', async () => {
  const context = fakeContext({ existing: [{ id: 'cart-1', quantity: 2, product: 'p1' }] });
  const result = await mergeCart({}, { items: [{ productId: 'p1', quantity: 2 }] }, context);

  assert.strictEqual(context.calls.writes.length, 0);
  assert.deepStrictEqual(result, [{ id: 'cart-1', quantity: 2 }]);
});

check('a browser-only line is created against the session user', async () => {
  const context = fakeContext({ existing: [] });
  await mergeCart({}, { items: [{ productId: 'p1', quantity: 2 }] }, context);

  assert.strictEqual(context.calls.writes.length, 1);
  assert.match(context.calls.writes[0].query, /createCartItem/);
  assert.strictEqual(context.calls.writes[0].variables.quantity, 2);
  assert.strictEqual(context.calls.writes[0].variables.userId, USER);
});

check('a merge never deletes anything', async () => {
  const context = fakeContext({ existing: [{ id: 'cart-1', quantity: 1, product: 'p1' }] });
  await mergeCart({}, { items: [{ productId: 'p1', quantity: 3 }] }, context);
  assert.ok(
    !/delete/i.test(context.calls.writes[0].query),
    'a merge that deletes is a merge that can lose a line',
  );
});

check('the merged quantity is still capped by the product stock', async () => {
  const context = fakeContext({ product: { id: 'p1', name: 'Yeti', stock: 2 }, existing: [] });
  await mergeCart({}, { items: [{ productId: 'p1', quantity: 9 }] }, context);
  assert.strictEqual(context.calls.writes[0].variables.quantity, 2);
});

check('a duplicated line in the payload folds into one write', async () => {
  const context = fakeContext({ existing: [] });
  await mergeCart(
    {},
    { items: [{ productId: 'p1', quantity: 2 }, { productId: 'p1', quantity: 3 }] },
    context,
  );
  assert.strictEqual(context.calls.writes.length, 1, 'two lines for one product must fold into one write');
  assert.strictEqual(context.calls.writes[0].variables.quantity, 3);
});

console.log('\nWhat the merge is NOT allowed to touch');

check('refuses to run for a signed-out caller', async () => {
  await assert.rejects(
    () => mergeCart({}, { items: [{ productId: 'p1', quantity: 1 }] }, fakeContext({ session: null })),
    /must be logged in/,
  );
});

check('does nothing at all for an empty or malformed list', async () => {
  const context = fakeContext();
  assert.deepStrictEqual(await mergeCart({}, { items: [] }, context), []);
  assert.deepStrictEqual(await mergeCart({}, {}, context), []);
  assert.deepStrictEqual(await mergeCart({}, { items: [null, { quantity: 2 }, { productId: 'p1', quantity: 0 }] }, context), []);
  assert.strictEqual(context.calls.writes.length, 0);
});

check("only ever reads and writes the session's own cart", async () => {
  const context = fakeContext();
  await mergeCart({}, { items: [{ productId: 'p1', quantity: 1 }] }, context);

  assert.strictEqual(context.calls.findMany.length, 1);
  assert.deepStrictEqual(
    context.calls.findMany[0].where,
    { user: { id: USER } },
    'mergeCart did not scope its read to the session user',
  );
  assert.notStrictEqual(context.calls.findMany[0].where.user.id, OTHER_USER);
});

check('a product that is no longer purchasable is dropped, not resurrected', async () => {
  const context = fakeContext({ product: null });
  const result = await mergeCart({}, { items: [{ productId: 'gone', quantity: 2 }] }, context);

  assert.deepStrictEqual(result, []);
  assert.strictEqual(context.calls.writes.length, 0);
  assert.strictEqual(context.calls.findOne.length, 1, 'the product must be read before it is trusted');
});

console.log('\nThe mutation is wired into the schema');

check('mergeCart is registered on the schema with its input type', () => {
  const src = stripComments(fs.readFileSync(path.join(BACKEND, 'mutations', 'index.ts'), 'utf8'));
  assert.match(src, /mergeCart\(items: \[CartLineInput!\]!\): \[CartItem\]/, 'mergeCart is not in the typeDefs');
  assert.match(src, /input CartLineInput/, 'the CartLineInput input type is missing');
  assert.match(src, /resolvers:[\s\S]*mergeCart/, 'mergeCart has no resolver');
  assert.match(src, /import mergeCart from '\.\/mergeCart'/, 'mergeCart is not imported');
});

check('mergeCart imports the shared rule rather than restating it', () => {
  const src = stripComments(fs.readFileSync(path.join(BACKEND, 'mutations', 'mergeCart.ts'), 'utf8'));
  assert.match(src, /from '\.\.\/lib\/cartRules'/);
  assert.match(src, /mergeQuantity\(/, 'mergeCart does not use the shared merge rule');
  assert.match(src, /lineLimit\(/, 'mergeCart does not consult the line ceiling');
});

Promise.all(pending).then(() => {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`FAIL: ${failures} merge-cart check(s) failed`);
    process.exit(1);
  }
  console.log('PASS: a browser cart merges into the account additively-safely — larger wins, never the sum, nothing deleted');
});
