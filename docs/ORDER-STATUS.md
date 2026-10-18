# Order history and the order status flow

**Day 26 — 2026-10-18.** The calendar asked for *"Order history for signed-in
customers (the Order/OrderItems schemas already exist) plus order-status updates
in the Keystone admin UI"*, with the acceptance check:

> **A customer sees only their own orders; staff can move an order through its
> statuses.**

This file is the human-readable half of that. The executable half is
`sick-fits/backend/test/order-status.test.js` (`npm run test:orders`, 32 checks)
plus `npm run check:schema`, which makes Keystone build the real GraphQL schema
and admin meta and prints what the admin UI actually receives.

---

## 1. The lifecycle

```
     CREATED ──▶ PAID ──▶ FULFILLED ──▶ DELIVERED
        │          │
        └──────────┴──▶ CANCELLED
```

| Status | Meaning | May move to |
|---|---|---|
| `CREATED` | Order written, no money confirmed | `PAID`, `CANCELLED` |
| `PAID` | Charge succeeded | `FULFILLED`, `CANCELLED` |
| `FULFILLED` | Packed / handed to the courier | `DELIVERED` |
| `DELIVERED` | Final | — |
| `CANCELLED` | Final | — |

Rules, all in `backend/lib/orderStatus.ts`:

- **Forward only, along a legal edge.** A skipped step (`CREATED → DELIVERED`) and
  a backwards move (`FULFILLED → PAID`) are both refused.
- **Final states are final.** There is no un-deliver and no un-cancel through the
  API. A refund is a financial act, not a status edit.
- **A no-op is not a transition.** Re-saving the same status succeeds and does not
  restamp `statusChangedAt`.
- **An invented value is refused by name.** `'"SHIPPED" is not an order status. Use
  one of: …'` — not a silent no-op.

## 2. Who may do what

| Actor | Read orders | Change status | Delete |
|---|---|---|---|
| Anonymous | nothing (`false`) | no | no |
| Customer | **only their own** (filter `{ user: { id: session.itemId } }`) | no — field-level access denies it, and the hook refuses it again | no |
| `canManageOrders` staff | all orders | **yes**, along legal edges | no |
| `canManageCart` staff | all orders (unchanged behaviour) | no | no |

> **Before using it:** the staff account needs a `Role` with **`canManageOrders`** ticked
> (Admin UI → Roles), and that role attached to the user. Without it the admin item view will
> refuse the write — which is the model working, not a bug.

The customer's page (`frontend/pages/order.js`) asks for `authenticatedItem { …
orders }` with **no variables at all**, so there is no parameter to tamper with to
reach another account's history. The backend enforces the same boundary again in
`rules.canReadOrders`.

## 3. How it is enforced, layer by layer

1. **Schema** — `Order.status` is a required select, default `CREATED`, indexed.
   Field-level access `create`/`update` = `permissions.canManageOrders`, so a
   customer's write never carries a status at all (the checkout mutation does not
   pass one either; the default applies).
2. **Hook** — `Order.hooks.resolveInput` calls `resolveStatusInput()` on every
   create and update, from the admin UI and from GraphQL alike. It refuses a
   customer's status write (belt to the field-access braces), stamps
   `statusChangedAt` only when the status actually moves, and refuses an illegal
   edge with a sentence naming the legal alternatives.
3. **Read model** — `rules.canReadOrders` gives a customer a filter on their own
   id and staff the whole list.
4. **Storefront** — the history page and the single-order page render the status,
   the date it moved, and a progress timeline. Neither file contains a mutation.

## 4. What was found on the way (recorded, not papered over)

- **F1 — staff could not see the orders they were allowed to correct.**
  `Order.read` used `rules.canOrder`, which grants unrestricted access only to
  `canManageCart`. A staff member holding `canManageOrders` therefore got the
  *customer* filter — their own purchases — so the admin order list was empty for
  the one person expected to move statuses. Fixed with a dedicated
  `rules.canReadOrders` (permission OR ownership) rather than widening `canOrder`,
  because `canOrder` also guards `CartItem`: widening it would have handed every
  customer's basket to whoever may correct orders. Proved in both directions in
  `test/access-rules.test.js` and `test/order-status.test.js`.
- **F2 — the pinned Keystone version accepts admin-UI config it never applies.**
  The first draft set `ui.labelField`, `ui.listView.initialColumns`,
  `ui.listView.initialSort`, `ui.createView.defaultFieldMode` and
  `ui.displayMode: 'segmented-control'` on the status field. All of them typecheck
  (`@keystone-next/types` 12 is newer than the runtime) and **all of them are
  dropped** by `@keystone-next/keystone` 9.3.1: `initConfig` passes only
  `fields`/`access`/`hooks` to `createList`, with a FIXME that names `labelField`
  and `adminConfig` as unsupported. Evidence: the built field's `views` map is
  empty, its adapter is `MongoTextInterface`, and the admin meta's
  `defaultColumns` is still the shipped default `label,total`. The dead config was
  removed rather than shipped (config that lies to the next reader is worse than
  none), and `npm run check:schema` now prints the admin meta so the limitation is
  visible. **Consequence:** on this stack a staff member edits the status as a
  plain text value in the item view, and the *server* is what makes the flow
  correct. A real dropdown needs the admin UI to honour `views` — i.e. an upgrade.
- **F3 — the admin UI is open to any signed-in session, not just staff.**
  `keystone.ts` gates the admin UI with `isAccessAllowed: ({ session }) =>
  !!session?.data`, which is true for every signed-in customer. Their data stays
  protected by list access (they see their own rows only), but they can open the
  admin shell. Tightening the gate to require a role-with-permissions was **not**
  done today: it cannot be verified against the live database from here, and
  getting it wrong locks the owner out of his own admin. Recorded as a gap.
- **F4 — `Order.create` is still `isSignedIn`, and the generated GraphQL API is
  reachable.** A signed-in customer can call `createOrder` directly with an
  arbitrary `total`/`charge`. This predates the day (the checkout mutation is the
  intended path) and is not closed here; the status field is protected, the order
  write is not. Recorded as a gap rather than half-fixed inside a UI task.

## 5. Evidence

| Claim | Command | Result |
|---|---|---|
| Customer sees only their own orders (filter semantics on real rows) | `npm run test:orders` | 32/32 checks |
| Staff can walk CREATED → PAID → FULFILLED → DELIVERED | `npm run test:orders` | 32/32 checks |
| Every illegal / backwards / final-state move is refused, with a message | `npm run test:orders` | 32/32 checks |
| The access rules still hold account-wide | `npm run test:access` | 29/29 checks |
| The storefront mirror matches the backend | `npx jest __tests__/orderStatusMirror.test.js` | 12 tests |
| The pages render signed-out / empty / paid / delivered / cancelled / not-found | `npx jest __tests__/OrderHistory.test.js` | 7 tests |
| Keystone builds the schema and admin meta for the field | `npm run check:schema` | PASS |

**Not proved here:** there is no database in this loop. The tests exercise the
real access *filter*, the real hook and the real state machine — the logic that
decides both promises — but no document was written to MongoDB and no admin
screen was clicked. `backend/package.json` gained `test:orders` and `check:schema`
so both are one command away.

## 6. Gaps left open

1. **F3** — admin UI gate accepts any signed-in session.
2. **F4** — `Order.create` accepts a hand-written order from any signed-in user.
3. **No notification on a status change** — a customer learns about "Delivered"
   by visiting their orders page. Wired a status email is day 24's territory
   (`backend/lib/mail.ts` already exists) and can now hang off `statusChangedAt`.
4. **No fulfilment UI beyond the status value** — courier/tracking fields are not
   modelled; the calendar's Phase 2 does not ask for them.
