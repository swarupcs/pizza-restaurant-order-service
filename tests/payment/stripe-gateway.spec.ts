// The Stripe SDK is replaced wholesale: these tests are about what StripeGW
// asks the SDK to do, not about reaching Stripe. Note this spec deliberately
// does *not* use tests/mocks/stripe.ts — that stands in for StripeGW itself,
// and here StripeGW is the thing under test.
jest.mock("stripe", () => {
  const create = jest.fn();
  const retrieve = jest.fn();
  const Stripe = jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create, retrieve } },
  }));
  return {
    __esModule: true,
    default: Stripe,
    __create: create,
    __retrieve: retrieve,
  };
});

import Stripe from "stripe";
import { StripeGW } from "../../src/payment/stripe";

const sdk = jest.requireMock("stripe") as {
  __create: jest.Mock;
  __retrieve: jest.Mock;
};

describe("StripeGW", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should build the client from the configured secret key", () => {
    // From config/test.yaml.
    new StripeGW();

    expect(Stripe).toHaveBeenCalledWith("sk_test_placeholder");
  });

  describe("createSession", () => {
    const options = {
      amount: 1162,
      orderId: "order-1",
      tenantId: "7",
      currency: "inr" as const,
      idempotenencyKey: "key-1",
    };

    beforeEach(() => {
      sdk.__create.mockResolvedValue({
        id: "cs_test_1",
        url: "https://checkout.stripe.com/pay/cs_test_1",
        payment_status: "unpaid",
      });
    });

    it("should send the amount in the smallest currency unit", async () => {
      // Stripe bills in paise, and every total in this service is in rupees —
      // getting this wrong is a factor-of-100 error in either direction.
      await new StripeGW().createSession(options);

      const body = sdk.__create.mock.calls[0][0] as {
        line_items: { price_data: { unit_amount: number } }[];
      };

      expect(body.line_items[0].price_data.unit_amount).toBe(116200);
    });

    it("should carry the order id and tenant as session metadata", async () => {
      // This is the only thing that lets the webhook find the order later —
      // the webhook body never names one.
      await new StripeGW().createSession(options);

      const body = sdk.__create.mock.calls[0][0] as {
        metadata: { orderId: string; restaurantId: string };
      };

      expect(body.metadata.orderId).toBe("order-1");
      expect(body.metadata.restaurantId).toBe("7");
    });

    it("should default the currency to inr", async () => {
      await new StripeGW().createSession({ ...options, currency: undefined });

      const body = sdk.__create.mock.calls[0][0] as {
        line_items: { price_data: { currency: string } }[];
      };

      expect(body.line_items[0].price_data.currency).toBe("inr");
    });

    it("should build success and cancel urls that name the order", async () => {
      await new StripeGW().createSession(options);

      const body = sdk.__create.mock.calls[0][0] as {
        success_url: string;
        cancel_url: string;
      };

      expect(body.success_url).toContain("success=true");
      expect(body.success_url).toContain("orderId=order-1");
      expect(body.cancel_url).toContain("success=false");
      // From config/test.yaml.
      expect(body.success_url).toContain("http://localhost:5173");
    });

    it("should pass the idempotency key as a request option", async () => {
      // Not part of the session body — Stripe takes it as a second argument,
      // and it is what makes a retried checkout reuse the same session.
      await new StripeGW().createSession(options);

      expect(sdk.__create.mock.calls[0][1]).toEqual({
        idempotencyKey: "key-1",
      });
    });

    it("should ask for a one-off payment with a billing address", async () => {
      await new StripeGW().createSession(options);

      const body = sdk.__create.mock.calls[0][0] as {
        mode: string;
        billing_address_collection: string;
      };

      expect(body.mode).toBe("payment");
      expect(body.billing_address_collection).toBe("required");
    });

    it("should return the id, url and status", async () => {
      const session = await new StripeGW().createSession(options);

      expect(session).toEqual({
        id: "cs_test_1",
        paymentUrl: "https://checkout.stripe.com/pay/cs_test_1",
        paymentStatus: "unpaid",
      });
    });

    it("should throw on a payment status outside the three known values", async () => {
      // The narrowing exists so an unrecognised Stripe status fails at the
      // gateway boundary rather than flowing into order state as something
      // neither PAID nor FAILED.
      sdk.__create.mockResolvedValue({
        id: "cs_test_1",
        url: "https://checkout.stripe.com/pay/cs_test_1",
        payment_status: "partially_refunded",
      });

      await expect(new StripeGW().createSession(options)).rejects.toThrow(
        "Unexpected Stripe payment_status: partially_refunded",
      );
    });
  });

  describe("getSession", () => {
    it("should return the id, metadata and status", async () => {
      sdk.__retrieve.mockResolvedValue({
        id: "cs_test_1",
        payment_status: "paid",
        metadata: { orderId: "order-1", restaurantId: "7" },
      });

      const session = await new StripeGW().getSession("cs_test_1");

      expect(sdk.__retrieve).toHaveBeenCalledWith("cs_test_1");
      expect(session.id).toBe("cs_test_1");
      expect(session.paymentStatus).toBe("paid");
      expect(session.metadata.orderId).toBe("order-1");
    });

    it("should accept every documented payment status", async () => {
      for (const status of ["paid", "unpaid", "no_payment_required"]) {
        sdk.__retrieve.mockResolvedValue({
          id: "cs_test_1",
          payment_status: status,
          metadata: { orderId: "order-1" },
        });

        const session = await new StripeGW().getSession("cs_test_1");

        expect(session.paymentStatus).toBe(status);
      }
    });

    it("should throw on an unrecognised payment status", async () => {
      sdk.__retrieve.mockResolvedValue({
        id: "cs_test_1",
        payment_status: "something_new",
        metadata: { orderId: "order-1" },
      });

      await expect(new StripeGW().getSession("cs_test_1")).rejects.toThrow(
        "Unexpected Stripe payment_status: something_new",
      );
    });
  });
});
