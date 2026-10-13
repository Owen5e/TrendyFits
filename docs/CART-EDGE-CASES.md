# Cart edge cases and the anonymous cart — `sick-fits`

**Dates:** day 20 (2026-10-12, cart edge cases) and day 21 (2026-10-13, anonymous cart)
**Task:** Cart edge cases: quantity changes, remove item, max stock, empty cart, price
recalculation — in `Cart.js`, `AddToCart.js` and `RemoveFromCart.js`, with jest coverage.
**Acceptance check:** the existing `__tests__` suite still passes and new cases cover each bullet.

**Status:** all five bullets handled, on both sides of the wire, and the cart now works before
sign-in as well. Frontend suite went from **29 tests / 10 suites** to **84 tests / 14 suites**, all
green. Backend gained `npm run test:cart` (**18/18**) and `npm run test:merge` (**13/13**);
`npm run test:access` still passes (**27/27**).

---

## 1. Where the decisions live

| Question | Answer | Where |
|---|---|---|
| How many of one product may a line hold? | the product's `stock`, else `DEFAULT_LINE_LIMIT` (10) | `backend/lib/cartRules.ts`, mirrored in `frontend/lib/cartLines.js` |
| What happens to an out-of-bounds quantity? | it is *clamped* into `1..limit`, never written raw | `clampQuantity()` in both files |
| What does a line cost? | `price × quantity`, and `0` when the product is gone | `linePrice()` |
| What happens when a browser cart meets a server cart? | the **larger** quantity wins, never the sum | `mergeQuantity()` — day 21 |

There is no per-customer inventory reservation anywhere in this change. The ceiling is per *line*,
which is exactly as much as the schema can honestly support today.

## 2. The five bullets

### 2.1 Quantity changes
`Cart.js` grows a `QuantityStepper` per line (−, quantity, +). The bounds are computed from the
product, not guessed: the − button disables at 1 with the title *"Use remove to take this out of
your bag"*, the + button disables at the limit with *"Only N per order"* shown beneath the line.
A change calls Keystone's `updateCartItem` (gated by `rules.canOrder`, so a customer can only reach
their own rows) and refetches the user query, so the header count, the line total and the cart total
all move together.

Going to zero is deliberately **not** a decrement: at 1 the − is disabled and removal is the only
way out. A quantity that silently becomes "0 items" is a line the customer cannot see and cannot
delete — the exact shape of bug this bullet is about.

### 2.2 Remove item
`RemoveFromCart.js` now (a) shows a failed removal instead of appearing to do nothing, (b) refetches
the user query so removing the last line lands on the real empty-cart panel, and (c) names what it
removes (`aria-label="Remove <product> from cart"`).

**Bug found and fixed while writing this:** the old `update` callback was one line —
`cache.evict(cache.identify(payload.data.removeFromCart))`. `cache.identify()` derives the object id
from the `__typename` on the result; when that is missing it returns `undefined`, and
`cache.evict(undefined)` throws `Cannot read properties of undefined (reading 'id')` **inside the
mutation callback**, which fails the whole removal. The eviction is now best-effort — if the object
cannot be identified, the refetch still refreshes the cart — so removal cannot be taken down by a
missing type name. The jest suite pins this: the empty-cart test fails if the throw comes back.

### 2.3 Max stock
`Product` gained a `stock` integer field (default 100). The cap is enforced in **three** places,
because a screen-only cap is advisory:

1. `lineLimit(product)` — the number itself.
2. `addToCart` (backend) reads the product **before** it increments and throws
   `Only 5 of Yeti Hondo per order — your bag already has 5.` rather than writing the over-limit
   number. Reading through `context.lists.Product` also means `rules.canReadProducts` applies: a
   Draft or Unavailable product cannot be added to a cart at all.
3. `AddToCart.js` disables itself at the limit (`MAX 5 IN BAG`) and surfaces the server's refusal
   when the screen let something through.

A product with no stock recorded falls back to the default line limit — `null`/`0`/`'lots'` mean
"not recorded", never "sold out".

### 2.4 Empty cart
`cartSummary(cart)` is the single source of the empty state: `isEmpty` is true for `undefined`,
`null` and `[]` alike. An empty cart renders the panel and **no** checkout button and no total.
A line whose product was deleted is *not* silently dropped — it stays visible, priced at 0, labelled
"No longer available", excluded from the total, and removable (otherwise the customer is left with a
bag count they cannot clear).

### 2.5 Price recalculation
Totals are always recomputed from the current quantities and prices (`cartSummary`), never cached in
state: `linePrice = price × quantity`, `totalPrice = Σ linePrice` over lines that still have a
product. The component test changes a quantity and asserts the total moves from `$73.46` to
`$107.69` — i.e. it asserts the *recalculation*, not just the initial render.

## 3. Evidence

```
sick-fits/frontend   npx jest --ci        14 suites, 84 tests, 11 snapshots — all pass
sick-fits/backend    npm run test:cart    18/18 checks pass
sick-fits/backend    npm run test:merge   13/13 checks pass   (day 21)
sick-fits/backend    npm run test:access  27/27 checks pass
sick-fits/backend    npx tsc --noEmit -p tsconfig.json   23 errors, unchanged from day 19
                                                         (all pre-existing; none in the new files)
```

Two snapshot files were regenerated (`Product`, `SingleProduct`): both render `AddToCart`, whose
markup genuinely changed (the button is now wrapped and can read `MAX n IN BAG`). No assertion was
weakened — `Product.test.js` and `SingleProduct.test.js` also gained the `CartStateProvider` wrapper
that `pages/_app.js` always supplies in production, because `AddToCart` reads the cart context now.

## 4. The anonymous cart (day 21)

**Task:** "Anonymous cart: a localStorage cart that merges into the server cart on sign-in, with a
merge rule you can explain out loud."
**Acceptance check:** "Add items signed out, sign in, and nothing is lost or double-counted."

### 4.1 The rule, out loud

> Per product, the merged quantity is the **larger** of what the server already had and what this
> browser was holding — never the sum. The result is still capped by the product's line limit.

Summing double-counts an item the customer added on the phone *and* while signed in; the maximum
never loses a line and never invents stock. In numbers:

| Server already had | Browser was holding | Merged | Why |
|---|---|---|---|
| 0 | 2 | **2** | a line that exists only in the browser survives intact |
| 1 | 1 | **1** | the "added it in both places" case — 1, not 2 |
| 1 | 3 | **3** | the larger wins; nothing lost |
| 4 | 2 | **4** | the browser line is already covered; no write at all |
| 0 | 9 (stock 4) | **4** | the ceiling still applies |

One implementation, three callers, no copies: `mergeQuantity` in
`backend/lib/cartRules.ts` (the write), mirrored in `frontend/lib/cartLines.js` (what the drawer
shows while a merge is pending). `backend/test/cart-rules.test.js` and
`frontend/__tests__/cartRulesMirror.test.js` each read the *other* file and fail if the two drift.

### 4.2 How it is wired

| Piece | Job |
|---|---|
| `frontend/lib/anonCart.js` | one localStorage key (`trendyfits.cart.v1`), sanitised on every read and write; `mergeLines()` decides what is worth sending |
| `frontend/lib/cartState.js` | owns the browser cart in one place, so the drawer, the badge, the add buttons and the merge all read the same array |
| `frontend/components/AddToCart.js` | a signed-out click now *keeps* the bag instead of redirecting to `/signin` |
| `frontend/components/MergeAnonymousCart.js` | watches the signed-in user; sends the merged lines; **clears localStorage only after the server confirms** |
| `frontend/components/Cart.js` | signed out, the drawer shows the browser cart with the same steppers, and "Sign in to check out" instead of a Stripe form |
| `frontend/components/Nav.js` | the bag badge counts the cart the customer is actually carrying (server when signed in, browser when signed out, larger-quantity union while a merge is in flight) |
| `backend/mutations/mergeCart.ts` | `mergeCart(items: [CartLineInput!]!)` — re-reads the product first, scopes every read and write to the session user, drops lines whose product is no longer purchasable, deletes nothing |

### 4.3 What it refuses to do

- **Never deletes.** A merge that deletes can lose a line; the server line is only ever moved up.
- **Never trusts localStorage.** The payload is sanitised (no product id or no quantity → dropped,
  duplicates folded by the same max rule, capped at 50 lines) so a hand-edited key cannot inflate a
  cart or bloat a render.
- **Never merges an unpurchasable product.** The product is read through
  `rules.canReadProducts`, so a Draft/Unavailable/deleted product is not found and its browser line
  is dropped rather than resurrected.
- **Never loses the browser copy on failure.** If the mutation fails, localStorage is kept and a
  retry banner appears; the merge also runs once per sign-in, because `useUser` polls every 5s and a
  merge that re-ran on every poll would be a write loop.

### 4.4 One test-harness note

`MergeAnonymousCart` runs from a query resolution rather than a click, and React 18 + RTL only flush
non-event updates when `act()` runs. The tests therefore flush with `await act(...)` before asserting
(the response itself is delivered either way — verified by instrumenting the mock link: the request
matches and the observable emits). Production has no `act`.

## 5. What is deliberately *not* here

- No inventory reservation, no stock decrement: that is day 25's task ("atomic stock decrement on the
  paid webhook, inside a transaction").
- No `updateCartItem` UI on the checkout screen: that is day 22's Stripe audit.
- No cross-device cart: the browser cart is per device and is merged once, on sign-in.
