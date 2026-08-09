import request from "supertest";
import mongoose from "mongoose";

jest.mock("../../src/common/factories/brokerFactory", () =>
  require("../mocks/broker"),
);
jest.mock("../../src/payment/stripe", () => require("../mocks/stripe"));

import app from "../../src/app";
import orderModel from "../../src/order/orderModel";
import customerModel from "../../src/customer/customerModel";
import { PaymentStatus, PaymentMode } from "../../src/order/orderTypes";
import { clearDb, connectDb, disconnectDb } from "../utils/db";
import { customerDoc, orderDocument } from "../utils/fixtures";
import {
  publishedMessage,
  resetBrokerMocks,
  sendMessage,
} from "../mocks/broker";
import {
  getSession,
  resetStripeMocks,
  stubVerifiedSession,
} from "../mocks/stripe";

describe("POST /payments/webhook", () => {
  let orderId: string;

  beforeAll(async () => {
    await connectDb();
  });

  beforeEach(async () => {
    await clearDb();
    resetBrokerMocks();
    resetStripeMocks();

    const customer = await customerModel.create(customerDoc());
    const order = await orderModel.create(
      orderDocument({
        customerId: customer._id,
        paymentMode: PaymentMode.CARD,
        paymentStatus: PaymentStatus.PENDING,
      }),
    );
    orderId = order._id.toString();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  /** The shape Stripe posts for a completed checkout. */
  const completedEvent = (sessionId = "cs_test_1") => ({
    type: "checkout.session.completed",
    data: { object: { id: sessionId } },
  });

  const postWebhook = (body: Record<string, unknown>) =>
    request(app).post("/payments/webhook").send(body);

  describe("Given a completed checkout session", () => {
    beforeEach(() => {
      stubVerifiedSession(orderId, "paid");
    });

    it("should return 200 with a success body", async () => {
      // Stripe retries anything that is not a 2xx, so this has to acknowledge
      // even when there is nothing to do.
      const response = await postWebhook(completedEvent());

      expect(response.statusCode).toBe(200);
      expect(response.body as { success: boolean }).toEqual({ success: true });
    });

    it("should mark the order paid", async () => {
      await postWebhook(completedEvent());

      expect((await orderModel.findById(orderId))!.paymentStatus).toBe(
        PaymentStatus.PAID,
      );
    });

    it("should re-fetch the session from Stripe rather than trust the body", async () => {
      // The endpoint is unauthenticated and anyone can POST to it, so the
      // payment outcome is read back from Stripe by session id instead of
      // being taken from the request.
      await postWebhook(completedEvent("cs_test_specific"));

      expect(getSession).toHaveBeenCalledWith("cs_test_specific");
    });

    it("should find the order through the session metadata", async () => {
      // The order id travels to Stripe as session metadata when the checkout
      // is created, and comes back the same way — the webhook body never
      // names an order.
      const other = await orderModel.create(
        orderDocument({ customerId: new mongoose.Types.ObjectId() }),
      );
      stubVerifiedSession(other._id.toString(), "paid");

      await postWebhook(completedEvent());

      expect((await orderModel.findById(other._id))!.paymentStatus).toBe(
        PaymentStatus.PAID,
      );
      expect((await orderModel.findById(orderId))!.paymentStatus).toBe(
        PaymentStatus.PENDING,
      );
    });

    it("should mark the order failed when Stripe reports it unpaid", async () => {
      stubVerifiedSession(orderId, "unpaid");

      await postWebhook(completedEvent());

      expect((await orderModel.findById(orderId))!.paymentStatus).toBe(
        PaymentStatus.FAILED,
      );
    });

    it("should treat no_payment_required as a failure", async () => {
      // Only the literal "paid" counts. A zero-value checkout — a 100% coupon
      // — comes back as `no_payment_required` and is recorded as FAILED, which
      // is wrong but is what the code does today.
      stubVerifiedSession(orderId, "no_payment_required");

      await postWebhook(completedEvent());

      expect((await orderModel.findById(orderId))!.paymentStatus).toBe(
        PaymentStatus.FAILED,
      );
    });

    it("should not change the order status", async () => {
      // Payment and fulfilment are tracked separately; a paid order is still
      // "received" until the restaurant confirms it.
      await postWebhook(completedEvent());

      expect((await orderModel.findById(orderId))!.orderStatus).toBe(
        "received",
      );
    });
  });

  describe("The published event", () => {
    beforeEach(() => {
      stubVerifiedSession(orderId, "paid");
    });

    it("should publish PAYMENT_STATUS_UPDATE keyed by order id", async () => {
      await postWebhook(completedEvent());

      const { topic, key, body } = publishedMessage();

      expect(topic).toBe("order");
      expect(key).toBe(orderId);
      expect(body.event_type).toBe("PAYMENT_STATUS_UPDATE");
    });

    it("should carry the updated order flat under data", async () => {
      // Built with `.toObject()`, like changeStatus and unlike create.
      await postWebhook(completedEvent());

      const data = publishedMessage().body.data;

      expect(data.paymentStatus).toBe(PaymentStatus.PAID);
      expect(data.total).toBe(1162);
      expect(data._doc).toBeUndefined();
    });

    it("should embed the whole customer", async () => {
      await postWebhook(completedEvent());

      const customer = publishedMessage().body.data.customerId as {
        email: string;
      };

      expect(customer.email).toBe("swarup@test.com");
    });

    it("should publish for a failed payment too", async () => {
      stubVerifiedSession(orderId, "unpaid");

      await postWebhook(completedEvent());

      expect(publishedMessage().body.data.paymentStatus).toBe(
        PaymentStatus.FAILED,
      );
    });
  });

  describe("Events other than checkout.session.completed", () => {
    it("should acknowledge without doing anything", async () => {
      const response = await postWebhook({
        type: "payment_intent.created",
        data: { object: { id: "pi_1" } },
      });

      expect(response.statusCode).toBe(200);
      expect(getSession).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("should acknowledge an empty body", async () => {
      const response = await postWebhook({});

      expect(response.statusCode).toBe(200);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("should leave the order untouched", async () => {
      await postWebhook({ type: "charge.refunded", data: { object: {} } });

      expect((await orderModel.findById(orderId))!.paymentStatus).toBe(
        PaymentStatus.PENDING,
      );
    });
  });

  describe("Security and error handling", () => {
    it("should accept the webhook without any authentication", async () => {
      // Intentional — Stripe cannot present a user token. But see the next
      // test for what is missing.
      stubVerifiedSession(orderId, "paid");

      const response = await postWebhook(completedEvent());

      expect(response.statusCode).toBe(200);
    });

    it("should not verify the Stripe signature", async () => {
      // BUG, captured rather than asserted as correct. The handler never
      // checks the `Stripe-Signature` header against the webhook signing
      // secret, so anyone who can reach this endpoint can post a
      // `checkout.session.completed` for a session id of their choosing.
      //
      // What limits the damage today is that the payment outcome is re-read
      // from Stripe rather than taken from the body — an attacker cannot mark
      // an unpaid order paid, only replay a genuinely paid session. That is a
      // mitigation, not a substitute: `stripe.webhooks.constructEvent` with
      // the signing secret is the fix, and it needs the raw body, so it also
      // needs `express.raw()` on this route rather than `express.json()`.
      stubVerifiedSession(orderId, "paid");

      const response = await request(app)
        .post("/payments/webhook")
        .set("Stripe-Signature", "t=0,v1=obviously-forged")
        .send(completedEvent());

      expect(response.statusCode).toBe(200);
      expect((await orderModel.findById(orderId))!.paymentStatus).toBe(
        PaymentStatus.PAID,
      );
    });

    it("should return 500 when the metadata names an order that does not exist", async () => {
      // BUG, captured rather than asserted as correct. `findOneAndUpdate`
      // returns null and the next line reads `updatedOrder.customerId`. Stripe
      // sees a 500 and retries the webhook on its backoff schedule, forever.
      // A null check that acknowledges with a 200 and logs would stop that.
      stubVerifiedSession(new mongoose.Types.ObjectId().toString(), "paid");

      const response = await postWebhook(completedEvent());

      expect(response.statusCode).toBe(500);
    });

    it("should return 500 when the metadata carries no order id", async () => {
      stubVerifiedSession("", "paid");

      const response = await postWebhook(completedEvent());

      expect(response.statusCode).toBe(500);
    });

    it("should apply the same completed session twice", async () => {
      // BUG, captured rather than asserted as correct. Stripe delivers
      // webhooks at least once, and there is no guard against reprocessing —
      // so a redelivery publishes a second PAYMENT_STATUS_UPDATE and
      // notification-service tells the customer twice. The order itself is
      // written idempotently, so only the notification duplicates.
      stubVerifiedSession(orderId, "paid");

      await postWebhook(completedEvent());
      await postWebhook(completedEvent());

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect((await orderModel.findById(orderId))!.paymentStatus).toBe(
        PaymentStatus.PAID,
      );
    });
  });
});
