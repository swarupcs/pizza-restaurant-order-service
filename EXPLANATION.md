# order-service — code walkthrough

How this service is put together, file by file and function by function.

This is the **internals** document. For the request/response contract an API
consumer needs — payload shapes, example bodies, status codes — see
[API-DOCS.md](./API-DOCS.md). This one explains *why the code looks the way it
does*, which is the part that is hard to recover from reading it cold.

---

## 1. What this service owns

order-service is where money is decided. Everything else in the platform
describes food; this is the only service that says what it costs and whether it
was paid for.

| Responsibility | Detail |
| --- | --- |
| Pricing | Turns a cart into a total — options, toppings, coupon, tax, delivery |
| Orders | Create, read, and move through the fulfilment states |
| Customers | order-service's own customer record, created on first use |
| Coupons | Per-tenant discount codes, and validating them |
| Payments | Stripe Checkout sessions and the webhook that confirms them |
| Price cache | Consumes catelog-service's Kafka events so it can price offline |
| Order events | Publishes every order change for notification-service and ws-service |

The defining architectural decision is the **price cache**. order-service never
calls catelog-service at request time. It subscribes to the `product` and
`topping` topics, keeps a local copy of every price, and computes the bill from
that copy. Checkout therefore keeps working while catelog-service is down — and
the cart the client submits is treated as a *statement of what was chosen*, not
of what it costs.

Two things it deliberately does **not** own:

- **Identity.** Like every other service, it validates RS256 access tokens
  locally against auth-service's published JWKS.
- **The menu.** It knows a product's id and its prices, nothing else — no name,
  no image, no description. Those come from the cart body and are stored on the
  order as a snapshot.

### What is conspicuously absent

Reading this service after auth-service or catelog-service, two layers are
missing and their absence explains most of §12:

- **There is no `canAccess` middleware.** Roles are checked, when they are
  checked at all, inside the controllers. Three routes check nothing.
- **There are no validators.** No `express-validator`, no schema on any request
  body. `OrderController.create` carries a bare `todo: validate request data.`
  Malformed input reaches Mongoose and surfaces as a 500.

---

## 2. The shape of a request

```
HTTP request
    │
    ├─ app.ts             cors → cookieParser → express.json
    │
    ├─ */Router.ts        matches the path, assembles the chain, and holds
    │                     all the dependency wiring
    │
    ├─ authenticate       validates the RS256 token (absent on the webhook)
    │
    ├─ asyncWrapper       catches a rejected controller promise
    │
    ├─ */Controller.ts    everything else: role checks, business rules,
    │                     Mongoose queries, and the Kafka publish
    │
    └─ globalErrorHandler catches anything passed to next(err)
```

Note what is *not* in that list. auth-service and catelog-service both put a
service layer between the controller and the database; this one does not. The
controllers import the Mongoose models directly and hold the query logic
themselves. `CustomerController` and `CouponController` both carry a
`todo: implement service layer` acknowledging it.

The practical consequence is that `OrderController` is 434 lines and holds the
entire pricing engine as private methods. That is where §5 spends its time.

---

## 3. Bootstrapping

### `server.ts`

Note the location: the repo root, not `src/`. It is the only file outside
`src/`, which is why `tsconfig`'s `outDir` produces `dist/server.js` alongside
`dist/src/`, and why `package.json`'s start script is `node dist/server.js`.

```ts
const startServer = async () => {
  await connectDB();
  broker = createMessageBroker();
  await broker.connectProducer();
  await broker.connectConsumer();
  await broker.consumeMessage(["product", "topping"], false);
  app.listen(PORT, ...);
};
```

The ordering is deliberate: database, then producer, then consumer, then listen.
Accepting HTTP traffic before the consumer is running would mean serving
requests against a price cache that is not being updated.

`fromBeginning: false` on the subscription is worth understanding. On a fresh
consumer group this means the service starts from the *end* of the topic and
never sees the history — so a brand-new deployment has an empty price cache and
cannot price anything until catelog-service publishes again. Passing `true`
would replay the topic and warm the cache, at the cost of reprocessing every
event on every group reset.

On failure it disconnects both halves of the broker and exits 1.

### `src/app.ts`

Four things, and nothing else:

```ts
const ALLOWED_DOMAINS = [config.get("frontend.clientUI"), config.get("frontend.adminUI")];
app.use(cors({ origin: ALLOWED_DOMAINS as string[], credentials: true }));
app.use(cookieParser());
app.use(express.json());
```

`credentials: true` is required, not cosmetic: the access token arrives as an
httpOnly cookie and the browser will not send it cross-origin without it. The
origin list is a literal allowlist of two rather than a wildcard, because
`credentials: true` and `origin: "*"` are mutually exclusive in the CORS spec.

`cookieParser()` must run before any route, because `authenticate`'s `getToken`
reads `req.cookies.accessToken`.

`express.json()` applies to **every** route including `/payments/webhook`, which
is the reason Stripe signature verification cannot simply be bolted on — see
§9.

Then `GET /` (a health check), the four routers, and `globalErrorHandler` last.

### `src/config/db.ts`

Registers `connected` and `error` listeners on the Mongoose connection before
connecting, so a connection that drops later is logged rather than silent. On a
failure to connect at all it logs and `process.exit(1)` — fail fast rather than
serve requests that will all 500.

### `src/config/logger.ts`

Three winston transports — `logs/combined.log`, `logs/error.log`, and the
console — all `silent` when `NODE_ENV === "test"`. `defaultMeta.serviceName` is
`"order-service"`.

Worth knowing: the Kafka consumer bypasses this entirely and uses `console.log`
on the hot path of every message (§10).

### `src/config/kafka.ts` — `KafkaBroker`

This is the only broker in the platform that is **both** a producer and a
consumer, which is why its interface is `MessageBroker` rather than
catelog-service's `MessageProducerBroker`.

The constructor branches on environment:

```ts
if (process.env.NODE_ENV === "production") {
  kafkaConfig = { ...kafkaConfig, ssl: config.get("kafka.ssl"), connectionTimeout: 45000,
                  sasl: { mechanism: "plain", username: ..., password: ... } };
}
```

Local Kafka runs plaintext with no auth; a managed broker needs SASL/PLAIN over
TLS and is slow to hand out a connection, hence the 45s timeout. This is also
why `config/production.yaml` must define `kafka.ssl` even though the value is
overridden from the environment — node-config **throws** on `get()` of an
undefined key, so the key has to exist.

The consumer's `groupId` is the `clientId`, `"order-service"`. One group means
every replica shares the partitions rather than each getting a full copy — which
is right for a cache being written to a shared database.

`sendMessage(topic, message, key)` optionally attaches a key:

```ts
const data: { value: string; key?: string } = { value: message };
if (key) data.key = key;
```

Every caller in this service passes the order id. That pins a single order's
events to one partition, which is what guarantees `ORDER_CREATE` is consumed
before the `ORDER_STATUS_UPDATE` that follows it. catelog-service publishes
without a key and does not get this guarantee.

`consumeMessage` subscribes and dispatches on topic name:

```ts
switch (topic) {
  case "product": await handleProductUpdate(message.value.toString()); return;
  case "topping": await handleToppingUpdate(message.value.toString()); return;
  default: console.log("Doing nothing...");
}
```

There is no try/catch around either call, and neither handler has one around its
`JSON.parse` — see §12.

### `src/common/factories/brokerFactory.ts`

A module-level singleton, same pattern as catelog-service. `orderRouter.ts` and
`paymentRouter.ts` both call it at import time and `server.ts` calls it again;
all three get the same instance, so `connectProducer()` is called once on the
object the routers already hold. Without the singleton the routers would hold
unconnected producers and every publish would throw.

The consequence for tests: because the routers call this **at module load**, the
factory has to be replaced before `src/app` is imported.

---

## 4. The data layer

Six models, in two groups: three that this service owns, and two that are
caches of somebody else's data.

### `orderModel.ts` — the owned record

`cartSchema` stores a **snapshot** of what was ordered: name, image, quantity,
the product's full `priceConfiguration` at the time, and the
`chosenConfiguration` the customer actually picked. Storing the prices as they
were is what makes an order re-renderable a year later after the menu has
changed.

The nesting is worth reading carefully, because §5 depends on it:

```
priceConfiguration            Map of { priceType, availableOptions: Map of Number }
chosenConfiguration
  ├─ priceConfiguration       Map of String   e.g. { Size: "Large", Crust: "Thick" }
  └─ selectedToppings         [ { id, name, price, image } ]
```

So `priceConfiguration` is the menu of what *could* have been chosen and
`chosenConfiguration.priceConfiguration` names which option was taken from each
dimension. The two share key names on purpose.

`customerId` is a real `ObjectId` ref to `Customer`; `tenantId` is a plain
String, because tenants live in auth-service's Postgres and cannot be
referenced. `orderStatus`, `paymentMode` and `paymentStatus` are enum-typed
Strings — note that enum validation does not run on `findOneAndUpdate` (§12).

### `customerModel.ts`

`userId` (auth-service's `sub`), name, email, and an `addresses` array of
`{ text, isDefault }` embedded subdocuments with `{ _id: false }` — they are
value objects, and letting Mongoose stamp an `_id` on each would leak into every
API response.

This record is created lazily by `GET /customer` (§8), not by any registration
flow.

### `couponModel.ts`

`title`, `code`, `validUpto` (a Date), `discount` (a Number, read as a
percentage), and `tenantId` — declared **`Number`**, while every other service in
the platform passes tenant ids around as strings. That single inconsistency is
why `getDiscountPercentage` has to convert explicitly (§5).

```ts
couponSchema.index({ tenantId: 1, code: 1 }, { unique: true });
```

Compound and unique, so a code is unique *within* a restaurant and two
restaurants may both run `SAVE10`.

### `idempotencyModel.ts`

```ts
{ key: String (required), response: Object (required) }
idempotencySchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 48 });
idempotencySchema.index({ key: 1 }, { unique: true });
```

The whole created order is stored under `response`, so a replay can return the
original answer without recomputing anything. The TTL index expires records
after 48 hours — after which a replayed key would create a *second* order, which
is the intended trade: idempotency records should not accumulate forever.

The `todo` above it says "change expireAfterSeconds time to 48 hours"; the value
already is 48 hours, so the comment is stale.

### `productCacheModel.ts` and `toppingCacheModel.ts`

The caches. Two details matter more than they look:

```ts
priceConfiguration: { type: Object, of: priceSchema }
```

`type: Object`, **not** `type: Map` — deliberately unlike catelog-service's own
model. `getItemTotal` reads
`cachedProductPrice.priceConfiguration[key].availableOptions[value]` with plain
property access, which a Mongoose Map would not answer. (`of:` is meaningless
alongside `type: Object` and does nothing here.)

`toppingId` is a String with a unique index, and is compared with `===` against
`topping.id` from the cart — so it has to stay a String on both sides.

Both collections are explicitly named as the third argument to
`mongoose.model(...)`: `productCache` and `toppingCache`, rather than the
pluralised defaults.

---

## 5. The pricing engine

Four private methods on `OrderController`. This is the part of the service worth
reading closely, because a bug here is a wrong bill rather than an error.

### `calculateTotal(cart)`

```ts
const productIds = cart.map((item) => item._id);
const productPricings = await productCacheModel.find({ productId: { $in: productIds } });
```

One query for every product in the cart, then one for every topping across every
line:

```ts
const cartToppingIds = cart.reduce((acc, item) => [
  ...acc, ...item.chosenConfiguration.selectedToppings.map((t) => t.id)
], []);
```

Then a reduce over the cart, multiplying each line by its quantity:

```ts
acc + curr.qty * this.getItemTotal(curr, cachedProductPrice, toppingPricings)
```

Two `todo`s sit here acknowledging the same gap: nothing handles a cache
**miss**. Both are live defects (§12).

### `getItemTotal(item, cachedProductPrice, toppingsPricings)`

```ts
const productTotal = Object.entries(item.chosenConfiguration.priceConfiguration)
  .reduce((acc, [key, value]) => {
    const price = cachedProductPrice.priceConfiguration[key].availableOptions[value];
    return acc + price;
  }, 0);
return productTotal + toppingsTotal;
```

The double indirection is the whole idea: the *client* says `Size: "Large"`, and
the price of "Large" is looked up in the *cache*. Nothing the client sends about
money is used.

Note that `priceType` is never read. `base` and `aditional` options are simply
added together, so the distinction that catelog-service models carefully has no
effect on the arithmetic here — it only drives how the storefront renders the
configurator.

### `getCurrentToppingPrice(topping, toppingPricings)`

```ts
const currentTopping = toppingPricings.find((c) => topping.id === c.toppingId);
if (!currentTopping) {
  return topping.price;   // <- the client's number
}
return currentTopping.price;
```

The one place the client's price *is* trusted, and it carries a `todo` saying so.
A topping absent from the cache is billed at whatever the request claims (§12).

### `getDiscountPercentage(couponCode, tenantId)`

```ts
const code = await couponModel.findOne({ code: couponCode, tenantId: Number(tenantId) });
if (!code) return 0;
return new Date() <= new Date(code.validUpto) ? code.discount : 0;
```

The `Number(tenantId)` conversion is the string/number mismatch from §4 made
explicit. Both an unknown code and an expired one return 0, so an invalid coupon
silently produces no discount rather than an error — deliberate, since the
client is expected to have validated it through `POST /coupons/verify` first.

### Putting it together, in `create`

```ts
const totalPrice        = await this.calculateTotal(cart);
const discountAmount    = Math.round((totalPrice * discountPercentage) / 100);
const priceAfterDiscount = totalPrice - discountAmount;
const TAXES_PERCENT     = 18;
const taxes             = Math.round((priceAfterDiscount * TAXES_PERCENT) / 100);
const DELIVERY_CHARGES  = 100;
const finalTotal        = priceAfterDiscount + taxes + DELIVERY_CHARGES;
```

Order of operations, which is what the tests pin down: the discount comes off
first, tax is charged on the discounted price, and delivery is added last and is
never discounted or taxed. Both `Math.round` calls keep every stored amount a
whole rupee. Both constants are hardcoded with `todo`s about moving them per
tenant.

---

## 6. Shared utilities

### `src/utils.ts` — `asyncWrapper(handler)`

```ts
Promise.resolve(requestHandler(req, res, next)).catch((err) => {
  if (err instanceof Error) return next(createHttpError(500, err.message));
  return next(createHttpError(500, "Internal server error"));
});
```

Identical to catelog-service's, and carries the same two behaviours:

- It **flattens the status**. An error thrown with a meaningful status arrives at
  `globalErrorHandler` as a 500. Every controller here sidesteps that by calling
  `next(createHttpError(...))` directly rather than throwing, which skips the
  wrapper — which is why it has never surfaced.
- It does **not** catch synchronous throws. `Promise.resolve(fn())` only wraps
  the return value. Express 5 catches them downstream.

It also means every unhandled Mongoose error — a CastError from a malformed id, a
ValidationError from a missing field, a duplicate-key error — becomes a 500
carrying the raw driver message. Since there are no validators in this service,
that is the normal path for bad input, not an edge case.

---

## 7. Middlewares

There are only two.

### `authenticate` — is this a valid access token?

`express-jwt` configured with `jwks-rsa`:

```ts
secret: jwksClient.expressJwtSecret({ jwksUri: config.get("auth.jwksUri"), cache: true, rateLimit: true }),
algorithms: ["RS256"],
```

`algorithms: ["RS256"]` is a security control, not a hint — without it a forged
token with `alg: none`, or a symmetric `HS256` token signed with the *public*
key, would be accepted. `cache: true` fetches the signing key once rather than
per request.

`getToken` prefers the `Authorization: Bearer` header and falls back to the
cookie. The odd-looking guard:

```ts
if (authHeader && authHeader.split(" ")[1] !== "undefined") { ... }
```

checks for the literal **string** `"undefined"` — the result of a client doing
`` `Bearer ${someUndefinedVar}` ``. Without it, that string would be treated as a
token, fail verification, and 401 even though a valid cookie was also present.

### `globalErrorHandler`

Mounted last. Assigns a uuid reference id, logs the full stack with the request
path and method, and responds:

```jsonc
{ "errors": [{ "ref": "<uuid>", "type": err.name, "msg": "...", "path": req.path,
               "location": "server", "stack": "..." }] }
```

`err.status || 500`, and in production both the message and the stack are
suppressed. The `ref` uuid is the bridge: the client sees an opaque id and the
log carries the same id next to the real error.

Suppressing the message matters more here than elsewhere, because so many errors
in this service are raw Mongoose messages naming collections and fields. The
cost is that a client is told "An unexpected error occurred." when its coupon
code was simply wrong. auth-service echoes the message for a 400 and masks
everything else; this service and catelog-service mask every status.

### There is no `canAccess`

Role checks live in the controllers, and only in `OrderController`. Every other
route in the service is open to any authenticated user regardless of role.

---

## 8. Routes, one by one

### `/orders`

`orderRouter.ts` wires a `StripeGW` and the singleton broker into
`OrderController`. Every route is `authenticate` + `asyncWrapper`; there is no
role middleware and no validator on any of them.

#### `POST /orders` → `OrderController.create`

The longest handler in the platform. In order:

1. Destructure `{ cart, couponCode, tenantId, paymentMode, customerId, comment, address }`.
   Nothing is validated — the `todo` is on the next line.
2. `calculateTotal(cart)` → coupon → tax → delivery (§5).
3. Read the idempotency key from the header:

```ts
const rawIdempotencyKey = req.headers["idempotency-key"];
const idempotencyKey = Array.isArray(rawIdempotencyKey) ? rawIdempotencyKey[0] : rawIdempotencyKey;
```

   Express types headers as `string | string[] | undefined`; the schema keys on a
   String, so a repeated header is collapsed to its first value rather than
   letting an array reach the query.

4. If a record for that key exists, reuse the stored response and skip the
   write entirely.
5. Otherwise, **in a transaction**, create the order and the idempotency record
   together:

```ts
const session = await mongoose.startSession();
await session.startTransaction();
try {
  newOrder = await orderModel.create([{ ... }], { session });
  await idempotencyModel.create([{ key: idempotencyKey, response: newOrder[0] }], { session });
  await session.commitTransaction();
} catch (err) {
  await session.abortTransaction();
  ...
} finally { await session.endSession(); }
```

   This is the only transaction in the platform, and it is the reason the test
   suite needs a replica set rather than a standalone mongod. The invariant it
   protects: an order must never exist without its idempotency record, or a
   client retry would place a duplicate.

6. Load the customer, build the broker message, and branch on payment mode. For
   `card`, open a Stripe session and return its URL; for `cash`, return
   `{ paymentUrl: null }`. Both publish `ORDER_CREATE` first.

The order is created as `RECEIVED` / `PENDING` regardless of payment mode — a
card order is not marked paid until the webhook says so.

**This handler is currently broken for every fresh order.** See §12.

#### `GET /orders` → `getAll`

The restaurant dashboard. Branches on role:

- `customer` → 403.
- `admin` → every order, optionally filtered by a `tenantId` query param.
- `manager` → orders for `req.auth.tenant` only. The tenant comes from the
  **token**, so a manager cannot widen it with a query param.
- anything else → 403.

Sorted `createdAt: -1`, `.populate("customerId")` so the dashboard can render
names without a second call, and unpaginated — with a
`todo: VERY IMPORTANT. add pagination.` on it.

#### `GET /orders/mine` → `getMine`

The customer's own history. Resolves the customer record from `req.auth.sub`
(never from the request), 400s if there is no such record, and returns their
orders with `{ cart: 0 }` — the list view needs totals and status, and carts are
large.

It never checks the role, so any authenticated user with a customer record can
call it.

#### `GET /orders/:orderId` → `getSingle`

Supports a sparse projection for polling:

```ts
const fields = req.query.fields ? req.query.fields.toString().split(",") : [];
const projection = fields.reduce((acc, field) => { acc[field] = 1; return acc; }, { customerId: 1 });
```

`customerId` is seeded unconditionally because the ownership check below
dereferences the populated customer. The intended use is
`?fields=orderStatus,paymentStatus` from the order-tracking screen.

Then 400 if not found, and an ownership check: admin sees anything, a manager
sees their own tenant's, a customer sees their own order, everything else 403s.

**Both the default projection and the manager branch are broken.** See §12.

#### `PATCH /orders/change-status/:orderId` → `changeStatus`

Fetch, 400 if missing, refuse a manager from another tenant, `findOneAndUpdate`
with `{ new: true }`, load the customer, publish `ORDER_STATUS_UPDATE`, return
`{ _id }`.

**The role gate does not work.** See §12.

### `/customer`

#### `GET /customer` → `getCustomer`

This endpoint doubles as registration. It looks the customer up by
`req.auth.sub` and, if there is none, creates one from the token's claims:

```ts
const { sub: userId, firstName, lastName, email } = req.auth;
```

There is no request body — the identity comes entirely from the token. The
`todo: add these fields to jwt in auth service` above it is load-bearing: those
three claims are not currently issued, and the schema marks all three required
(§12).

#### `PATCH /customer/addresses/:id` → `addAddress`

```ts
customerModel.findOneAndUpdate(
  { _id: req.params.id, userId },
  { $push: { addresses: { text: req.body.address, isDefault: false } } },
  { new: true },
);
```

Scoped by `{ _id, userId }` together, so knowing another customer's id is not
enough — the token's subject has to match. `$push` rather than `$set`, so a
second address does not replace the first. `isDefault` is hardcoded false and
nothing ever sets it true.

### `/coupons`

Both routes are `authenticate` + `asyncWrapper` and nothing else.

#### `POST /coupons` → `create`

Creates the coupon from the body and returns the whole document. Two `todo`s
here: `add request validation` and `check if creator is admin or a manger of
that restaurant`. Neither is done (§12).

#### `POST /coupons/verify` → `verify`

Looks the code up scoped by tenant, 400s if unknown, and otherwise returns
`{ valid, discount }` based on the expiry date. Note the asymmetry a client has
to handle: an **unknown** code is a 400, an **expired** one is a 200 with
`valid: false`.

This is advisory only. The authoritative discount is recomputed server-side by
`getDiscountPercentage` during `POST /orders`, so a client that skips
verification cannot get a discount it is not entitled to.

### `/payments`

#### `POST /payments/webhook` → `handleWebhook`

The only unauthenticated route in the service, necessarily — Stripe cannot
present a user token. See §9.

---

## 9. Payments

### `src/payment/stripe.ts` — `StripeGW`

Implements `PaymentGW`, so `OrderController` and `PaymentController` depend on
the interface rather than on Stripe.

```ts
const toGatewayPaymentStatus = (status: string): GatewayPaymentStatus => {
  if (status === "paid" || status === "unpaid" || status === "no_payment_required") return status;
  throw new Error(`Unexpected Stripe payment_status: ${status}`);
};
```

Stripe's SDK types `payment_status` as the three documented values *plus* an
open-ended string, so new API values do not break compilation. This narrows it
at the gateway boundary so an unrecognised status fails loudly instead of
flowing into order state as something that is neither PAID nor FAILED.

`createSession(options)`:

- `unit_amount: options.amount * 100` — Stripe bills in paise and every total in
  this service is in rupees. Getting this wrong is a factor-of-100 error.
- `metadata: { orderId, restaurantId }` — the only thing that lets the webhook
  find the order later, since the webhook body never names one.
- `success_url` / `cancel_url` both point at the client UI's `/payment` route
  carrying `success`, `orderId` and `restaurantId`.
- `{ idempotencyKey: options.idempotenencyKey }` as the **second** argument, not
  part of the body. This is Stripe's own deduplication, and it is what stops a
  retried checkout opening a second payment session. (The misspelling
  `idempotenencyKey` is in `PaymentOptions` and is load-bearing.)

`getSession(id)` retrieves and narrows the same way.

### `src/payment/paymentController.ts` — `handleWebhook`

```ts
if (webhookBody.type === "checkout.session.completed") {
  const verifiedSession = await this.paymentGw.getSession(webhookBody.data.object.id);
  const isPaymentSuccess = verifiedSession.paymentStatus === "paid";
  ...
}
return res.json({ success: true });
```

The important design decision: **the outcome is re-read from Stripe**, not taken
from the request body. The endpoint is unauthenticated and anyone can POST to
it, so the body is treated as nothing more than a hint about which session to go
and ask about.

Everything else acknowledges with a 200 and does nothing — Stripe retries
anything that is not a 2xx, so an unrecognised event type must still be
acknowledged.

Then the order's `paymentStatus` is set to PAID or FAILED and a
`PAYMENT_STATUS_UPDATE` is published. The `orderStatus` is untouched: payment
and fulfilment are tracked separately, and a paid order is still `received`
until the restaurant confirms it.

**The signature is never verified.** See §12.

---

## 10. The Kafka contract

order-service is the only service that both consumes and produces.

### Consumed

| Topic | Handler | Effect |
| --- | --- | --- |
| `product` | `handleProductUpdate` | upsert `productCache` by `productId`, `$set` the whole `priceConfiguration` |
| `topping` | `handleToppingUpdate` | upsert `toppingCache` by `toppingId`, `$set` `price` and `tenantId` |

Both are one-liner upserts, and the upsert is what makes CREATE and UPDATE the
same code path — the handler never has to know which it is. `$set` on the
top-level field means a replace rather than a merge, so a pricing dimension
removed in catelog-service disappears here too rather than lingering.

Both carry `todo: wrap this parsing in try catch`, and neither does (§12).

### Produced — all to the `order` topic, keyed by order id

| Event | Emitted by |
| --- | --- |
| `ORDER_CREATE` | `OrderController.create` |
| `ORDER_STATUS_UPDATE` | `OrderController.changeStatus` |
| `PAYMENT_STATUS_UPDATE` | `PaymentController.handleWebhook` |

All three share a shape:

```jsonc
{ "event_type": "...", "data": { ...the whole order..., "customerId": { ...the whole customer... } } }
```

`customerId` is **replaced** by the populated customer rather than left as an
id. notification-service needs the email address to send anything and has no way
to look the customer up, so it is embedded.

Two of the three build `data` with `.toObject()`. `create` spreads the Mongoose
document instead, and that is the defect at the top of §12.

---

## 11. Configuration

`node-config` with YAML, layered `{NODE_ENV}.yaml` →
`custom-environment-variables.yaml`.

| Key | Env var | Notes |
| --- | --- | --- |
| `server.port` | `PORT` | 5503 |
| `database.url` | `DB_URL` | |
| `kafka.broker` | `KAFKA_BROKER` | `__format: "json"` — the env var must be a JSON array |
| `kafka.sasl.username` / `.password` | `KAFKA_SASL_*` | production only |
| `kafka.ssl` | — | not overridable; must exist in `production.yaml` or `get()` throws |
| `frontend.clientUI` / `.adminUI` | `CLIENT_UI_DOMAIN` / `ADMIN_UI_DOMAIN` | the CORS allowlist, and the Stripe return URLs |
| `auth.jwksUri` | `JWKS_URI` | auth-service's `/.well-known/jwks.json` |
| `stripe.secretKey` | `STRIPE_SECRET_KEY` | |

**There is no `default.yaml`.** Unlike catelog-service, every environment file
here has to be complete on its own — a key present in `development.yaml` but
forgotten in `production.yaml` is not inherited, it throws on first `get()`.

**The `config` version is pinned to exactly `4.4.2` on purpose.** `config@5` ships an
ESM-only implementation behind a CJS entry that `require`s a `.mjs` file; it
cannot be loaded by Jest's CommonJS runtime at all. v4.4.2 is the last
CJS-native release and has the same API. ws-service and notification-service are
still on `config@5` and carry the same exposure.

Note also `tsconfig.json` has `"strict": false`, which is why `err.message` on an
`unknown` catch variable and several implicit `any`s compile here but would not
in auth-service.

---

## 12. Known issues

Each of these is captured by a test that asserts the *current* behaviour, with a
comment naming the fix. None has been silently corrected — changing any of them
changes runtime behaviour.

### The one to fix first

**Every first attempt at `POST /orders` returns 500.** The controller builds the
Kafka payload as `data: { ...newOrder[0], customerId: customer }`. `newOrder[0]`
is a Mongoose document, and spreading one copies its internal `$__` cache rather
than its fields. Inside a transaction `$__.session` holds the live
`ClientSession`, so `JSON.stringify` walks session → MongoClient → sessionPool →
client and throws *"Converting circular structure to JSON"*.

The order **and** its idempotency record are already committed by then, and no
`ORDER_CREATE` is published. So the customer is told their order failed, the
order exists, and notification-service never hears about it. What has masked
this in practice is the retry: replaying the same idempotency key reads the
order back from `idempotency.response` as a plain object, which serializes fine
and returns 200.

The fix is the `.toObject()` call that `changeStatus` and `handleWebhook`
already use. (This is not a regression from the mongoose 8 → 9 upgrade — 8.3.4
spreads a document identically.)

### Authorization

**Any authenticated user can change any order's status.** The gate in
`changeStatus` reads:

```ts
if (role === ROLES.MANAGER || ROLES.ADMIN) {
```

The second operand is the *string* `"admin"`, not a comparison, so the condition
is always truthy and the body runs for every role. The only rejection inside it
is scoped to managers, so a customer passes straight through and can mark any
restaurant's order delivered — and the bogus transition is broadcast, so the
real customer is emailed about it. The `return next(403)` at the bottom of the
handler is unreachable. Fix: `|| role === ROLES.ADMIN`.

**Any authenticated user can mint a coupon for any tenant.** No role check on
`POST /coupons`, and the controller's own `todo` says so. A customer can create
a 100%-off code for any restaurant and spend it immediately.

**`POST /orders` trusts `customerId` from the body.** It is never checked
against `req.auth.sub`, so an authenticated user can file an order under someone
else's customer record — and that customer receives the confirmation email.

### `GET /orders/:orderId`

**A plain request returns almost nothing.** `fields` defaults to `[]`, so the
projection reduces to `{ customerId: 1 }` — an *inclusion* projection naming one
field. The response carries only `_id` and the populated customer: no total, no
status, no cart.

**And a manager can never read their own tenant's order.** The ownership check
reads `order.tenantId`, which that same projection excluded, so it compares
`undefined` against the token's tenant and 403s. The only way through is
`?fields=tenantId`. Defaulting the projection to `{}` when `fields` is empty
fixes both.

**A dangling customer reference 500s it.** `populate` yields null and the
customer branch then reads `order.customerId._id`.

### Validation

There are no validators anywhere in this service, so bad input reaches Mongoose
and surfaces through `asyncWrapper` as a 500 carrying a raw driver message. The
cases the tests pin down:

- `POST /orders` with no `Idempotency-Key` header → 500. The transaction does
  roll back correctly, so nothing is half-written, but the client is told
  nothing useful.
- `POST /orders` with no cart, a missing address, or a chosen option that does
  not exist in the cache → 500.
- `POST /coupons` missing a field, or `POST /coupons/verify` with a non-numeric
  `tenantId` → 500.
- Any malformed ObjectId on `/orders/:orderId`, `/orders/change-status/:orderId`
  or `/customer/addresses/:id` → CastError → 500 instead of 400.
- `changeStatus` with a status outside the enum → **stored anyway and
  broadcast**, because `findOneAndUpdate` does not run validators without
  `runValidators: true`.
- `changeStatus` with no status at all → 200, no change, and a spurious
  `ORDER_STATUS_UPDATE` announcing a change that never happened.
- `PATCH /customer/addresses/:id` with no address → appends a textless entry to
  the address book and returns 200.
- `PATCH /customer/addresses/:id` for someone else's record → `200 null` rather
  than a 403 or 404, because `findOneAndUpdate` returns null and the controller
  sends it on unchecked.

### Pricing

**A topping missing from the cache is billed at the client's price.** The
fallback in `getCurrentToppingPrice` carries its own `todo`. A crafted request
can order toppings for nothing during the window before a `TOPPING_CREATE` is
consumed.

**A product missing from the cache 500s the order.** `getItemTotal`
dereferences `undefined.priceConfiguration`. The order is simply unplaceable
until the consumer catches up, with no explanation.

**A `PRODUCT_DELETE` caches an empty configuration instead of removing the
row.** The handler upserts whatever `data.priceConfiguration` it is given, so a
delete leaves a row that prices nothing — indistinguishable at order time from
the product never having been cached.

### Payments

**The Stripe signature is never verified.** The handler does not check the
`Stripe-Signature` header against the webhook signing secret, so anyone reaching
the endpoint can post a `checkout.session.completed` for a session id of their
choosing. What limits the damage is that the outcome is re-read from Stripe — an
attacker cannot mark an unpaid order paid, only replay a genuinely paid session.
That is a mitigation, not a substitute. The fix is
`stripe.webhooks.constructEvent`, which needs the **raw** body — so it also needs
`express.raw()` mounted on this route ahead of the global `express.json()`.

**An unknown order id in the metadata 500s.** `findOneAndUpdate` returns null
and the next line reads `updatedOrder.customerId`. Stripe sees a 500 and retries
on backoff indefinitely. A null check that acknowledges with a 200 and logs
would stop that.

**There is no replay guard.** Stripe delivers webhooks at least once, and
reprocessing publishes a second `PAYMENT_STATUS_UPDATE`, so notification-service
tells the customer twice. The order itself is written idempotently.

**`no_payment_required` is recorded as FAILED.** Only the literal `"paid"`
counts, so a zero-value checkout — a 100% coupon — marks the order failed.

**`paymentId` is never set.** A `todo: Update order document -> paymentId ->
sessionId` sits in `create`, so an order cannot be traced back to its Stripe
session for a refund or a dispute.

### Messaging and operations

**A malformed message stalls the partition.** Neither cache handler wraps its
`JSON.parse`, and `eachMessage` does not catch either — so kafkajs retries the
same offset indefinitely and every later price update stops arriving. Both
handlers carry `todo: wrap this parsing in try catch`.

**Idempotency does not cover the publish.** The guard wraps only the database
write, so each replay emits another `ORDER_CREATE` for the same order.

**`console.log` on the consumer hot path.** Every product and topping event is
logged with `console.log` rather than the winston logger, so those lines carry no
service name, level or timestamp, and are not silenced in tests.

**`GET /orders` is unpaginated** for both admins and managers, with its own
`todo: VERY IMPORTANT`. `getMine` and `ToppingService`-style topping lookups are
the same.

**`GET /customer` requires claims auth-service does not issue.** The controller
reads `firstName`, `lastName` and `email` from the token and the schema marks all
three required — so against a real token today, the first call for a new
customer fails validation and 500s. Either auth-service adds the claims or this
endpoint stops requiring them.

---

## 13. Where the tests live

218 tests across 12 suites. `jest --runInBand`, because every spec shares one
database.

```
tests/globalSetup.ts                 starts one in-memory MongoDB replica set
tests/globalTeardown.ts              stops it
tests/app.spec.ts                    health check, 404s, malformed JSON, CORS
tests/order/create.spec.ts           pricing, coupons, idempotency, card vs cash, events
tests/order/read.spec.ts             GET /orders, /orders/mine, /orders/:orderId
tests/order/change-status.spec.ts    transitions, role gating, published events
tests/customer/customer.spec.ts      lazy creation, address book, scoping
tests/coupon/coupon.spec.ts          creation, uniqueness, verification, expiry
tests/payment/webhook.spec.ts        the Stripe webhook end to end
tests/payment/stripe-gateway.spec.ts what StripeGW asks the Stripe SDK to do
tests/cache/handlers.spec.ts         the two Kafka consumer callbacks
tests/common/kafka.spec.ts           KafkaBroker: keys, routing, ssl branch
tests/common/wrapper.spec.ts         asyncWrapper, including what it does not catch
tests/common/global-error-handler.spec.ts  envelope, ref ids, production masking
tests/mocks/broker.ts                replaces the broker factory; records publishes
tests/mocks/stripe.ts                replaces StripeGW; records sessions
tests/utils/db.ts                    connect / clear / disconnect / syncIndexes
tests/utils/fixtures.ts              cart, cache, coupon, customer and order builders
```

Four harness details that are not obvious:

**The database has to be a replica set.** `OrderController.create` runs a
transaction, and MongoDB rejects transactions on a standalone server with
*"Transaction numbers are only allowed on a replica set member or mongos"* — so
the mongod on `localhost:27017` cannot exercise the most important path in the
service. `globalSetup` starts a single-node `MongoMemoryReplSet` for the whole
run instead, which also means the suite needs no local MongoDB at all.

**Mocks must be registered before `src/app` is imported.** The routers construct
a `StripeGW` and call `createMessageBroker()` at module load, so both
`jest.mock` calls sit above the `import app` line. The factory form
`() => require("../mocks/broker")` is used rather than referencing a top-level
import, because `jest.mock` is hoisted above `const` declarations and would hit a
temporal-dead-zone error.

**`mock-jwks` stands up a fake JWKS endpoint** at `http://localhost:5501` — the
same URL `config.get("auth.jwksUri")` points at in `test.yaml` — so specs can
mint access tokens that `authenticate` genuinely verifies. Nothing is stubbed
out of the auth path.

**`config/test.yaml` declares `kafka.ssl` and `kafka.sasl`** even though nothing
in the test environment uses them. Without those keys the production branch of
`KafkaBroker`'s constructor cannot be entered at all, because node-config throws
on `get()` of an undefined key.
