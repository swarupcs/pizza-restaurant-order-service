import request from "supertest";
import mongoose from "mongoose";
import createJWKSMock from "mock-jwks";

jest.mock("../../src/common/factories/brokerFactory", () =>
  require("../mocks/broker"),
);
jest.mock("../../src/payment/stripe", () => require("../mocks/stripe"));

import app from "../../src/app";
import orderModel from "../../src/order/orderModel";
import idempotencyModel from "../../src/idempotency/idempotencyModel";
import productCacheModel from "../../src/productCache/productCacheModel";
import toppingCacheModel from "../../src/toppingCache/toppingCacheModel";
import couponModel from "../../src/coupon/couponModel";
import customerModel from "../../src/customer/customerModel";
import {
  PaymentMode,
  PaymentStatus,
  OrderStatus,
} from "../../src/order/orderTypes";
import { ROLES } from "../../src/types";
import { clearDb, connectDb, disconnectDb } from "../utils/db";
import {
  cartItem,
  cartItemWithoutToppings,
  couponDoc,
  customerDoc,
  orderPayload,
  productCacheDoc,
  toppingCacheDoc,
  TOPPING_ID,
} from "../utils/fixtures";
import {
  publishedMessage,
  resetBrokerMocks,
  sendMessage,
} from "../mocks/broker";
import { createSession, resetStripeMocks } from "../mocks/stripe";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Read this before the assertions below look wrong.
 *
 * A *first* POST /orders currently returns 500, every time, for every order.
 * The order and its idempotency record are committed to the database first,
 * and then the controller builds the Kafka payload:
 *
 *     data: { ...newOrder[0], customerId: customer }
 *
 * `newOrder[0]` is a Mongoose document, and spreading one copies its internal
 * `$__` cache rather than its fields. Inside a transaction `$__.session` holds
 * the live ClientSession, so `JSON.stringify` walks
 * session -> MongoClient -> sessionPool -> client and throws
 * "Converting circular structure to JSON". asyncWrapper turns that into a 500.
 *
 * `changeStatus` builds the same message correctly with `.toObject()`; the
 * same call here is the whole fix.
 *
 * The practical consequence is that the client retries with the same
 * idempotency key, and the *replay* path succeeds — it reads the order back
 * from the idempotency record as a plain object, which serializes fine. So the
 * only path that currently returns a success response is the retry.
 *
 * The specs are split to match: "Fresh order" captures the broken first
 * attempt, and everything about responses, Stripe and events is asserted on
 * the replay. When the `.toObject()` fix lands, the "Fresh order" block is
 * what changes.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe("POST /orders", () => {
  let jwks: ReturnType<typeof createJWKSMock>;
  let customerToken: string;
  let customerId: string;

  beforeAll(async () => {
    jwks = createJWKSMock("http://localhost:5501");
    await connectDb();
  });

  beforeEach(async () => {
    jwks.start();
    await clearDb();
    resetBrokerMocks();
    resetStripeMocks();

    customerToken = jwks.token({ sub: "1", role: ROLES.CUSTOMER });

    // Pricing comes from these caches, never from the request body.
    await productCacheModel.create(productCacheDoc());
    await toppingCacheModel.create(toppingCacheDoc());

    const customer = await customerModel.create(customerDoc());
    customerId = customer._id.toString();
  });

  afterEach(() => {
    jwks.stop();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  const postOrder = (
    token: string,
    body: Record<string, unknown> = {},
    idempotencyKey = new mongoose.Types.ObjectId().toString(),
  ) =>
    request(app)
      .post("/orders")
      .set("Cookie", [`accessToken=${token}`])
      .set("Idempotency-Key", idempotencyKey)
      .send(orderPayload({ customerId, ...body }));

  /**
   * Places an order the way a real client ends up having to: the first attempt
   * 500s after committing, the retry with the same key returns the response.
   * Returns the retry's response.
   */
  const placeOrder = async (
    token: string,
    body: Record<string, unknown> = {},
    idempotencyKey = new mongoose.Types.ObjectId().toString(),
  ) => {
    await postOrder(token, body, idempotencyKey);
    return postOrder(token, body, idempotencyKey);
  };

  describe("Fresh order", () => {
    it("should return 500 on the first attempt", async () => {
      // BUG, captured rather than asserted as correct. See the block comment
      // at the top of this file. With the `.toObject()` fix this becomes 200.
      const response = await postOrder(customerToken);

      expect(response.statusCode).toBe(500);
    });

    it("should nonetheless have committed the order", async () => {
      // The transaction commits before the publish is attempted, so the 500 is
      // reported to a client whose order was in fact accepted.
      await postOrder(customerToken);

      expect(await orderModel.countDocuments()).toBe(1);
      expect(await idempotencyModel.countDocuments()).toBe(1);
    });

    it("should not publish anything on the failed attempt", async () => {
      // The order exists but no ORDER_CREATE is emitted, so
      // notification-service never learns about it and the customer gets no
      // confirmation until the client happens to retry.
      await postOrder(customerToken);

      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("should fail with a circular-structure error, not a database error", async () => {
      // Pinning the cause down, so this test starts failing for the right
      // reason if someone changes the payload without fixing the spread.
      const response = await postOrder(customerToken);
      const body = response.body as { errors: { msg: string }[] };

      expect(body.errors[0].msg).toContain("Converting circular structure");
    });
  });

  describe("Given a valid cash order", () => {
    it("should return the 200 status code", async () => {
      const response = await placeOrder(customerToken);

      expect(response.statusCode).toBe(200);
    });

    it("should return a null paymentUrl for a cash order", async () => {
      // The client reads this to decide whether to redirect to Stripe.
      const response = await placeOrder(customerToken);

      expect(response.body as { paymentUrl: null }).toEqual({
        paymentUrl: null,
      });
    });

    it("should not open a Stripe session for a cash order", async () => {
      await placeOrder(customerToken);

      expect(createSession).not.toHaveBeenCalled();
    });

    it("should persist exactly one order", async () => {
      await placeOrder(customerToken);

      const orders = await orderModel.find();

      expect(orders).toHaveLength(1);
      expect(orders[0].tenantId).toBe("1");
      expect(orders[0].address).toBe("12 Park Street, Kolkata");
    });

    it("should start the order as received and unpaid", async () => {
      await placeOrder(customerToken);

      const order = await orderModel.findOne();

      expect(order!.orderStatus).toBe(OrderStatus.RECEIVED);
      expect(order!.paymentStatus).toBe(PaymentStatus.PENDING);
    });

    it("should store the cart as sent", async () => {
      await placeOrder(customerToken);

      const order = await orderModel.findOne();

      expect(order!.cart).toHaveLength(1);
      expect(order!.cart[0].name).toBe("Margherita");
      expect(order!.cart[0].qty).toBe(1);
    });

    it("should store the comment", async () => {
      await placeOrder(customerToken);

      expect((await orderModel.findOne())!.comment).toBe("Ring the bell twice");
    });
  });

  describe("Pricing", () => {
    // Pricing is asserted against the persisted document, so these do not need
    // the retry — the order is committed either way.
    it("should price the item from the product cache", async () => {
      // Size "Large" 800 + Crust "Thick" 50 + Cheese topping 50 = 900,
      // then 18% tax (162) and 100 delivery.
      await postOrder(customerToken);

      const order = await orderModel.findOne();

      expect(order!.taxes).toBe(162);
      expect(order!.deliveryCharges).toBe(100);
      expect(order!.total).toBe(1162);
    });

    it("should ignore the prices carried in the request body", async () => {
      // The cart the client sends carries its own priceConfiguration. A client
      // that rewrites it must not change what is charged — this is the whole
      // reason the local price cache exists.
      const tampered = cartItem({
        priceConfiguration: {
          Size: {
            priceType: "base",
            availableOptions: { Small: 1, Medium: 1, Large: 1 },
          },
          Crust: {
            priceType: "aditional",
            availableOptions: { Thin: 0, Thick: 0 },
          },
        },
      } as never);

      await postOrder(customerToken, { cart: [tampered] });

      expect((await orderModel.findOne())!.total).toBe(1162);
    });

    it("should multiply by quantity", async () => {
      // 900 x 2 = 1800, tax 324, delivery 100.
      await postOrder(customerToken, { cart: [cartItem({ qty: 2 })] });

      expect((await orderModel.findOne())!.total).toBe(2224);
    });

    it("should sum every line in the cart", async () => {
      await postOrder(customerToken, {
        cart: [cartItem(), cartItemWithoutToppings()],
      });

      // 900 + 850 = 1750, tax 315, delivery 100.
      expect((await orderModel.findOne())!.total).toBe(2165);
    });

    it("should add base and additional options together", async () => {
      // Size Small 400 + Crust Thin 0, no toppings = 400.
      await postOrder(customerToken, {
        cart: [
          cartItemWithoutToppings({
            chosenConfiguration: {
              priceConfiguration: { Size: "Small", Crust: "Thin" },
              selectedToppings: [],
            },
          } as never),
        ],
      });

      expect((await orderModel.findOne())!.total).toBe(400 + 72 + 100);
    });

    it("should price toppings from the topping cache", async () => {
      await toppingCacheModel.updateOne(
        { toppingId: TOPPING_ID },
        { $set: { price: 80 } },
      );

      // 800 + 50 + 80 = 930, tax 167, delivery 100.
      await postOrder(customerToken);

      expect((await orderModel.findOne())!.total).toBe(930 + 167 + 100);
    });

    it("should fall back to the cart price for a topping missing from the cache", async () => {
      // BUG, captured rather than asserted as correct. `getCurrentToppingPrice`
      // carries a todo about exactly this. It is a trust-the-client hole: a
      // topping absent from the cache is billed at whatever price the request
      // claims, so a crafted request can order toppings for nothing.
      await toppingCacheModel.deleteMany({});

      await postOrder(customerToken, {
        cart: [
          cartItem({
            chosenConfiguration: {
              priceConfiguration: { Size: "Large", Crust: "Thick" },
              selectedToppings: [
                {
                  id: TOPPING_ID,
                  name: "Cheese",
                  price: 1,
                  image: "https://cdn.test/cheese.png",
                },
              ],
            },
          } as never),
        ],
      });

      // 800 + 50 + 1 (the client's number) = 851.
      expect((await orderModel.findOne())!.total).toBe(851 + 153 + 100);
    });

    it("should keep every stored amount a whole number", async () => {
      // Tax is rounded rather than truncated, so no fractional currency
      // reaches the database or the Stripe amount.
      await postOrder(customerToken, {
        cart: [cartItem(), cartItemWithoutToppings()],
      });

      const order = await orderModel.findOne();

      expect(Number.isInteger(order!.taxes)).toBe(true);
      expect(Number.isInteger(order!.discount)).toBe(true);
      expect(Number.isInteger(order!.total)).toBe(true);
    });
  });

  describe("Coupons", () => {
    beforeEach(async () => {
      await couponModel.create(couponDoc());
    });

    it("should apply a valid coupon", async () => {
      // 900 - 10% (90) = 810, tax 146, delivery 100.
      await postOrder(customerToken, { couponCode: "SAVE10" });

      const order = await orderModel.findOne();

      expect(order!.discount).toBe(90);
      expect(order!.total).toBe(810 + 146 + 100);
    });

    it("should tax the discounted price, not the original", async () => {
      await postOrder(customerToken, { couponCode: "SAVE10" });

      // 162 would mean the tax was computed before the discount.
      expect((await orderModel.findOne())!.taxes).toBe(146);
    });

    it("should not discount the delivery charge", async () => {
      await postOrder(customerToken, { couponCode: "SAVE10" });

      expect((await orderModel.findOne())!.deliveryCharges).toBe(100);
    });

    it("should ignore an unknown coupon code", async () => {
      await postOrder(customerToken, { couponCode: "NOPE" });

      const order = await orderModel.findOne();

      expect(order!.discount).toBe(0);
      expect(order!.total).toBe(1162);
    });

    it("should ignore an expired coupon", async () => {
      await couponModel.updateOne(
        { code: "SAVE10" },
        { $set: { validUpto: new Date("2020-01-01") } },
      );

      await postOrder(customerToken, { couponCode: "SAVE10" });

      expect((await orderModel.findOne())!.discount).toBe(0);
    });

    it("should not apply another tenant's coupon", async () => {
      // The lookup is scoped by tenantId, so the same code issued by a
      // different restaurant must not discount this order.
      await postOrder(customerToken, { couponCode: "SAVE10", tenantId: "2" });

      expect((await orderModel.findOne())!.discount).toBe(0);
    });

    it("should match a coupon even though tenantId arrives as a string", async () => {
      // The coupon schema stores tenantId as a Number while the request body
      // carries a string; getDiscountPercentage converts explicitly.
      const coupon = await couponModel.findOne({ code: "SAVE10" });
      expect(typeof coupon!.tenantId).toBe("number");

      await postOrder(customerToken, { couponCode: "SAVE10" });

      expect((await orderModel.findOne())!.discount).toBe(90);
    });
  });

  describe("Card orders", () => {
    it("should return the Stripe checkout url", async () => {
      const response = await placeOrder(customerToken, {
        paymentMode: PaymentMode.CARD,
      });

      expect(response.statusCode).toBe(200);
      expect((response.body as { paymentUrl: string }).paymentUrl).toContain(
        "https://checkout.stripe.test/pay/",
      );
    });

    it("should open the session for the final total in inr", async () => {
      await placeOrder(customerToken, { paymentMode: PaymentMode.CARD });

      const options = createSession.mock.calls[0][0];

      expect(options.amount).toBe(1162);
      expect(options.currency).toBe("inr");
      expect(options.tenantId).toBe("1");
    });

    it("should pass the idempotency key through to Stripe", async () => {
      // Stripe deduplicates on its own key, so the retry the circular-JSON bug
      // forces does not open a second payment session — which is the only
      // reason that bug has not produced double charges.
      const key = new mongoose.Types.ObjectId().toString();

      await placeOrder(customerToken, { paymentMode: PaymentMode.CARD }, key);

      expect(createSession.mock.calls[0][0].idempotenencyKey).toBe(key);
      expect(createSession.mock.calls[1][0].idempotenencyKey).toBe(key);
    });

    it("should link the session to the persisted order", async () => {
      await placeOrder(customerToken, { paymentMode: PaymentMode.CARD });

      const order = await orderModel.findOne();

      expect(createSession.mock.calls[0][0].orderId).toBe(
        order!._id.toString(),
      );
    });

    it("should leave the order pending until the webhook arrives", async () => {
      await placeOrder(customerToken, { paymentMode: PaymentMode.CARD });

      expect((await orderModel.findOne())!.paymentStatus).toBe(
        PaymentStatus.PENDING,
      );
    });

    it("should not record the Stripe session id on the order", async () => {
      // BUG, captured rather than asserted as correct. There is a
      // `todo: Update order document -> paymentId -> sessionId` in the
      // controller. `paymentId` stays null, so an order cannot be traced back
      // to its Stripe session for a refund or a dispute.
      await placeOrder(customerToken, { paymentMode: PaymentMode.CARD });

      expect((await orderModel.findOne())!.paymentId).toBeNull();
    });
  });

  describe("Idempotency", () => {
    it("should record the key alongside the order", async () => {
      const key = new mongoose.Types.ObjectId().toString();

      await postOrder(customerToken, {}, key);

      const records = await idempotencyModel.find();

      expect(records).toHaveLength(1);
      expect(records[0].key).toBe(key);
    });

    it("should not create a second order when the same key is replayed", async () => {
      // The client retrying a timed-out checkout must not be charged twice.
      await placeOrder(customerToken);

      expect(await orderModel.countDocuments()).toBe(1);
      expect(await idempotencyModel.countDocuments()).toBe(1);
    });

    it("should return the same order id on every replay", async () => {
      const key = new mongoose.Types.ObjectId().toString();

      await placeOrder(customerToken, { paymentMode: PaymentMode.CARD }, key);
      const third = await postOrder(
        customerToken,
        { paymentMode: PaymentMode.CARD },
        key,
      );

      const order = await orderModel.findOne();

      expect((third.body as { paymentUrl: string }).paymentUrl).toContain(
        order!._id.toString(),
      );
    });

    it("should create separate orders for different keys", async () => {
      await postOrder(customerToken);
      await postOrder(customerToken);

      expect(await orderModel.countDocuments()).toBe(2);
    });

    it("should publish again on every replay", async () => {
      // BUG, captured rather than asserted as correct. The idempotency guard
      // only covers the database write — the broker publish sits outside it.
      // Each retry emits another ORDER_CREATE for the same order, so
      // notification-service sends a duplicate confirmation.
      const key = new mongoose.Types.ObjectId().toString();

      await placeOrder(customerToken, {}, key);
      await postOrder(customerToken, {}, key);

      // The first attempt threw before publishing; the two replays each
      // published.
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(publishedMessage(0).key).toBe(publishedMessage(1).key);
    });
  });

  describe("The published event", () => {
    it("should publish to the order topic", async () => {
      await placeOrder(customerToken);

      expect(publishedMessage().topic).toBe("order");
    });

    it("should key the message by order id so a single order stays ordered", async () => {
      // Without a key, Kafka round-robins partitions and ORDER_CREATE can be
      // consumed after a later status update for the same order. This is the
      // one publisher in the platform that gets this right — catelog-service
      // publishes without a key.
      await placeOrder(customerToken);

      const order = await orderModel.findOne();

      expect(publishedMessage().key).toBe(order!._id.toString());
    });

    it("should carry the ORDER_CREATE event type", async () => {
      await placeOrder(customerToken);

      expect(publishedMessage().body.event_type).toBe("ORDER_CREATE");
    });

    it("should carry the order fields at the top of data", async () => {
      await placeOrder(customerToken);

      const data = publishedMessage().body.data;

      expect(data.total).toBe(1162);
      expect(data.orderStatus).toBe(OrderStatus.RECEIVED);
      expect(data.tenantId).toBe("1");
    });

    it("should embed the whole customer rather than just the id", async () => {
      // notification-service needs the email address to send anything, and it
      // has no way to look the customer up.
      await placeOrder(customerToken);

      const customer = publishedMessage().body.data.customerId as {
        email: string;
        firstName: string;
      };

      expect(customer.email).toBe("swarup@test.com");
      expect(customer.firstName).toBe("Swarup");
    });
  });

  describe("Access control", () => {
    it("should return 401 if the caller is not authenticated", async () => {
      const response = await request(app)
        .post("/orders")
        .set("Idempotency-Key", new mongoose.Types.ObjectId().toString())
        .send(orderPayload({ customerId }));

      expect(response.statusCode).toBe(401);
      expect(await orderModel.countDocuments()).toBe(0);
    });

    it("should return 401 for a token signed by an unknown key", async () => {
      // The signature is checked against auth-service's published JWKS, so a
      // self-signed token is rejected rather than trusted.
      const response = await request(app)
        .post("/orders")
        .set("Cookie", ["accessToken=not.a.real.token"])
        .set("Idempotency-Key", new mongoose.Types.ObjectId().toString())
        .send(orderPayload({ customerId }));

      expect(response.statusCode).toBe(401);
    });

    it("should accept the token from an Authorization header too", async () => {
      const key = new mongoose.Types.ObjectId().toString();
      const send = () =>
        request(app)
          .post("/orders")
          .set("Authorization", `Bearer ${customerToken}`)
          .set("Idempotency-Key", key)
          .send(orderPayload({ customerId }));

      await send();
      const response = await send();

      expect(response.statusCode).toBe(200);
    });

    it("should let any authenticated role place an order", async () => {
      // There is no canAccess on this route. The storefront is the only
      // intended caller, but nothing enforces that.
      const managerToken = jwks.token({
        sub: "2",
        role: ROLES.MANAGER,
        tenant: "1",
      });

      const response = await placeOrder(managerToken);

      expect(response.statusCode).toBe(200);
    });

    it("should let a caller place an order against any customerId", async () => {
      // BUG, captured rather than asserted as correct. `customerId` is taken
      // from the request body and never checked against `req.auth.sub`, so an
      // authenticated user can file an order under someone else's customer
      // record — and that customer's email receives the confirmation.
      const other = await customerModel.create(
        customerDoc({ userId: "999", email: "victim@test.com" }),
      );

      await placeOrder(customerToken, { customerId: other._id.toString() });

      const customer = publishedMessage().body.data.customerId as {
        email: string;
      };

      expect(customer.email).toBe("victim@test.com");
    });
  });

  describe("Invalid input", () => {
    it("should roll the order back when the idempotency key header is missing", async () => {
      // BUG, captured rather than asserted as correct. There is a
      // `todo: validate request data` at the top of the controller and no
      // validator on the route. With no header the idempotency schema's
      // `required: true` rejects the insert, the transaction aborts, and the
      // client gets a 500 carrying a raw Mongoose validation message. It
      // should be a 400 naming the missing header.
      //
      // The rollback itself is correct and worth pinning: an order must never
      // be persisted without its idempotency record, or a retry would
      // duplicate it.
      const response = await request(app)
        .post("/orders")
        .set("Cookie", [`accessToken=${customerToken}`])
        .send(orderPayload({ customerId }));

      expect(response.statusCode).toBe(500);
      expect(await orderModel.countDocuments()).toBe(0);
      expect(await idempotencyModel.countDocuments()).toBe(0);
    });

    it("should return 500 when a cart product is not in the price cache", async () => {
      // BUG, captured rather than asserted as correct. `calculateTotal` has a
      // todo acknowledging this: the lookup can miss, and `getItemTotal` then
      // dereferences `undefined.priceConfiguration`. The order is simply
      // unplaceable until the Kafka consumer catches up, with a 500 and no
      // explanation.
      await productCacheModel.deleteMany({});

      const response = await postOrder(customerToken);

      expect(response.statusCode).toBe(500);
      expect(await orderModel.countDocuments()).toBe(0);
    });

    it("should return 500 when the cart is missing entirely", async () => {
      // No request validation, so `cart.map` throws on undefined.
      const response = await request(app)
        .post("/orders")
        .set("Cookie", [`accessToken=${customerToken}`])
        .set("Idempotency-Key", new mongoose.Types.ObjectId().toString())
        .send({ tenantId: "1", customerId, address: "somewhere" });

      expect(response.statusCode).toBe(500);
      expect(await orderModel.countDocuments()).toBe(0);
    });

    it("should return 500 when a chosen option does not exist in the cache", async () => {
      // A client sending Size "Family" gets a TypeError rather than a 400.
      const response = await postOrder(customerToken, {
        cart: [
          cartItemWithoutToppings({
            chosenConfiguration: {
              priceConfiguration: { Size: "Family" },
              selectedToppings: [],
            },
          } as never),
        ],
      });

      expect(response.statusCode).toBe(500);
    });

    it("should return 500 when the address is missing", async () => {
      // The schema requires it, so this fails inside the transaction and rolls
      // back — the right outcome reached by the wrong route, since no
      // validator ever looked at the body.
      const response = await postOrder(customerToken, { address: undefined });

      expect(response.statusCode).toBe(500);
      expect(await orderModel.countDocuments()).toBe(0);
    });
  });
});
