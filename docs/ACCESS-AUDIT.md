# Access-control audit — `sick-fits/backend`

**Date:** 2026-10-10
**Scope:** every Keystone list in `sick-fits/backend/schemas/` and every access function in
`sick-fits/backend/access.ts`
**Method:** read the source of all 8 lists plus the rule vocabulary, then encode what was read as
executable tests (`test/access-rules.test.js`) so the audit cannot silently drift from the code.

**Status:** **all six findings (F1–F6) closed on 2026-10-11.** Each finding below records what was
wrong, what replaced it, and the test that proves it. `npm run test:access` went from pinning the
broken behaviour to proving it is gone — **27/27 checks pass**. Section 3 is the configuration as it
stands *after* the fixes.

---

## 1. How Keystone access actually behaves

This matters before reading the tables, because two very different things are returned by the same
kind of function:

| Return value | Meaning |
|---|---|
| `true` | the operation is allowed, unrestricted |
| `false` | the operation is denied |
| **an object** | the operation is **filtered** — allowed, but only for rows matching the filter |

That third case is where most of the subtlety lives. `{ user: { id: session.itemId } }` does not
mean "yes"; it means "yes, but only your own rows".

## 2. The rule vocabulary (`access.ts`)

| Rule | Anonymous | Signed-in, no permission | With the relevant permission |
|---|---|---|---|
| `canManageProducts` | `false` | `{ user: { id } }` — own products only | `true` |
| `canOrder` | `false` | `{ user: { id } }` — own cart items | `true` |
| `canManageOrderItems` | `false` | `{ order: { user: { id } } }` — items of own orders | `true` |
| `canReadProducts` | `{ status: 'Available' }` | `{ status: 'Available' }` | `true` |
| `canManageUsers` | `false` | `{ id }` — self only | `true` |
| `canManageCategories` | `false` | `false` | `true` |
| `canReadProductImages` | `{ product: { status: 'Available' } }` | same filter | `true` |
| `canManageProductImages` | `false` | `{ product: { user: { id } } }` — images of own products | `true` |

`permissions.*` (generated from `permissionFields`) are pure yes/no checks against
`session.data.role[...]`. `canReadProducts` and `canReadProductImages` are the two rules that hand
anonymous users a filter rather than a denial — and that is the correct shape, because each restricts
them to `Available` rows rather than exposing drafts.

## 3. Every list, as configured

| List | create | read | update | delete |
|---|---|---|---|---|
| `User` | `true` | `rules.canManageUsers` | `rules.canManageUsers` | `permissions.canManageUsers` |
| `Role` | `permissions.canManageRoles` | `permissions.canManageRoles` | `permissions.canManageRoles` | `permissions.canManageRoles` |
| `Product` | `isSignedIn` | `rules.canReadProducts` | `rules.canManageProducts` | `rules.canManageProducts` |
| `ProductImage` | `isSignedIn` | `rules.canReadProductImages` | `rules.canManageProductImages` | `rules.canManageProductImages` |
| `Category` | `isSignedIn` | `true` | `rules.canManageCategories` | `rules.canManageCategories` |
| `CartItem` | `isSignedIn` | `rules.canOrder` | `rules.canOrder` | `rules.canOrder` |
| `Order` | `isSignedIn` | `rules.canOrder` | `permissions.canManageOrders` | `() => false` |
| `OrderItem` | `isSignedIn` | `rules.canManageOrderItems` | `permissions.canManageOrders` | `() => false` |

This table is the configuration **after** the day-19 fixes; the pre-fix values are preserved in each
finding below, which records what was wrong and what replaced it.

Field-level access: `User.role` — `create` and `update` both require
`permissions.canManageUsers`, which is what stops a normal user from promoting themselves.

## 4. Findings — all six closed on 2026-10-11

### F1 — `ProductImage.read: true` exposes images of unpublished products (information disclosure)

`schemas/ProductImage.ts:17` returns `true`, while the product it hangs off is filtered to
`status: 'Available'` (`schemas/Product.ts:8` → `rules.canReadProducts`).

A `Draft` or `Unavailable` product's row is hidden, but its `ProductImage` rows — image + `altText`
— are readable by anyone, including anonymous users. An unauthenticated caller can enumerate
`allProductImages` and see assets for products that were deliberately not published.

**Recommendation:** replace `true` with a filter that follows the product's status, or deny
anonymous reads outright.

**CLOSED.** `read` is now `rules.canReadProductImages`: `true` only for a holder of
`canManageProducts`, otherwise the filter `{ product: { status: 'Available' } }`. The filter follows
the relationship to the product — a `ProductImage` access function never queries the `ProductImage`
list, which is the self-recursion trap. **Proof:**
`F1 closed: a product image is only as public as its product`. **Owner's decision:** anonymous users
see images only for `Available` products.

### F2 — CLOSED — owners could not manage their own `ProductImage`

`ProductImage.update` / `.delete` use `permissions.canManageProducts` (permission *only*), whereas
`Product` uses `rules.canManageProducts` (permission **or** ownership) — `ProductImage.ts:18-19` vs
`Product.ts:9-10`.

Consequence: a signed-in user who created a product can edit the product but **not** the image
attached to it. The same permission-or-ownership semantics should apply to both, or the asymmetry
should be deliberate and written down.

**CLOSED.** `rules.canManageProductImages` mirrors the product rule through the relationship:
`false` for anonymous, `{ product: { user: { id } } }` for an owner, `true` with the permission —
and `ProductImage` writes now use it. Image management is ownership-aware again. **Proof:**
`F2 closed: image writes mirror product ownership, not permission-only`.

### F3 — CLOSED — `Category` filtered on a column it does not have

`schemas/Category.ts:10-11` uses `rules.canManageProducts`, whose owner branch returns
`{ user: { id: session.itemId } }`. `Category` has no `user` field (it has `name`, `slug`,
`products`), so for a signed-in user without the permission the returned filter references a column
that does not exist.

Practical effect: the intended "use the same rules as product management" (per the inline comment)
does not hold. Either the filter is rejected or it matches nothing — in both cases the real
behaviour is *only admins can manage categories*, which is not what the code says it does.

**Recommendation:** give `Category` its own rule returning `false` for non-admins (which is the
effective behaviour today), or add an owner field if ownership is genuinely wanted.

**CLOSED.** `Category` now uses `rules.canManageCategories` — permission-only, which is exactly the
behaviour it always had, expressed in a rule `Category` can satisfy. No owner field was invented:
ownership of a category is not a concept this shop has. **Proof:**
`F3 closed: Category uses a rule it can actually satisfy`.

### F4 — CLOSED — three permissions were declared but never enforced

`isAwesome` is defined in `permissions` (`access.ts:29`) and referenced nowhere else in the backend.
`canSeeOtherUsers` and `canManageOrders` exist in `permissionFields`
(`schemas/fields.ts:8`, `:24`) and are likewise referenced by no access rule — `canManageUsers`
covers reading other users, and orders are read via `rules.canOrder`.

Because the Role admin UI renders every checkbox in `permissionFields`, an operator can grant these
permissions and see no behaviour change at all. That is a misleading security surface: the UI
promises capability the code never grants.

**Recommendation:** delete `isAwesome`; either implement `canSeeOtherUsers` /
`canManageOrders` or remove them from `permissionFields` so the Role screen only lists permissions
that do something.

**CLOSED.** `isAwesome` and `canSeeOtherUsers` were **deleted** (the latter duplicated what
`canManageUsers` already did for reads). `canManageOrders` was **implemented** — it gates order and
order-item corrections (see F5) — and its label corrected to "User can correct orders and order
items". Every checkbox the Role screen renders is now enforced by code. **Proof:**
`F4 closed: nothing is declared that the code does not enforce`.

### F5 — CLOSED — nobody, including an administrator, could correct an order

`Order.ts:16-17` and `OrderItems.ts:9-10` return `() => false` for both `update` and `delete`.
This is a defensible immutability stance for order history, but it is absolute: a genuine data
correction (a mis-charged order, a duplicated line item) is impossible through the API for every
role, including administrators, and would require direct database access.

**Recommendation:** decide explicitly. If immutable-by-design, say so in this doc and keep the test
that asserts it. If admins need corrections, gate `update` on a new `canManageOrders` permission —
which already exists (see F4) and currently does nothing.

**CLOSED, explicitly decided.** `update` is now `permissions.canManageOrders` on both `Order` and
`OrderItem`, so an administrator holding that permission can correct a mis-charged order or a
duplicated line item through the API. `delete` stays `() => false` on both: that is now a written
retention decision rather than an accidental blanket denial — corrections are updates, and financial
history is never hard-deleted. Customers remain unable to touch either. **Proof:**
`F5 closed: order corrections are gated on canManageOrders; nothing is deleted`.

### F6 — CLOSED — a session without `data` threw instead of denying

`access.ts:21` is `return !!session?.data.role?.[permission];`. The optional chain protects
`session` but not `session.data`: a session object that exists without a `data` property raises
`TypeError: Cannot read properties of undefined (reading 'role')` rather than returning `false`.

Failing loudly is not a security hole here (an exception denies the request — it does not allow
it), but an access predicate is the wrong place to throw. `isAwesome` uses
`session?.data?.name` and is safe; the generated permissions should match it.

**Recommendation:** `session?.data?.role?.[permission]`. Until then, this audit records the current
behaviour as a known hazard, and the test pins it so the fix is visible in the diff.

**CLOSED.** The generated permission checkers are now `!!session?.data?.role?.[permission]`, so a
session object without a payload denies instead of raising `TypeError`. **Proof:**
`F6 closed: a session without `data` denies instead of throwing` — every permission checker and rule
is called with `{ session: { itemId } }` and must return `false` (or a filter), never throw.

### Observations (not findings)

- `CartItem.product` uses `ref: 'Product'` and `OrderItem.photo` uses `ref: 'ProductImage'` —
  bare list names with no back-reference field. These are one-way relationships; legitimate, but
  they mean there is no `Product.cartItems` or `ProductImage.orderItems` to query from the other
  side. Worth confirming that is intended.
- `User.create: true` allows anonymous user creation, which Keystone's own signup flow requires.
  It is safe **only** because `User.role` is separately gated on `permissions.canManageUsers`;
  a self-registered user cannot assign themselves a role. That dependency is now covered by a test
  so it cannot be broken without failing the suite.

## 5. What the tests prove

`test/access-rules.test.js` loads the real `access.ts` (transpiled with the project's own
`typescript`) and asserts, for every rule and every caller class:

- anonymous callers are denied all six management rules;
- anonymous callers get a **filter**, never `true`, from `canReadProducts`;
- a signed-in user with no permissions is scoped to their own rows, and cannot reach a role or
  another user's products, cart, orders or order items;
- a permission holder gets unrestricted access;
- every permission declared in `permissionFields` has a working checker;
- F1–F6 are each proved closed by the rule itself or by the schema source. Source-level assertions
  strip comments before matching, so they test behaviour rather than the prose describing the fix.

Run it with `npm run test:access` from `sick-fits/backend`. Current result: **27/27 checks pass.**

## 6. Decisions taken (2026-10-11)

1. F1 — **No.** Anonymous users see images only for `Available` products.
2. F2 — **Mirror ownership.** Image writes follow the owning product, via the relationship.
3. F3 — **No owner on `Category`.** Categories are shop-wide; the rule is permission-only.
4. F4 — `isAwesome` and `canSeeOtherUsers` deleted; `canManageOrders` implemented (see F5).
5. F5 — **Yes, within limits.** `canManageOrders` may *update* orders and order items; nothing may
   delete them.
