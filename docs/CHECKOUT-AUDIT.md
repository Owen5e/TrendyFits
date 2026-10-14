# Checkout audit — `sick-fits/backend` + `sick-fits/frontend`

**Date:** 2026-10-14
**Scope:** `backend/lib/stripe.ts`, `backend/mutations/checkout.ts`, `frontend/components/Checkout.js`
**Method:** the failure paths were **exercised**, not read. Every Stripe answer quoted below came
back from the live test-mode API using the `STRIPE_SECRET` in `backend/.env` on the day of the audit
(the card paths via Stripe's test payment methods, the connection failure via a real refused socket,
the wrong-key failure via a deliberately bad key). Two tests were written first and drove the fixes:
`backend/test/checkout-failure-paths.test.js` (`npm run test:checkout`, 24 checks) and
`frontend/__tests__/Checkout.test.js` (11 tests).

**Status:** **F1–F4 fixed on 2026-10-14**, F5–F8 recorded and open (see section 5).

---

## 1. What the four named paths actually did

Each row is what the old code did, with the evidence that it did it.

| Path | What Stripe returns | What the old code did | What the customer saw |
|---|---|---|---|
| **Failed card** | `StripeCardError` / `card_declined`, `"Your card was declined."` | set the error, then `return`ed **before** `setLoading(false)` and `nProgress.done()` | the decline message, above a loading bar that never stopped and a button that never came back |
| **Network loss** | `StripeConnectionError`, `"An error occurred with our connection to Stripe."` | no `try/catch` around the call to our own API: the promise rejected with nothing to catch it | the same stuck spinner, plus an unhandled rejection in the console |
| **Double-click** | two separate requests, two separate charges | `loading` was set but never used — the button was never disabled, and nothing server-side stopped the second request | charged twice, one order |
| **Abandoned payment** | 3-D Secure card: **no error at all**, resolves with `status: 'requires_action'` | wrote the order and routed to the confirmation page | a **free order** |

The abandoned-payment row is the one worth re-reading, because it is not a UI flaw:

```
payment_method: pm_card_threeDSecure2Required, confirm: true
  -> RESOLVED   status=requires_action   next_action.type=use_stripe_sdk
```

There is no exception to catch and no `error` object. `paymentIntents.create({ confirm: true })`
returning is not the same as the card being charged, and the old checkout treated the two as
identical. Every card needing authentication was a free order with a written record.

## 2. Findings

### F1 — a 3-D Secure card produced a free order — **FIXED**

`assertChargeSucceeded(intent)` (`backend/lib/checkoutErrors.ts`) now returns only for
`status === 'succeeded'` and throws a readable failure for everything else:
`requires_action` / `requires_confirmation` / `requires_payment_method` →
*"Your bank asked for an extra verification step that this checkout cannot complete yet. You have not
been charged — please try a different card."*; `processing` → *"still being processed… check your
orders page"*; `canceled` → *"cancelled before it completed"*.

*Proof:* `ok a 3-D card resolves with NO error — and that is the free-order bug` and
`ok a 3-D card writes NO order and empties NO bag — the free-order bug is closed` (asserts the order
write count is 0, the cart-delete count is 0, and the order store is empty).

### F2 — a double-click charged twice — **FIXED, in two layers**

The browser sends the second request only if the first is not in flight; the server refuses to
charge the same bag twice even if it is.

- **Browser:** the submit handler takes a synchronous guard (`useRef`, because state is not readable
  in the same tick it is set), the button is `disabled` while a charge is in flight, the Stripe card
  fields are disabled too, and `finally` always clears both.
- **Server:** `paymentIntents.create` is called with an idempotency key built from **server-side
  facts only** — the signed-in user and the ids of the cart rows being charged —
  `checkout_<userId>_<sorted cart row ids>`. Deliberately **not** the payment method: each click runs
  `stripe.createPaymentMethod`, so the two requests carry different payment methods, and a key
  containing one would let both through. That is the expensive way to be wrong.
- A repeat of a *succeeded* charge finds the order already written against `charge.id` and returns
  it instead of writing a second one.

*Probed behaviour this rests on* (Stripe test mode, 2026-10-14):

| Situation | Result |
|---|---|
| same key, same parameters, sequential | same PaymentIntent returned — deduped |
| same key, same parameters, **concurrent** | one PaymentIntent; the other gets `409 idempotency_key_in_use` |
| same key, **different** parameters | `StripeIdempotencyError` — refused, never charged |

*Proof:* `ok a double-click charges once and returns the same order twice` (one `createOne`, one
order, the same order id returned twice), `ok two submits raced from two different cards take the
money at most once` (exactly one fulfilled, one refused as a duplicate submit, one order), and in
the browser `sends one charge request when the form is submitted twice in one tick`.

### F3 — Stripe's developer language reached the customer — **FIXED**

Raw strings, all captured from the live API:

| Situation | Stripe's own words |
|---|---|
| empty bag (amount 0) | a 200-word paragraph about Setup Intents and minimum charge amounts |
| amount below the minimum | `Amount must be at least $0.50 USD` |
| lost connection | `An error occurred with our connection to Stripe.` |
| wrong secret key | `Invalid API Key provided: sk_test_****0004` |
| unknown payment method | `No such PaymentMethod: 'pm_card_nonexistent'` |

`describeStripeFailure(err)` maps every one of these to a sentence that says what happened, whether
money moved, and whether retrying is worth the customer's time. Card declines are the single family
whose own wording is written for a cardholder, and even those go through a whitelist keyed by
Stripe's `code` — a code we have not seen gets our own fallback rather than the raw string.

The leak filter is applied **positively** in the browser: a message is shown only if it *is* one of
our sentences. A raw JavaScript error (`Cannot read properties of null`) contains no marker worth
listing, so "not obviously internal" is not a safe test — "is one of ours" is. The one exception is
the message that carries the charge reference, recognised by its opening words, because telling the
customer what to quote is the whole point of it.

*Proof:* `ok no failure we produce can carry a Stripe internal`, `ok a wrong secret key becomes
"temporarily unavailable" and never leaks the key`, `ok an empty bag never reaches Stripe, and its
Stripe error would be unreadable anyway` (also asserts the premise: Stripe's own message is >150
characters and ours is <150), plus `never shows a message that was written for a developer`.

### F4 — a failed payment left the page mid-transition — **FIXED**

`nProgress.start()` was called on submit; `nProgress.done()` and `setLoading(false)` were reachable
only after a successful order. The Stripe error branch `return`ed between them. The handler is now
`try / catch / finally`: the `finally` always stops the bar and frees the form, whatever happened,
and the `catch` turns a rejected mutation into a sentence instead of an unhandled rejection.

*Proof:* `shows a declined card in words, frees the form and stays put` (asserts `nProgress.done`
was called, the button is enabled again, `Router.push` was not called, `closeCart` was not called),
and `says the outcome is unknown when our own API cannot be reached`.

## 3. Two more things the audit turned up

- **The customer record was being logged on every checkout.** `console.dir(user, { depth: null })`
  printed the user's name, email and entire cart into the server log — on the success path as well
  as the failure path. Removed. What is logged now is one line naming the user id and a failure code
  (`code=`), so a night of failures is searchable without putting a customer in the log.
- **A product with no photo crashed the checkout after the charge.** `cartItem.product.photo.id`
  threw `TypeError: Cannot read properties of null (reading 'id')` inside the order write — money
  taken, no order, and the failure arrived after the point of no return. The photo relationship is
  optional in the schema, so the connect is now conditional.

  *Proof:* `ok a successful checkout writes the line items, the total and the charge` includes a line
  whose product has `photo: null` and asserts the order item is written without a photo.

## 4. What is covered now

| Where | Command | Result |
|---|---|---|
| backend, live Stripe test key | `npm run test:checkout` | 24/24 |
| backend, everything else | `test:access` · `test:cart` · `test:merge` · `test:admin-ui-import` | 27/27, 18/18, 13/13, PASS |
| frontend | `npm test` | 112 tests, 16 suites |
| frontend, lint | `npx next lint` | 0 errors |
| backend, types | `npx tsc --noEmit` | 16 errors, down from **23** — none in the files this day touched |

The typecheck number is worth stating precisely, because the checkout path was one of the files
carrying pre-existing errors: `mutations/checkout.ts` had **7**, and now has **0** (the cart rows are
annotated `any[]`, which is where the `possibly null` and `ProductRelateToOneInput` errors came
from; two `catch (err: any)`; and `token: String` → `token: string`). Total repo errors moved 23 →
16, so the non-blocking CI step got better, not worse.

## 5. Recorded, not fixed

These are honest gaps found on the way. Each names the fix it wants, so the next day that owns this
area can pick it up rather than re-discover it.

- **F5 — the charge and the order are still two writes with no transaction.** If the order write
  fails after a successful charge, the customer has paid and has no order. The failure is now
  *legible* (it names the charge id) and no longer crashes, but it is not *repaired*: no refund, no
  retry queue. The fix is either a two-phase flow (`capture_method: 'manual'`, order first, then
  capture and cancel on failure) or a recorded attempt row that a reconciler can sweep. This is the
  highest-value remaining item on this path.
- **F6 — a retry after an unknown outcome can only be refused, not resolved.** If a connection drops
  mid-charge and the customer tries again **with a different card**, the idempotency key is unchanged
  but the parameters are not, so Stripe refuses the replay and the customer is told to check their
  orders page. That is money-safe — it cannot double-charge — but it cannot tell them whether the
  first attempt landed either. The fix is to persist the attempt (user, bag fingerprint, PaymentIntent
  id) before confirming, so a later request can look the first one up instead of guessing.
- **F7 — a cart line whose product was deleted is dropped silently.** It is excluded from the charge
  (`amount` correctly excludes it) and then deleted from the cart with the rest, so a customer who
  expected three items pays for two and is told nothing. Surfacing it means returning something like
  `{ order, dropped: [...] }` from the mutation, which changes the GraphQL contract — a bigger edit
  than an audit should make unilaterally. Note that the empty-bag guard (F3) already covers the case
  where *every* line is dropped.
- **F8 — the backend test suites are not run by CI.** `.github/workflows/ci.yml` runs the frontend's
  lint/test/build and the backend's build/typecheck, but none of `test:access`, `test:cart`,
  `test:merge`, `test:checkout` or `test:admin-ui-import` — 80+ checks that only run when someone
  remembers. `test:checkout` additionally needs a live key and a network, so it wants to be a
  separate job (or skip cleanly with a loud message — which it already does) while the offline
  suites become a normal step.

## 6. The shape the code has now

```
backend/lib/checkoutErrors.ts     the vocabulary: MESSAGES, CARD_MESSAGES, describeStripeFailure,
                                  assertChargeSucceeded, idempotencyKey, MESSAGES.chargedWithoutOrder
backend/mutations/checkout.ts     sign-in -> bag -> amount -> charge (idempotent) -> status check
                                  -> order (idempotent by charge) -> clear cart
frontend/lib/checkoutMessages.js  the same vocabulary, for the two failures that never reach the
                                  server: Stripe.js refusing a card, and our own API being unreachable
frontend/components/Checkout.js   one guard, one try/catch/finally, one place failures are rendered
```

The browser catalogue is a mirror, and a mirror nobody checks drifts: the sentences in
`frontend/lib/checkoutMessages.js` are compared word for word against the backend's by
`frontend/__tests__/checkoutMessagesMirror.test.js`, which reads the backend file off disk and fails
on any difference — including the leak-filter regex.
