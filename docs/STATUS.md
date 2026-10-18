# TrendyFits — end-to-end status

**Audited:** 2026-10-08 (Day 16)
**Auditor's method:** cloned/updated the repo to `main` @ `24e7aa8`, then ran the two packages
exactly as the root README instructs, as a stranger with no prior knowledge of the project would.
Every claim below carries a repro step and the observed output.
**Audited commit:** `24e7aa8` — "docs(readme): add root README — what/why/stack/run/deploy for the
two-package monorepo" (2026-10-06)
**Updated:** 2026-10-09 (Day 17) — BUG-1 is now split into a fixed half (BUG-1a: the admin UI did
not build on Windows) and an open one (BUG-1b: the dev server can exit code 1 with no message).
2026-10-14 (Day 22) — GAP-8's counts are corrected (the checkout path now typechecks: 16 errors in
6 files, down from 23 in 7) and GAP-11 records the checkout audit, its three closed findings and the
four still open. See §3.

---

## 1. Starting it — the exact two-package startup

There is **no root `package.json`** and no workspace. `sick-fits/` is a folder. Every command runs
from inside the package it belongs to. This is the whole startup, in order.

### 0. Node 16 is mandatory — check it first

```bash
node --version          # must print v16.x
```

Observed on the audit machine, with no nvm step:

```
$ node --version
v26.2.0
```

That fails the build. Fix with nvm-windows (Node 16.20.2 is installed alongside):

```bash
nvm use 16.20.2
node --version          # v16.20.2
npm  --version          # 8.19.4
```

Why it matters: the Keystone 5 backend renders its admin UI with Next 10 / webpack 4, whose `md4`
hash was removed in OpenSSL 3. Node 17+ breaks it. The README says this; it is correct.

### 1. Backend — the GraphQL API and admin UI

```bash
cd sick-fits/backend
npm ci                      # postinstall runs patch-package; the patches in patches/ must apply
```

Create `sick-fits/backend/.env`. **There is no `.env.example` in the repo**
(`git ls-files | grep -i env` prints nothing), so this list is the only specification of it — it is
transcribed from the root README, and the Keystone config is evaluated at start, so **all** of these
must exist or the process exits:

```dotenv
DATABASE_URL=mongodb://localhost:27017/trendyfits   # or a mongodb+srv:// Atlas string
COOKIE_SECRET=<any long random string>
CLOUDINARY_CLOUD_NAME=<cloudinary cloud name>
CLOUDINARY_KEY=<cloudinary key>
CLOUDINARY_SECRET=<cloudinary secret>
STRIPE_SECRET=sk_test_<stripe test key>
MAIL_HOST=smtp.ethereal.email
MAIL_PORT=587
MAIL_USER=<smtp user>
MAIL_PASS=<smtp password>
FRONTEND_URL=http://localhost:7777
```

Then:

```bash
npm run dev                 # keystone-next
```

**The line that means it is up** — wait for this before touching the frontend:

```
👋 Admin UI and graphQL API ready
```

Endpoints once it is up:

| URL | Observed |
| --- | --- |
| `http://localhost:3000/api/graphql` | GraphQL API |
| `http://localhost:3000/admin` | `302` (redirects to sign-in) |
| `http://localhost:3000/admin/signin` | `302` |
| `http://localhost:3000/__keystone_dev_status` | `{"ready":true}` |

On first ever run Keystone creates the initial admin from `initFirstItem` (`name`, `email`,
`password`). Optional: `npm run seed-data`.

> **Read §3 before you plan around this.** On the audit machine the backend reached ready on
> **1 attempt out of 5**. The other four stalled and died. See BUG-1.

### 2. Frontend — the storefront

```bash
cd sick-fits/frontend
npm ci
npm run dev                 # next -p 7777
```

Expected and observed:

```
▲ Next.js 13.5.11
- Local:        http://localhost:7777
- Environments: .env.local, .env
✓ Ready in 32.4s
```

`/` returns `308` (permanent redirect) to `/products`. Start the backend first — in development the
Apollo client resolves to `http://localhost:3000/api/graphql`.

### 3. What the API is called from the frontend

`sick-fits/frontend/lib/withData.js` `getEndpoint()` resolves in this order, and the **first** match
wins:

1. `process.env.NEXT_PUBLIC_BACKEND_URL` — `/api/graphql` is appended unless already present.
2. `?useLocal=true` in the URL.
3. `http://localhost:3000/api/graphql` when the page is on `localhost` / `127.0.0.1`.
4. `https://api.owenstack.com/api/graphql`.

Rule 1 outranks rule 3, and this matters — see GAP-6.

---

## 2. Verified working end to end

Run with the backend up, Node 16, frontend on `:7777`.

| Check | Command | Observed |
| --- | --- | --- |
| Products, server-rendered | `curl -s http://localhost:7777/products \| wc -c` | `200`, **59,973 bytes** |
| Product count | `curl -s -X POST http://localhost:3000/api/graphql -H 'Content-Type: application/json' -d '{"query":"{ _allProductsMeta { count } }"}'` | `{"data":{"_allProductsMeta":{"count":67}}}` |
| Products returned | `... -d '{"query":"{ allProducts(first: 3) { name price status } }"}'` | `Damba men's Off-white 12000 Available`, `Mad Game Pro 30000 Available`, `Uniqlo Flannel 150000 Available` |
| Home redirect | `curl -o /dev/null -w '%{http_code}' http://localhost:7777/` | `308` |
| Category | `curl -o /dev/null -w '%{http_code}' http://localhost:7777/category/hoodies` | `200` |
| Pagination to the last page | `curl -o /dev/null -w '%{http_code} %{size_download}' 'http://localhost:7777/products?page=6'` | `200 49684` |
| Sell / signin / account | same for `/sell`, `/signin`, `/account` | `200`, `200`, `200` |
| Unknown route | `curl -o /dev/null -w '%{http_code}' http://localhost:7777/nope-xyz` | `404` |

`/products` really does contain the catalogue in the HTML: 12 `<img>` tags, product links
(`href="/product/69cd76…"`), prices (`$120`), `+ ADD TO BAG`, and the category links
(hoodies, shoes, trousers, outerwear, t-shirts).

**Test suite** — the README's claim that "100% of the suite must pass" holds:

```
$ cd sick-fits/frontend && npm test        # jest --ci, Node 16
Test Suites: 10 passed, 10 total
Tests:       29 passed, 29 total
Snapshots:   11 passed, 11 total
Time:        98.059 s
```

---

## 3. Bugs, gaps and unknowns

### BUG-1 — the admin UI will not build on Windows, and the dev server can still die silently (SEVERITY: blocking)

**Updated 2026-10-09 (Day 17).** The original day-16 entry is kept at the end of this section for the
record. This is what the follow-up investigation found: one half of BUG-1 is now fixed and covered by
a regression test, the other half is re-measured, corrected, and still open.

#### BUG-1a — FIXED (2026-10-09): the generated admin-UI api module imports a path that cannot resolve on Windows

Keystone generates `.keystone/admin/pages/api/__keystone_api_build.js`, whose whole job is to
re-export the project's Keystone config:

```js
export { default as config } from '<path from this file to backend/keystone>';
```

`@keystone-next/admin-ui` 8.0.2 builds that path with `Path.relative()`, which returns **backslash**
separators on Windows, and interpolates the result into the import specifier without normalising it
(the sibling code path 20 lines below *does* normalise — for user-supplied admin pages). JavaScript
reads `..\..\..\..\keystone` as a string with escape sequences, so the specifier actually written to
the file is:

```js
export { default as config } from '........keystone';
```

Repro on Windows, Node 16.20.2, before the fix:

```bash
cd sick-fits/backend && npm run build
# ✨ Building Admin UI
# info  - Creating an optimized production build...
# Failed to compile.
# ModuleNotFoundError: Module not found: Error: Can't resolve '........keystone' in
#   '...\sick-fits\backend\.keystone\admin\pages\api'
# Error: > Build failed because of webpack errors
# exit code 1
```

So `npm run build` — and therefore `npm run start`, the production command the README documents —
failed outright on Windows. CI could not see it: the backend job runs on `ubuntu-latest`, where
`Path.relative()` already returns forward slashes.

**Fix:** `sick-fits/backend/patches/@keystone-next+admin-ui+8.0.2.patch`, applied automatically by
`patch-package` from the package's `postinstall` hook — `npm ci` is still all anyone has to do. It
normalises the separators the way the same function already does for user pages, in all three shipped
builds (cjs dev, cjs prod, esm) and in the TypeScript source.

**Regression test:** `npm run test:admin-ui-import` (`sick-fits/backend/test/admin-ui-api-import.test.js`,
no framework, no new dependency). It reads the generated module and asserts the specifier is a
relative POSIX path that resolves to `keystone.ts` on disk. Observed:

```
before the patch   FAIL: the generated import specifier is "........keystone", …
after  the patch   PASS: __keystone_api_build.js imports '../../../../keystone' -> …\backend\keystone.ts
```

#### BUG-1b — NOT FIXED: the dev server can exit with code 1 and print nothing

The day-16 entry recorded five attempts of which one came up. Re-measured on 2026-10-09:

| Attempt | Command | Result |
| --- | --- | --- |
| 6 (clean `.keystone`) | `PORT=3100 npm run dev` | **reached ready**, `{"ready":true}`, in **~470 s**; `/signin` 200, `/admin` 302, API 200 |
| 7 | `npm run dev` (port 3000 contended) | **died silently, exit code 1**, during the admin-UI compile — after `Browserslist…`, before `event - compiled successfully` |

Attempt 6's numbers, for anyone planning around this: port bound at ~280 s, admin-UI compile (the
long pole) ~190 s, peak working set ~700 MB during the compile falling to ~405 MB once up. That is
5× the "ready in ~90 s" the root README implies, and it is the likeliest reason the day-16 attempts
were declared dead: they were polled for 240–300 s.

Attempt 7 is the interesting one — it reproduces the day-16 signature exactly (exit 1, no error, no
stack, no marker, inside the compile) and it is the only run made while another process held `:3000`.

Windows' own leak detector also noticed this process on day 16: Application log, WER event 1001,
`Event Name: RADAR_PRE_LEAK_64`, `P1: node.exe`, `P2: 16.20.2.0`, **2026-10-08 17:49:39**. Mind what
that is and is not: it is the OS reporting *rapid memory growth*, not a crash report. There is no
`Application Error` (event 1000) for node.exe anywhere in that window, so nothing in the event log
records the process dying.

**Correction to the day-16 record.** Attempts 2–5 are written up as "never bound `:3000`". Their own
logs contradict that: every one of them contains `⭐️ Dev Server Ready on http://localhost:3000`,
which is printed from `server.listen`'s success callback, and the lines after it (`✨ Preparing
Next.js app`, the Browserslist and babel notices) only run while Keystone is initialising. What
actually happened is that they bound the port, got as far as the admin-UI compile and died there.
That distinction matters to a reproducer: "never bound" sends you looking at the port, the real
failure is in the compile.

**Port note for this machine.** `:3000` is now permanently occupied by the Hermes WhatsApp bridge,
and Node sets `SO_REUSEADDR` on Windows — so Keystone's `listen(3000)` **succeeds anyway** (Keystone
binds the wildcard address, the bridge holds `127.0.0.1`) and you get no EADDRINUSE to notice. Use
`PORT=3001 npm run dev` and confirm with `netstat -ano | grep LISTENING | grep :3000`.

**Ruled out for the silent exit:** heap exhaustion (4 GB made no difference on day 16, and the
process peaks near 700 MB), the frontend dev server, and — from day 17 — the malformed import of
BUG-1a: that module is not compiled during a dev start, and attempt 6 came up and served traffic with
the malformed file still on disk.
**Still open:** why the same compile takes ~3 minutes and succeeds on one run and kills the process
on another, and whether Windows' leak detector is the thing that terminates it.

---

<details>
<summary>Original day-16 entry (2026-10-08), kept for the record</summary>

The backend dev server usually does not come up (SEVERITY: blocking) — five attempts, on Node 16, all
with `cd sick-fits/backend && npm run dev`:

| Attempt | Result | How long before failure |
| --- | --- | --- |
| 1 | **reached `👋 Admin UI and graphQL API ready`**, served GraphQL and `/admin` | ready in ~90 s; then exited code 1 after ~622 s |
| 2 | never bound `:3000` (see the correction above — it did) | exited code 1 after 293 s |
| 3 | never bound `:3000` (see above) | exited code 1 after ~315 s |
| 4 (frontend stopped) | never bound `:3000` (see above) | exited code 1 after ~260 s |
| 5 (`NODE_OPTIONS=--max-old-space-size=4096`) | never bound `:3000` (see above) | exited code 1 after ~240 s |

All five attempts terminated with exit code 1. None hung indefinitely — each was confirmed by the
process's own exit status, not inferred from a timeout in the log. So this presents as a silent
crash, not a hang.

Ruled out by experiment: insufficient heap (4 GB made no difference), contention from the frontend dev
server (it still failed with the frontend stopped).
Not yet ruled out at the time: the OneDrive-synced folder, a stale `.keystone/` admin build cache, a
Keystone 5.9.3.1 admin-UI Next 10 build quirk on Node 16.
Actionable suggestion then: clone to a path outside OneDrive, delete `sick-fits/backend/.keystone`
between attempts.

Day-17 note on those two suggestions: no `node_modules` file under `sick-fits/backend` carries the
OneDrive "offline"/"recall on data access" attribute (checked with
`[System.IO.File]::GetAttributes`), so the folder is not being dehydrated; and attempts 6 and 7 both
ran against a deleted `.keystone/`, which did not make the compile reliable on its own.

</details>

### BUG-2 — `/products?page=N` has no upper bound

Only 6 pages exist (67 products). The 7th and 99th still return `200` with a full page shell and
**zero products**, and no "no results" message:

```bash
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' 'http://localhost:7777/products?page=7'
# 200 33355
curl -s 'http://localhost:7777/products?page=7' | grep -c 'href="/product/'
# 0
curl -s 'http://localhost:7777/products?page=99' | grep -c 'href="/product/'
# 0
```

A user who edits `?page=` gets a blank catalogue with no explanation.

### BUG-3 — the product page is not server-rendered with product data

`/products` renders its catalogue into the HTML. `/product/<id>` does not:

```bash
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' http://localhost:7777/product/69cd76336cf328431473134c
# 200 18154
```

Its `__NEXT_DATA__` contains only the query, no product:

```json
{"props":{"pageProps":{"query":{"id":"69cd76336cf328431473134c"}}}}
```

…versus `/products`, whose SSR HTML carries 12 images, product links and prices. A crawler, a
link-preview bot, or any user without JavaScript gets a product page with no product on it.

### BUG-4 — with the API unreachable the storefront shows "Loading…" forever

With nothing listening on `:3000`:

```bash
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' http://localhost:7777/products
# 200 16549
curl -s http://localhost:7777/products | grep -c 'href="/product/'
# 0
```

`200`, 16.5 KB, no products, no `<title>`. In a real browser the page renders its header, marquee and
footer and then sits on **"Loading…"** indefinitely — it never reaches an error state and tells the
user nothing.

That is not a white screen, so it is not quite the failure the README describes. The README says
"every query has an error path, so a stale or sleeping API shows the failure rather than a white
screen"; what is actually observed is a permanent loading state. Either the error path is not
reached, or "Loading…" *is* the failure path and it is indistinguishable from a slow network.

### GAP-5 — `sick-fits/package-lock.json` promises a package that does not exist

`sick-fits/` contains a committed lockfile and **no `package.json`**:

```json
{ "name": "sick-fits", "lockfileVersion": 2, "requires": true, "packages": {} }
```

A stranger reading that lockfile will do the obvious thing, and it fails:

```bash
cd sick-fits && npm ci
# npm error enoent Could not read package.json: ENOENT: no such file or directory,
#   open '.../sick-fits/package.json'
```

Either commit a real root `package.json` (even a scripts-only one) or delete the stub lockfile.

### GAP-6 — the two frontend env files disagree, and `.env.local` silently wins

Both exist locally (both untracked, as they should be) and set the same variable to different values:

| File | `NEXT_PUBLIC_BACKEND_URL` |
| --- | --- |
| `sick-fits/frontend/.env` | `https://api.owenstack.com/api/graphql` |
| `sick-fits/frontend/.env.local` | `http://localhost:3000` |

Next.js gives `.env.local` precedence, so local development talks to the local API — correct, but
only by accident of precedence. The frontend dev server reports `Environments: .env.local, .env`,
and `getEndpoint()` stops at the first rule that matches, so the effective API can only be determined
by knowing Next's file-precedence rules. A `.env.example` naming the variable and its default would
remove the ambiguity.

### GAP-7 — stale branding: the storefront still calls itself "Sick Fits" in three components

Repro:

```bash
grep -rn "Sick Fits" sick-fits/frontend
```

| File:line | String |
| --- | --- |
| `components/SingleProduct.js:53` | `<title>Sick Fits \| {Product.name}</title>` |
| `pages/account.js:172` and `:215` | `<title>Account \| Sick Fits</title>` |
| `pages/order/[id].js:46` | `<title>Sick Fits - Order {order.id}</title>` |

The brand is also set three different ways:

| File:line | String |
| --- | --- |
| `components/Header.js:148` | `TrendyFits` |
| `components/Pagination.js:30` | `Trendy fits - page {page} of {pageCount}` |
| `pages/order.js:58` | `Your Orders({orders.length})` — no brand at all |

Only `account`, `order` and `order/[id]` set a `<title>`. `products`, `category`, `sell`, `signin`,
`reset` and `update` set none, so their browser tab title is inherited or empty. And
`Your Orders(3)` is missing a space before the parenthesis.

Also still carrying the upstream attribution, as the README's *Known gaps* already admits:

```json
"author": "Wes Bos",
"repository": "https://github.com/wesbos/advanced-react"
```

### GAP-8 — the backend typecheck fails in 6 files, and the README lists 5

```bash
cd sick-fits/backend && npx tsc --noEmit; echo "exit=$?"
# exit=2   (16 error lines)   — re-measured 2026-10-14, Day 22
```

| File | Errors |
| --- | --- |
| `seed-data/index.ts` | 5 |
| `lib/mail.ts` | 4 |
| **`access.ts`** | **4** |
| `schemas/ProductImage.ts` | 1 |
| `lib/stripe.ts` | 1 |
| **`keystone.ts`** | **1** |

**Correction, Day 22:** this section used to begin "fails in 7 files (23 error lines)" with
`mutations/checkout.ts` heading the table at 7. The checkout path is now typed properly and that file
reports **0**, so the totals are 16 lines in 6 files. Nothing else moved.

The README's *Known gaps* names `lib/mail.ts`, `lib/stripe.ts`, `mutations/checkout.ts`,
`schemas/ProductImage.ts` and `seed-data/index.ts`. **`access.ts` and `keystone.ts` are missing from
that list**, so the CI step's non-blocking commentary is incomplete. Samples:

```
access.ts(46,26): error TS18048: 'session' is possibly 'undefined'.
access.ts(57,26): error TS18048: 'session' is possibly 'undefined'.
access.ts(68,35): error TS18048: 'session' is possibly 'undefined'.
access.ts(86,18): error TS18048: 'session' is possibly 'undefined'.
keystone.ts(98,45): error TS2345: Argument of type '{ maxAge: number; secret: string | undefined;
  sameSite: string; secure: boolean; }' is not assignable to parameter of type 'StatelessSessionsOptions'.
mutations/checkout.ts(57,57): error TS2339: Property 'price' does not exist on type 'ProductRelateToOneInput'.
lib/stripe.ts(4,3): error TS2322: Type '"2022-11-15"' is not assignable to type '"2020-08-27"'.
```

`lib/stripe.ts(4,3)` is worth a second look on its own: the pinned `apiVersion` does not match the
installed Stripe types' expected literal.

### GAP-9 — local artefacts are still tracked

```bash
git ls-files | grep -iE 'cookies|\.log$|build\.|build_output|OPENSSL'
```

```
sick-fits/frontend/OPENSSL_ERROR_EXPLANATION.md
sick-fits/frontend/build.err
sick-fits/frontend/build.log
sick-fits/frontend/build_output.log
sick-fits/frontend/cookies.txt
```

The README's *Known gaps* mentions "build logs and a `cookies.txt`". `OPENSSL_ERROR_EXPLANATION.md`
is tracked too and is not mentioned. The root `.gitignore` added on 2026-10-01 includes `*.log`, but
an ignore rule cannot untrack a file that is already committed — these need `git rm --cached`.

### GAP-10 — anonymous callers can read every product, and the asymmetry is silent

```bash
curl -s -X POST http://localhost:3000/api/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ _allProductsMeta { count } _allUsersMeta { count } _allOrdersMeta { count } }"}'
```

Returns the product count and `AccessDeniedError: "You do not have access to this resource"` for
users and orders. Public read access to the catalogue is correct for a storefront; what is worth
recording is that the denial is only visible by calling the API — the server log shows
`"msg":"Access Denied"` and the frontend has no path that surfaces it. Note also that Keystone 5
takes `first:` — an API consumer who tries `allProducts(take: 3)` gets
`ValidationError: Unknown argument "take" on field "Query.allProducts"`.

### GAP-11 — the checkout had four money-shaped holes; three are closed (2026-10-14, Day 22)

Day 22 audited `mutations/checkout.ts`, `lib/stripe.ts` and `components/Checkout.js` against the
**live Stripe test key**, exercising each failure path rather than reading it. Closed:

- a 3-D Secure card produced a **free order** — the charge call resolves with
  `status: 'requires_action'` and no error, and "the call returned" was being read as "the customer
  paid";
- a **double-click charged twice** — `loading` was set and never used, and nothing stopped the second
  request server-side;
- Stripe's **developer messages reached the customer**, including a masked API key for a
  misconfiguration;
- a failed payment **left the loading bar running** — `nProgress.done()` was only reachable on the
  success path.

Still open, with the fix each one wants: the charge and the order are **not transactionally linked**
(F5 — a paid customer with no order is now legible, but not repaired); an **unknown-outcome retry can
only be refused, not resolved** (F6); a cart line whose **product was deleted is dropped silently**
(F7); and **none of the backend test suites run in CI** (F8 — 80+ checks that only run by hand).
Full evidence, probes and fix shapes: `docs/CHECKOUT-AUDIT.md`.

### GAP-12 — the order status flow now exists; two holes around it are open (2026-10-18, Day 26)

Day 26 added a lifecycle to `Order` (`CREATED → PAID → FULFILLED → DELIVERED`, plus `CANCELLED`),
enforced in `lib/orderStatus.ts` and `Order.hooks.resolveInput`, and gave customers a real order
history at `/order` (`docs/ORDER-STATUS.md`). Three things found while doing it:

- **Fixed — staff could not read the orders they were allowed to correct.** `Order.read` used
  `rules.canOrder`, which grants unrestricted access only to `canManageCart`, so a
  `canManageOrders` holder saw only their own purchases. New `rules.canReadOrders` (permission OR
  ownership) fixes it without widening `canOrder`, which also guards `CartItem` — widening that
  would have exposed every customer's basket.
- **Open — the admin UI is open to any signed-in session.** `keystone.ts` gates it on
  `!!session?.data`, which every customer has. List access still scopes their rows, but the shell is
  reachable. Tightening it needs a verified look at the live `Role` data; guessed, it locks the owner
  out of his own admin.
- **Open — `Order.create` is `isSignedIn`.** The generated `createOrder` mutation accepts an order
  with an arbitrary `total`/`charge` from any signed-in customer. The status field is protected; the
  order write is not.
- **Version limit, not a bug we can fix here:** `@keystone-next/keystone` 9.3.1 drops
  `ui.labelField`, `ui.listView`, `ui.createView` and field `ui.displayMode` — its types accept them
  (types 12 is newer than the runtime) and `initConfig` never passes them on. The status is therefore
  edited as a text value in the admin item view and the flow is enforced server-side. `npm run
  check:schema` prints the admin meta so this stays visible.

### Unknown-1 — is the local API reachable *from the browser*?

Once, in a browser on `http://localhost:7777/products`, a `fetch` to
`http://localhost:3000/api/graphql` failed with `TypeError: Failed to fetch` while
`https://api.owenstack.com/api/graphql` returned `200` in the same page. **That observation is not
evidence of a CORS fault: the local API was down at the time**, so a connection failure was the
expected result. `keystone.ts` does list `http://localhost:7777` as an allowed origin with
`credentials: true`. Unresolved, and it needs one run with the backend confirmed up:

```bash
curl -s -i -X OPTIONS http://localhost:3000/api/graphql \
  -H 'Origin: http://localhost:7777' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
```

### Unknown-2 — does the product page fill in client-side?

`/product/<id>` ships no product data (BUG-3). Whether Apollo hydrates and fetches it successfully in
a browser was not confirmed, because the API would not stay up long enough to hold the page open.

### Unknown-3 — why does the backend exit with code 1 and no message?

See BUG-1b. Nothing in the log explains it, and the process does not print an error. Keystone 5 is
unmaintained and the Mongo connection is to an Atlas cluster; an unhandled rejection on a dropped
connection is a plausible mechanism, but that is a guess, not a finding.

**Day 17 (2026-10-09):** one more run died the same way (exit code 1, no output, during the admin-UI
compile) while every other run of the same command came up — so it is intermittent, not deterministic,
and the mechanism is still unknown. What day 17 did remove from the list of suspects is the malformed
admin-UI import of BUG-1a: that module is not compiled during a dev start, and a run with the
malformed file still on disk reached ready and served traffic. See BUG-1b for the measurements.

---

## 4. Summary

**Startable?** The frontend: yes, reliably, in ~32 s. The backend: `npm run build` now succeeds on
Windows (BUG-1a, fixed 2026-10-09), so the documented `npm run start` production path works; on a
clean cache a dev start took **~8 minutes** in the day-17 measurement, and one run in three still
died with exit code 1 and no message (BUG-1b). So the honest answer to "can someone else start
both services from this document alone" is **yes — if the time expectation is minutes, not the
~90 s the root README implies** — and with BUG-1b named as the thing that can still stop you.

**Verified working:** the GraphQL API with 67 real products, the server-rendered catalogue with
pagination across 6 pages, categories, the admin route, and a green 29-test suite.

**Broken or risky, in priority order:**

1. **BUG-1b** — the backend dev server can exit code 1 printing nothing, during the admin-UI
   compile; a clean start also measured ~8 minutes, not the ~90 s the README implies (blocking, open).
2. **BUG-3** — product pages ship no product data in the HTML.
3. **BUG-4** — with the API down the shop hangs on "Loading…" and says nothing.
4. **BUG-2** — out-of-range `?page=` returns an empty page with no message.
5. **GAP-5** — a lockfile for a package that does not exist; `npm ci` in `sick-fits/` fails.
6. **GAP-8** — the README's typecheck list is incomplete (2 files missing).
7. **GAP-7** — "Sick Fits" branding in three components; three different brand spellings; most pages
   have no `<title>`.
8. **GAP-6** — two env files disagree on which API the storefront uses.
9. **GAP-9** — five local artefacts still tracked.
10. **GAP-10** — the read-access asymmetry is invisible except by calling the API.
11. ~~**BUG-1a**~~ — the admin UI would not build on Windows at all
    (`Can't resolve '........keystone'`), so `npm run build`/`npm run start` failed outright.
    **Fixed 2026-10-09** — patch-package patch + `npm run test:admin-ui-import`.

---

## 5. How to reproduce this audit

```bash
nvm use 16.20.2
git clone https://github.com/Owen5e/TrendyFits.git && cd TrendyFits
git log -1 --oneline                      # 24e7aa8 on main

# backend (see BUG-1; attempt until it prints "👋 Admin UI and graphQL API ready")
cd sick-fits/backend && npm ci && npm run dev

# frontend
cd ../frontend && npm ci && npm run dev   # expect "✓ Ready in ~32s" on :7777

# the checks in §2, then the repro commands in §3
```

The audit's own logs and probe scripts are in the day's working folder
(`backend-dev-run*.log`, `frontend-dev-node16.log`, `frontend-test.log`, `backend-tsc.log`,
`probe-*.sh`).

### Reproducing the BUG-1a fix (Day 17, 2026-10-09)

```bash
cd sick-fits/backend
npm ci                          # postinstall runs patch-package, which applies patches/
npm run build                   # BEFORE the fix: "Module not found: Can't resolve '........keystone'", exit 1
                                # AFTER  the fix: completes
npm run test:admin-ui-import    # BEFORE: FAIL … "........keystone"   AFTER: PASS … '../../../../keystone'
PORT=3100 npm run start         # the production command; 3100 because :3000 is held on this machine
```

Day-17 artefacts (logs, probe scripts, the pristine package copies the patch was cut from) are in
`C:\Users\olada\dev\day17-2026-10-09`.
