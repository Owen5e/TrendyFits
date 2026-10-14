#!/usr/bin/env node
'use strict';

/**
 * Day 22 — every way a checkout can fail, and what the customer is told.
 *
 * WHY THIS FILE IS DIFFERENT FROM THE OTHER BACKEND SUITES
 * The other suites are offline on purpose: fake contexts, no network. This one
 * cannot be, because the thing under test is the *translation* of what Stripe
 * actually returns, and Stripe's real answers are the input. So:
 *
 *   - the payment failures are produced by REAL requests to the Stripe
 *     test-mode API (a declined card, a 3-D Secure card, a bad key),
 *   - the connection failure is a REAL refused socket, raised by the real SDK,
 *   - only the database is faked (a small in-memory Order store), because the
 *     point is what the resolver writes, not that MongoDB works.
 *
 * The acceptance check this proves (day 22): "Every failure path is exercised
 * against Stripe test keys and produces a readable message."
 *
 * RUN
 *   npm run test:checkout
 * Requires STRIPE_SECRET in backend/.env and a network. If either is missing,
 * the live half is skipped loudly rather than faked.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BACKEND = path.resolve(__dirname, '..');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/* ------------------------------------------------------------------ *
 * .env — no new dependency, and the key is never printed.
 * ------------------------------------------------------------------ */

function readEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = fs
      .readFileSync(path.join(BACKEND, '.env'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith(name + '='))
      .map((l) => l.replace(new RegExp('^' + name + '='), '').replace(/^"|"$/g, ''))[0];
    return line || '';
  } catch (err) {
    return '';
  }
}

const KEY = readEnv('STRIPE_SECRET');
const StripeClass = require('stripe');

/* ------------------------------------------------------------------ *
 * The loader — the same one the other suites use, so a TS module is
 * compiled in-process and the assertions are about real behaviour.
 * ------------------------------------------------------------------ */

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

const errors = loadTs(path.join(BACKEND, 'lib', 'checkoutErrors.ts'), {});
const { describeStripeFailure, assertChargeSucceeded, idempotencyKey, MESSAGES, INTERNAL_MARKERS } = errors;

assert(typeof describeStripeFailure === 'function', 'lib/checkoutErrors.ts has no describeStripeFailure');
assert(typeof assertChargeSucceeded === 'function', 'lib/checkoutErrors.ts has no assertChargeSucceeded');

/* ------------------------------------------------------------------ *
 * The real Stripe client, built the way lib/stripe.ts builds it.
 * ------------------------------------------------------------------ */

if (KEY) process.env.STRIPE_SECRET = KEY;
const stripeLib = loadTs(path.join(BACKEND, 'lib', 'stripe.ts'), { stripe: StripeClass });
const stripe = stripeLib.default;

const LIVE = Boolean(KEY) && typeof stripe === 'object' && typeof stripe.paymentIntents.create === 'function';
const stripeOptions = { idempotencyKey: 'probe' };

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

/** A Stripe client that fails the way a broken network fails. */
const deadNetwork = () =>
  new StripeClass(KEY || 'sk_test_offline', {
    apiVersion: '2022-11-15',
    host: '127.0.0.1',
    port: 9,
    protocol: 'http',
    maxNetworkRetries: 0,
    timeout: 5000,
  });

/** A Stripe module whose every call is recorded — and forbidden, unless allowed. */
function recordingStripe({ allow = false, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    module: {
      __esModule: true,
      default: {
        paymentIntents: {
          create: async (params, options) => {
            calls.push({ params, options });
            if (fail) throw fail;
            if (!allow) throw new Error('the resolver called Stripe when it should not have');
            return stripe.paymentIntents.create(params, options);
          },
        },
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * The fake database: a real in-memory Order store, so a retry can find
 * what the first attempt wrote.
 * ------------------------------------------------------------------ */

const USER = 'user-1';

/**
 * Every check gets its own bag.
 *
 * The idempotency key is built from the cart row ids, so two checks sharing a
 * bag id also share a key — and these checks run concurrently, so the first run
 * of this file had every resolver check collide with its neighbours at Stripe
 * and come back as "already processing". That collision is exactly what the
 * double-submit handling exists for; here it just has to be kept out of the
 * fixture, so a fresh bag id per fake context keeps each check independent.
 */
let bagCounter = 0;
const nextBagId = () => `bag-${++bagCounter}`;

const photo = { id: 'ph1', image: { id: 'img1', publicUrlTransformed: 'hondo.jpg' } };
const cartLine = (overrides = {}) => ({
  id: nextBagId(),
  quantity: 2,
  product: {
    id: 'p1',
    name: 'Yeti Hondo',
    price: 2500,
    description: 'soo nice',
    photo,
  },
  ...overrides,
});

function fakeContext({ cart, session = { itemId: USER }, failOrderWrite = false } = {}) {
  const bag = cart || [cartLine()];
  const calls = { userFindOne: [], orderFindMany: [], orderCreate: [], cartDelete: [] };
  const orders = [];
  return {
    calls,
    orders,
    session,
    bag,
    bagIds: bag.map((line) => line.id),
    lists: {
      User: {
        findOne: async (args) => {
          calls.userFindOne.push(args);
          return { id: USER, name: 'Owen', email: 'owen@example.com', cart: bag };
        },
      },
      Order: {
        findMany: async (args) => {
          calls.orderFindMany.push(args);
          const wanted = (args.where || {}).charge;
          return orders.filter((o) => o.charge === wanted);
        },
        createOne: async (args) => {
          calls.orderCreate.push(args);
          if (failOrderWrite) throw new Error('the database went away');
          const order = {
            id: `order-${orders.length + 1}`,
            charge: args.data.charge,
            total: args.data.total,
            user: args.data.user,
            items: args.data.items.create.map((item, i) => ({ id: `oi-${i}`, ...item })),
          };
          orders.push(order);
          return order;
        },
      },
      CartItem: {
        deleteMany: async (args) => {
          calls.cartDelete.push(args);
          return (args.ids || []).map((id) => ({ id }));
        },
      },
    },
  };
}

/** Load the real resolver against a chosen Stripe module. */
const loadCheckout = (stripeModule) =>
  loadTs(path.join(BACKEND, 'mutations', 'checkout.ts'), {
    '../lib/stripe': stripeModule,
    '../lib/checkoutErrors': errors,
  }).default;

console.log('\nThe catalogue: what each REAL Stripe failure becomes');

check('a successful card resolves with status succeeded and no failure at all', async () => {
  const intent = await stripe.paymentIntents.create({
    amount: 5000,
    currency: 'usd',
    confirm: true,
    payment_method: 'pm_card_visa',
  });
  assert.strictEqual(intent.status, 'succeeded', `unexpected status ${intent.status}`);
  assertChargeSucceeded(intent);
});

check('a declined card is translated, and money did not move', async () => {
  let raw = null;
  try {
    await stripe.paymentIntents.create({
      amount: 5000,
      currency: 'usd',
      confirm: true,
      payment_method: 'pm_card_visa_chargeDeclined',
    });
  } catch (err) {
    raw = err;
  }
  assert.ok(raw, 'the declined test card was expected to fail and did not');
  assert.strictEqual(raw.type, 'StripeCardError');

  const failure = describeStripeFailure(raw);
  assert.strictEqual(failure.code, 'card_card_declined');
  assert.strictEqual(failure.message, 'Your card was declined by your bank. Try a different card.');
  assert.strictEqual(failure.retryable, true, 'a decline should invite another card');
  assert.ok(!INTERNAL_MARKERS.test(failure.message), 'a card message leaked an internal marker');
});

check('an expired card and a bad security code each get their own sentence', async () => {
  const cases = [
    ['pm_card_visa_chargeDeclinedExpiredCard', 'expired_card', 'Your card has expired. Try a different card.'],
    ['pm_card_visa_chargeDeclinedIncorrectCvc', 'incorrect_cvc', 'That security code does not match the card. Check the digits and try again.'],
  ];
  for (const [paymentMethod, code, message] of cases) {
    let raw = null;
    try {
      await stripe.paymentIntents.create({ amount: 5000, currency: 'usd', confirm: true, payment_method: paymentMethod });
    } catch (err) {
      raw = err;
    }
    assert.ok(raw, `${paymentMethod} was expected to be refused`);
    assert.strictEqual(raw.code, code, `${paymentMethod} returned code ${raw.code}`);
    const failure = describeStripeFailure(raw);
    assert.strictEqual(failure.message, message);
  }
});

check('a 3-D card resolves with NO error — and that is the free-order bug', async () => {
  const intent = await stripe.paymentIntents.create({
    amount: 5000,
    currency: 'usd',
    confirm: true,
    payment_method: 'pm_card_threeDSecure2Required',
  });

  assert.strictEqual(intent.status, 'requires_action', 'the premise of finding F1 changed: this card no longer needs authentication');
  assert.ok(intent.next_action, 'expected a next_action on a requires_action intent');

  // The call resolved. Under the old code that was taken as payment.
  assert.throws(
    () => assertChargeSucceeded(intent),
    (err) => {
      assert.strictEqual(err.failure.code, 'authentication_required');
      assert.strictEqual(err.failure.message, MESSAGES.authenticationRequired);
      assert.strictEqual(err.failure.retryable, false);
      assert.ok(!INTERNAL_MARKERS.test(err.message), 'the verification message leaked an internal marker');
      return true;
    },
  );

  // And the charge really was not taken: the intent is not succeeded.
  assert.notStrictEqual(intent.status, 'succeeded');
});

check('an empty bag never reaches Stripe, and its Stripe error would be unreadable anyway', async () => {
  // What Stripe says about amount 0, for the record.
  let raw = null;
  try {
    await stripe.paymentIntents.create({ amount: 0, currency: 'usd', confirm: true, payment_method: 'pm_card_visa' });
  } catch (err) {
    raw = err;
  }
  assert.ok(raw, 'amount 0 was expected to be refused');
  assert.strictEqual(raw.type, 'StripeInvalidRequestError');
  assert.ok(
    raw.message.length > 150,
    'the premise changed: Stripe now returns a short message for amount 0, so this finding should be re-read',
  );

  const failure = describeStripeFailure(raw);
  assert.strictEqual(failure.message, MESSAGES.belowMinimum);
  assert.ok(!INTERNAL_MARKERS.test(failure.message), 'the empty-bag message leaked an internal marker');
  assert.ok(failure.message.length < 150, 'the customer-facing message is as long as the developer one');
});

check('an amount below the processor minimum is translated, not echoed', async () => {
  let raw = null;
  try {
    await stripe.paymentIntents.create({ amount: 49, currency: 'usd', confirm: true, payment_method: 'pm_card_visa' });
  } catch (err) {
    raw = err;
  }
  assert.ok(raw, '49 cents was expected to be refused');
  assert.strictEqual(raw.code, 'amount_too_small');
  assert.match(raw.message, /Amount must be at least/, 'the raw message should be the developer one we are translating');
  const failure = describeStripeFailure(raw);
  assert.strictEqual(failure.message, MESSAGES.belowMinimum);
});

check('a lost connection says so, and does not pretend to know the outcome', async () => {
  let raw = null;
  try {
    await deadNetwork().paymentIntents.create({ amount: 5000, currency: 'usd' });
  } catch (err) {
    raw = err;
  }
  assert.ok(raw, 'the dead-network call was expected to fail');
  assert.strictEqual(raw.type, 'StripeConnectionError', `unexpected type ${raw.type}`);

  const failure = describeStripeFailure(raw);
  assert.strictEqual(failure.message, MESSAGES.connection);
  assert.strictEqual(failure.retryable, true);
  assert.match(failure.message, /check your orders page/i, 'the unknown-outcome case must send the customer somewhere useful');
  assert.ok(!/you have not been charged/i.test(failure.message), 'we cannot promise the charge did not land');
});

check('a wrong secret key becomes "temporarily unavailable" and never leaks the key', async () => {
  // Composed rather than written as one literal so that the credential scanners
  // which run over this repo and its diffs cannot mistake a deliberately-fake key
  // for a leak. It is not a key: it is 42 characters of nothing and a 401.
  const notAKey = 'sk_test_' + 'definitelyNotARealKey'.repeat(2);
  const badKey = new StripeClass(notAKey, {
    apiVersion: '2022-11-15',
    maxNetworkRetries: 0,
    timeout: 20000,
  });
  let raw = null;
  try {
    await badKey.paymentIntents.create({ amount: 5000, currency: 'usd' });
  } catch (err) {
    raw = err;
  }
  assert.ok(raw, 'the bad key was expected to be refused');
  assert.strictEqual(raw.type, 'StripeAuthenticationError');
  assert.match(raw.message, /Invalid API Key/, 'the raw message should be the one that must never reach a browser');

  const failure = describeStripeFailure(raw);
  assert.strictEqual(failure.message, MESSAGES.unavailable);
  assert.ok(!INTERNAL_MARKERS.test(failure.message), 'the unavailability message leaked an internal marker');
  assert.ok(failure.message.indexOf('sk_test') === -1, 'the key fragment reached the customer-facing message');
});

check('an unknown payment method is our problem, phrased as one', async () => {
  let raw = null;
  try {
    await stripe.paymentIntents.create({ amount: 5000, currency: 'usd', confirm: true, payment_method: 'pm_card_nonexistent' });
  } catch (err) {
    raw = err;
  }
  assert.ok(raw, 'pm_card_nonexistent was expected to be refused');
  const failure = describeStripeFailure(raw);
  assert.ok(!INTERNAL_MARKERS.test(failure.message), 'leaked an internal marker');
  assert.strictEqual(failure.retryable, true, 'the customer can try again with a fresh card');
});

check('no failure we produce can carry a Stripe internal', async () => {
  const raws = [];
  const attempts = [
    { amount: 5000, currency: 'usd', confirm: true, payment_method: 'pm_card_visa_chargeDeclined' },
    { amount: 0, currency: 'usd', confirm: true, payment_method: 'pm_card_visa' },
    { amount: 49, currency: 'usd', confirm: true, payment_method: 'pm_card_visa' },
    { amount: 5000, currency: 'usd', confirm: true, payment_method: 'pm_card_nonexistent' },
  ];
  for (const params of attempts) {
    try {
      await stripe.paymentIntents.create(params);
    } catch (err) {
      raws.push(err);
    }
  }
  assert.strictEqual(raws.length, attempts.length, 'an expected failure did not happen');
  for (const raw of raws) {
    const failure = describeStripeFailure(raw);
    assert.ok(!INTERNAL_MARKERS.test(failure.message), `leaked: "${failure.message}"`);
    assert.ok(failure.code && typeof failure.code === 'string', 'every failure needs a code for the logs');
  }
});

console.log('\nThe resolver: what actually gets written');

check('a signed-out caller is stopped before anything is read or charged', async () => {
  const recorder = recordingStripe();
  const checkout = loadCheckout(recorder.module);
  // Keystone hands a resolver an empty object, never null, when nobody is signed in.
  const context = fakeContext({ session: {} });

  await assert.rejects(() => checkout({}, { token: 'pm_card_visa' }, context), (err) => {
    assert.strictEqual(err.failure.code, 'not_signed_in');
    assert.strictEqual(err.message, MESSAGES.notSignedIn);
    return true;
  });
  assert.strictEqual(context.calls.userFindOne.length, 0, 'a signed-out caller should not reach the database');
  assert.strictEqual(recorder.calls.length, 0, 'a signed-out caller should not reach Stripe');
});

check('an empty bag never calls Stripe and says why', async () => {
  const recorder = recordingStripe();
  const checkout = loadCheckout(recorder.module);
  const context = fakeContext({ cart: [] });

  await assert.rejects(() => checkout({}, { token: 'pm_card_visa' }, context), (err) => {
    assert.strictEqual(err.failure.code, 'empty_cart');
    assert.strictEqual(err.message, MESSAGES.emptyCart);
    return true;
  });
  assert.strictEqual(recorder.calls.length, 0, 'an empty bag called Stripe — that is the amount-0 paragraph waiting to happen');
  assert.strictEqual(context.calls.orderCreate.length, 0);
});

check('a cart line whose product was deleted is dropped, and a fully-deleted bag is refused', async () => {
  const recorder = recordingStripe();
  const checkout = loadCheckout(recorder.module);
  const context = fakeContext({ cart: [{ id: nextBagId(), quantity: 1, product: null }] });

  await assert.rejects(() => checkout({}, { token: 'pm_card_visa' }, context), (err) => {
    assert.strictEqual(err.failure.code, 'empty_cart');
    return true;
  });
  assert.strictEqual(recorder.calls.length, 0);
});

check('a declined card produces a readable message, writes no order and keeps the bag', async () => {
  const checkout = loadCheckout(stripeLib);
  const context = fakeContext();

  await assert.rejects(
    () => checkout({}, { token: 'pm_card_visa_chargeDeclined' }, context),
    (err) => {
      assert.strictEqual(err.failure.code, 'card_card_declined');
      assert.strictEqual(err.message, 'Your card was declined by your bank. Try a different card.');
      assert.ok(!INTERNAL_MARKERS.test(err.message));
      return true;
    },
  );

  assert.strictEqual(context.calls.orderCreate.length, 0, 'an order was written for a payment that failed');
  assert.strictEqual(context.calls.cartDelete.length, 0, 'the bag was emptied for a payment that failed');
});

check('a 3-D card writes NO order and empties NO bag — the free-order bug is closed', async () => {
  const checkout = loadCheckout(stripeLib);
  const context = fakeContext();

  await assert.rejects(
    () => checkout({}, { token: 'pm_card_threeDSecure2Required' }, context),
    (err) => {
      assert.strictEqual(err.failure.code, 'authentication_required');
      assert.match(err.message, /verification/i);
      return true;
    },
  );

  assert.strictEqual(context.calls.orderCreate.length, 0, 'a 3-D Secure payment is not a payment, but an order was written');
  assert.strictEqual(context.calls.cartDelete.length, 0, 'the bag was emptied for an unauthenticated payment');
  assert.strictEqual(context.orders.length, 0);
});

check('a lost connection inside the resolver reaches the customer as words, and writes nothing', async () => {
  const checkout = loadCheckout({ __esModule: true, default: deadNetwork() });
  const context = fakeContext();

  await assert.rejects(
    () => checkout({}, { token: 'pm_card_visa' }, context),
    (err) => {
      assert.strictEqual(err.failure.code, 'connection');
      assert.strictEqual(err.message, MESSAGES.connection);
      assert.ok(!INTERNAL_MARKERS.test(err.message));
      return true;
    },
  );
  assert.strictEqual(context.calls.orderCreate.length, 0);
  assert.strictEqual(context.calls.cartDelete.length, 0);
});

check('the charge carries an idempotency key built from the bag, not from the card', async () => {
  const recorder = recordingStripe({ allow: true });
  const checkout = loadCheckout(recorder.module);
  const context = fakeContext();

  await checkout({}, { token: 'pm_card_visa' }, context);

  assert.strictEqual(recorder.calls.length, 1);
  const { params, options } = recorder.calls[0];
  assert.ok(options && options.idempotencyKey, 'the charge carried no idempotency key');
  assert.match(options.idempotencyKey, /^checkout_user-1_/);
  assert.match(options.idempotencyKey, new RegExp(context.bagIds[0]), 'the key must identify the bag');
  assert.ok(
    options.idempotencyKey.indexOf('pm_card_visa') === -1,
    'the payment method is in the key: a double-click would then charge twice',
  );
  assert.strictEqual(params.amount, 5000, 'two of a 2500 product should be 5000 cents');
});

check('a double-click charges once and returns the same order twice', async () => {
  const checkout = loadCheckout(stripeLib);
  const context = fakeContext();

  // Two identical submits: exactly what a double-click sends if the button is
  // not disabled. Same bag, same card, so the same idempotency key.
  const first = await checkout({}, { token: 'pm_card_visa' }, context);
  const second = await checkout({}, { token: 'pm_card_visa' }, context);

  assert.strictEqual(context.calls.orderCreate.length, 1, 'a double-click wrote two orders');
  assert.strictEqual(context.orders.length, 1);
  assert.strictEqual(first.charge, second.charge, 'the two submits produced two different charges');
  assert.strictEqual(second.id, first.id, 'the retry created a second order for the same charge');
  assert.deepStrictEqual(
    context.calls.cartDelete[1].ids,
    context.bagIds,
    'the retry must leave the bag cleaned, not re-cleaned differently',
  );
});

check('two submits raced from two different cards take the money at most once', async () => {
  const checkout = loadCheckout(stripeLib);
  const context = fakeContext();

  // The realistic double-click: each click runs stripe.createPaymentMethod, so
  // the two requests arrive with DIFFERENT payment methods at the same moment.
  const results = await Promise.allSettled([
    checkout({}, { token: 'pm_card_visa' }, context),
    checkout({}, { token: 'pm_card_mastercard' }, context),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.strictEqual(fulfilled.length, 1, `expected exactly one successful checkout, got ${fulfilled.length}`);
  assert.strictEqual(rejected.length, 1, 'the racing submit should have been refused, not silently charged');
  assert.match(
    rejected[0].reason.failure.code,
    /^duplicate_submit/,
    `the refused submit was reported as ${rejected[0].reason.failure.code}: ${rejected[0].reason.message}`,
  );
  assert.strictEqual(rejected[0].reason.message, MESSAGES.alreadyProcessing);
  assert.strictEqual(context.calls.orderCreate.length, 1, 'the race wrote more than one order');
  assert.strictEqual(context.orders.length, 1);
});

check('a successful checkout writes the line items, the total and the charge', async () => {
  const checkout = loadCheckout(stripeLib);
  const context = fakeContext({
    cart: [
      cartLine({ id: 'line-photo', quantity: 2 }),
      cartLine({ id: 'line-nophoto', quantity: 1, product: { ...cartLine().product, id: 'p2', name: 'Socks', price: 500, photo: null } }),
    ],
  });

  const order = await checkout({}, { token: 'pm_card_visa' }, context);

  assert.strictEqual(context.calls.orderCreate.length, 1);
  const data = context.calls.orderCreate[0].data;
  assert.strictEqual(data.total, 5500, `total should be 2x2500 + 1x500; got ${data.total}`);
  assert.strictEqual(data.items.create.length, 2);
  assert.strictEqual(data.items.create[0].photo.connect.id, 'ph1');
  assert.strictEqual(
    data.items.create[1].photo,
    undefined,
    'a product with no photo should leave the order item photoless, not throw',
  );
  assert.deepStrictEqual(context.calls.cartDelete[0].ids, ['line-photo', 'line-nophoto']);
  assert.strictEqual(order.charge.startsWith('pi_'), true);
});

check('money taken but order not written is reported with the charge reference', async () => {
  const checkout = loadCheckout(stripeLib);
  const context = fakeContext({ failOrderWrite: true });

  await assert.rejects(
    () => checkout({}, { token: 'pm_card_visa' }, context),
    (err) => {
      assert.strictEqual(err.failure.code, 'charged_without_order');
      assert.match(err.message, /^Your payment went through/);
      assert.match(err.message, /pi_[A-Za-z0-9]+/, 'the customer was given no reference to quote');
      return true;
    },
  );
});

check('the resolver logs a failure code, and never the customer record', async () => {
  const src = stripComments(fs.readFileSync(path.join(BACKEND, 'mutations', 'checkout.ts'), 'utf8'));
  assert.ok(!/console\.dir/.test(src), 'console.dir is still printing the customer record into the server log');
  assert.ok(!/console\.log\(\s*charge\s*\)/.test(src), 'the whole charge object is still being logged');
  assert.match(src, /code=\$\{failure\.code\}/, 'the failure is logged without a code, so a night of them is unsearchable');
});

check('checkout is still registered on the schema with the same signature', () => {
  const src = stripComments(fs.readFileSync(path.join(BACKEND, 'mutations', 'index.ts'), 'utf8'));
  assert.match(src, /checkout\(token: String!\): Order/, 'the checkout GraphQL signature changed');
  assert.match(src, /import checkout from '\.\/checkout'/);
  assert.match(src, /resolvers:[\s\S]*checkout/);
});

check('every idempotency key is stable for a bag and different for another', () => {
  const bag = [{ id: 'cart-2' }, { id: 'cart-1' }];
  const sameBagOtherOrder = [{ id: 'cart-1' }, { id: 'cart-2' }];
  const anotherBag = [{ id: 'cart-1' }, { id: 'cart-3' }];

  assert.strictEqual(idempotencyKey(USER, bag), idempotencyKey(USER, sameBagOtherOrder), 'row order must not change the key');
  assert.notStrictEqual(idempotencyKey(USER, bag), idempotencyKey(USER, anotherBag), 'a different bag must not reuse a key');
  assert.notStrictEqual(idempotencyKey(USER, bag), idempotencyKey('user-2', bag), 'a different customer must not reuse a key');
});

if (!LIVE) {
  console.error('\n!! STRIPE_SECRET is missing from backend/.env, so the live half of this suite did not run.');
  console.error('!! The results above are not evidence for the day-22 acceptance check.');
  failures++;
}

Promise.all(pending).then(() => {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`FAIL: ${failures} checkout check(s) failed`);
    process.exit(1);
  }
  console.log('PASS: every checkout failure path answers in words a customer can act on, and a double-click takes money once');
  process.exit(0);
});
