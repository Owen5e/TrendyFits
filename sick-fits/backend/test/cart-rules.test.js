#!/usr/bin/env node
'use strict';

/**
 * Cart line rules — the executable half of day 20's "max stock" bullet.
 *
 * WHAT IT CHECKS
 * `lib/cartRules.ts` is deliberately free of Keystone imports, so it can be
 * compiled and run here with the project's own `typescript` devDependency and no
 * database, in the same way `access-rules.test.js` runs the access rules. The
 * assertions cover the three questions every cart screen asks:
 *
 *   1. how many of this product may a line hold?
 *   2. what happens to a quantity that is out of bounds?
 *   3. what happens when a browser-side and a server-side quantity meet?
 *
 * It then reads `mutations/addToCart.ts` and asserts the mutation actually uses
 * these rules — a cap that no write path consults is not a cap.
 *
 * RUN
 *   npm run test:cart
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BACKEND = path.resolve(__dirname, '..');
const RULES_TS = path.join(BACKEND, 'lib', 'cartRules.ts');
const ADD_TO_CART_TS = path.join(BACKEND, 'mutations', 'addToCart.ts');
const SCHEMAS = path.join(BACKEND, 'schemas');

// Read CODE, not commentary — the source comments quote the numbers and the
// error strings being asserted.
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

const rules = loadTs(RULES_TS, {});
const { DEFAULT_LINE_LIMIT, MIN_LINE_QUANTITY, lineLimit, clampQuantity, mergeQuantity } = rules;
assert(typeof lineLimit === 'function', 'lib/cartRules.ts did not export lineLimit');
assert(typeof clampQuantity === 'function', 'lib/cartRules.ts did not export clampQuantity');
assert(typeof mergeQuantity === 'function', 'lib/cartRules.ts did not export mergeQuantity');

console.log('\nHow many may one line hold?');
check('a product with stock caps at its stock', () => {
  assert.strictEqual(lineLimit({ stock: 3 }), 3);
  assert.strictEqual(lineLimit({ stock: 1 }), 1);
  assert.strictEqual(lineLimit({ stock: 250 }), 250);
});
check('a product without stock falls back to the default line limit', () => {
  assert.strictEqual(lineLimit({}), DEFAULT_LINE_LIMIT);
  assert.strictEqual(lineLimit({ stock: null }), DEFAULT_LINE_LIMIT);
  assert.strictEqual(lineLimit({ stock: undefined }), DEFAULT_LINE_LIMIT);
  assert.strictEqual(lineLimit(null), DEFAULT_LINE_LIMIT);
  assert.strictEqual(lineLimit(undefined), DEFAULT_LINE_LIMIT);
});
check('a nonsense stock value is not treated as "sold out"', () => {
  assert.strictEqual(lineLimit({ stock: 0 }), DEFAULT_LINE_LIMIT);
  assert.strictEqual(lineLimit({ stock: -5 }), DEFAULT_LINE_LIMIT);
  assert.strictEqual(lineLimit({ stock: 'lots' }), DEFAULT_LINE_LIMIT);
  assert.strictEqual(lineLimit({ stock: NaN }), DEFAULT_LINE_LIMIT);
});
check('a fractional stock rounds down, never up', () => {
  assert.strictEqual(lineLimit({ stock: 2.9 }), 2);
});
check('the mirror in the frontend lib carries the same numbers', () => {
  const frontend = fs.readFileSync(
    path.join(BACKEND, '..', 'frontend', 'lib', 'cartLines.js'),
    'utf8',
  );
  const value = (name) => {
    const m = stripComments(frontend).match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  assert.strictEqual(value('DEFAULT_LINE_LIMIT'), DEFAULT_LINE_LIMIT,
    'the backend and frontend line limits have drifted apart — the + button and the server disagree');
  assert.strictEqual(value('MIN_LINE_QUANTITY'), MIN_LINE_QUANTITY);
});

console.log('\nOut-of-bounds quantities are folded, never stored raw');
check('clamping keeps a quantity inside 1..limit', () => {
  assert.strictEqual(clampQuantity(0, 5), MIN_LINE_QUANTITY);
  assert.strictEqual(clampQuantity(-12, 5), MIN_LINE_QUANTITY);
  assert.strictEqual(clampQuantity(3, 5), 3);
  assert.strictEqual(clampQuantity(1000, 5), 5);
});
check('a string quantity is read as a number', () => {
  assert.strictEqual(clampQuantity('2', 5), 2);
});
check('an unusable quantity becomes the minimum, not NaN', () => {
  assert.strictEqual(clampQuantity(NaN, 5), MIN_LINE_QUANTITY);
  assert.strictEqual(clampQuantity('many', 5), MIN_LINE_QUANTITY);
  assert.strictEqual(clampQuantity(undefined, 5), MIN_LINE_QUANTITY);
});
check('an unusable limit falls back to the default limit', () => {
  assert.strictEqual(clampQuantity(4, 0), 4);
  assert.strictEqual(clampQuantity(999, 0), DEFAULT_LINE_LIMIT);
  assert.strictEqual(clampQuantity(999, undefined), DEFAULT_LINE_LIMIT);
});

console.log('\nMerging a browser cart into a server cart (day 21 rule)');
check('the larger quantity wins — merging never sums', () => {
  assert.strictEqual(mergeQuantity(1, 3), 3, 'merge summed or picked the server value');
  assert.strictEqual(mergeQuantity(3, 1), 3, 'merge lost the server line');
  assert.strictEqual(mergeQuantity(2, 2), 2, 'merge double-counted an item added in both places');
});
check('a line that exists only in the browser survives intact', () => {
  assert.strictEqual(mergeQuantity(0, 4), 4);
  assert.strictEqual(mergeQuantity(undefined, 4), 4);
});
check('a line that exists only on the server is kept', () => {
  assert.strictEqual(mergeQuantity(4, 0), 4);
  assert.strictEqual(mergeQuantity(4, undefined), 4);
});
check('the merged quantity still respects the line ceiling', () => {
  assert.strictEqual(mergeQuantity(4, 9), 9, 'a merge under the ceiling was capped for no reason');
  assert.strictEqual(mergeQuantity(4, 99), DEFAULT_LINE_LIMIT, 'a merge over the ceiling was not capped');
  assert.strictEqual(mergeQuantity(99, 99), DEFAULT_LINE_LIMIT);
});
check('garbage on either side cannot become the merged quantity', () => {
  assert.strictEqual(mergeQuantity(NaN, 3), 3);
  assert.strictEqual(mergeQuantity(3, NaN), 3);
  assert.strictEqual(mergeQuantity(NaN, NaN), MIN_LINE_QUANTITY);
});

console.log('\nThe write path actually consults the rules');
check('addToCart imports lineLimit from lib/cartRules', () => {
  const src = stripComments(fs.readFileSync(ADD_TO_CART_TS, 'utf8'));
  assert.match(src, /from '\.\.\/lib\/cartRules'/, 'addToCart does not import the cart rules');
  assert.match(src, /lineLimit\(/, 'addToCart imports the rules but never calls lineLimit');
});
check('addToCart reads the product before it writes, so the cap is the real one', () => {
  const src = stripComments(fs.readFileSync(ADD_TO_CART_TS, 'utf8'));
  assert.match(src, /Product\.findOne\(/,
    'addToCart increments without reading the product — the ceiling would be a guess');
  assert.match(src, /if \(newQuantity > limit\)/,
    'the increment path has no ceiling — an over-limit quantity can still be written');
});
check('the refusal names the limit and the current quantity', () => {
  const src = stripComments(fs.readFileSync(ADD_TO_CART_TS, 'utf8'));
  assert.match(src, /Only \$\{limit\}/, 'the refusal does not tell the customer the limit');
  assert.match(src, /your bag already has \$\{currentQuantity\}/,
    'the refusal does not say what the bag already holds');
});
check('Product has a stock field for the ceiling to read', () => {
  const src = stripComments(fs.readFileSync(path.join(SCHEMAS, 'Product.ts'), 'utf8'));
  assert.match(src, /stock:\s*integer\(/, 'Product has no stock field');
});

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`FAIL: ${failures} cart-rule check(s) failed`);
  process.exit(1);
}
console.log('PASS: cart line quantities are capped by the product stock on both sides of the wire');
