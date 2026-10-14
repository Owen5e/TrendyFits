# Backend tests

There is no test framework in this package — the scripts here are plain Node,
run directly, so they need no new dependency and no install step.

## `npm run test:admin-ui-import`

`admin-ui-api-import.test.js` — regression test for **BUG-1** (see
`../../docs/STATUS.md`).

Keystone generates `.keystone/admin/pages/api/__keystone_api_build.js`, which
re-exports the project's Keystone config as

```js
export { default as config } from '<path to backend/keystone>';
```

`@keystone-next/admin-ui` 8.0.2 builds that path with `Path.relative()`, which
returns **backslashes** on Windows, and interpolates it into the import without
normalising the separators. JavaScript reads `..\..\..\..\keystone` as a string
with escape sequences, so the module id compiled is `........keystone` and the
admin UI build fails with `Module not found: Can't resolve '........keystone'`.

The fix is `patches/@keystone-next+admin-ui+8.0.2.patch`, applied automatically
by `patch-package` from the package's `postinstall` script — so `npm ci` is all
anyone needs to do.

**Precondition.** The file under test is generated, not committed. Generate it
with `npm run dev` (it is written a couple of minutes in, *before* the slow
admin-UI compile — the server can be killed as soon as the file appears) or with
`npm run build`.

**Result on 2026-10-09 (Windows, Node 16.20.2):**

```
before the patch   FAIL: the generated import specifier is "........keystone", …
after  the patch   PASS: __keystone_api_build.js imports '../../../../keystone' -> …\backend\keystone.ts
```

The end-to-end gate is the same bug seen from further away: `npm run build`
fails with `Module not found: Can't resolve '........keystone'` before the patch
and completes after it. CI cannot catch this — the backend job runs on
`ubuntu-latest`, where `Path.relative()` already returns forward slashes.

## `npm run test:cart`

`cart-rules.test.js` — the per-line quantity ceiling (day 20's "max stock").

`lib/cartRules.ts` holds the three questions every cart screen asks: how many of
this product may one line hold, what happens to an out-of-bounds quantity, and
what happens when a browser-side cart meets a server-side one (the "larger wins,
never the sum" merge rule, day 21). It imports nothing from Keystone, so the test
compiles it in-process with `ts.transpileModule` — the same trick
`access-rules.test.js` uses — and asserts the rules directly, with no database.

It then reads `mutations/addToCart.ts` and `schemas/Product.ts` and asserts the
write path consults the rules: a ceiling that no mutation checks is not a cap.

**Result on 2026-10-12 (Windows, Node 26.2.0):** `18/18 checks passed`.

The frontend keeps a mirror of the same numbers (`frontend/lib/cartLines.js`)
so its controls can disable themselves before a customer hits a wall. Both sides
assert the constants against each other — this test reads the frontend file, and
`frontend/__tests__/cartRulesMirror.test.js` reads this one — so the mirror
cannot drift silently.

## `npm run test:merge`

`cart-merge.test.js` -- the write path day 21 added: `mutations/mergeCart.ts`, which
folds a browser-held cart into a signed-in account's cart.

It is compiled in-process (again with `ts.transpileModule`, and with the real
`lib/cartRules.ts` injected) and handed a fake Keystone context that records every
read and write, so the assertions are about behaviour: what gets written, what is
left alone, and what is dropped. The merge rule it proves is "per product the larger
quantity wins, never the sum" -- the day-21 acceptance check is that adding items
signed out and then signing in loses nothing and double-counts nothing.

**Result on 2026-10-13 (Windows, Node 26.2.0):** `13/13 checks passed`.

## `npm run test:checkout`

`checkout-failure-paths.test.js` — day 22: what a customer is told when a
payment does not go through, and what the resolver is allowed to write.

**This is the one suite in this package that needs a network.** The other four
are offline on purpose. This one is not, because the thing under test is the
*translation* of what Stripe actually returns, and Stripe's real answers are the
input: the card failures are produced by real requests to the test-mode API
(`pm_card_visa`, `pm_card_visa_chargeDeclined`, `pm_card_threeDSecure2Required`,
an amount below the minimum), the connection failure is a **real refused socket**
raised by the real SDK, and the wrong-key failure uses a deliberately bad key.
Only the database is faked — a small in-memory Order store, so a retry can find
what the first attempt wrote.

It reads `STRIPE_SECRET` from `backend/.env` (or the environment). Without a key
it prints a loud skip notice and **fails**, so a green run can never mean "the
live half did not happen".

Two things it pins that are worth knowing before touching the checkout:

- a 3-D Secure card resolves with `status: 'requires_action'` and **no error**, so
  "the call returned" is not "the customer paid";
- two submits with different payment methods and one idempotency key are refused
  by Stripe (`409 idempotency_key_in_use`, or `StripeIdempotencyError` on a
  replay), which is what stops a double-click from charging twice.

**Result on 2026-10-14 (Windows, Node 16.20.2, live test key):** `24/24 checks passed`.

The browser side of the same vocabulary is `frontend/lib/checkoutMessages.js`,
checked word-for-word against `lib/checkoutErrors.ts` by
`frontend/__tests__/checkoutMessagesMirror.test.js`. The findings themselves are
written up in `../../docs/CHECKOUT-AUDIT.md`.
