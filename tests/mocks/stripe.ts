/**
 * Stand-in for src/payment/stripe.
 *
 * `orderRouter.ts` and `paymentRouter.ts` both do `new StripeGW()` at module
 * load, and StripeGW's constructor reads `config.get("stripe.secretKey")` and
 * builds a live Stripe client. Without this, importing the app is enough to
 * construct one, and a card order would try to reach api.stripe.com.
 *
 * Specs opt in with:
 *
 *     jest.mock("../../src/payment/stripe", () => require("../mocks/stripe"));
 */
import {
  PaymentOptions,
  VerifiedSession,
} from "../../src/payment/paymentTypes";

/** Records the options the controller passed, so specs can assert on them. */
export const createSession = jest.fn(async (options: PaymentOptions) => ({
  id: "cs_test_session",
  paymentUrl: `https://checkout.stripe.test/pay/${options.orderId}`,
  paymentStatus: "unpaid" as const,
}));

export const getSession = jest.fn(
  async (id: string): Promise<VerifiedSession> => ({
    id,
    metadata: { orderId: "" },
    paymentStatus: "paid",
  }),
);

export const StripeGW = jest.fn().mockImplementation(() => ({
  createSession,
  getSession,
}));

/**
 * Points `getSession` at a specific order with a specific outcome — the two
 * things the webhook branches on.
 */
export const stubVerifiedSession = (
  orderId: string,
  paymentStatus: VerifiedSession["paymentStatus"] = "paid",
) => {
  getSession.mockImplementation(async (id: string) => ({
    id,
    metadata: { orderId },
    paymentStatus,
  }));
};

export const resetStripeMocks = () => {
  createSession.mockClear();
  getSession.mockClear();
  getSession.mockImplementation(async (id: string) => ({
    id,
    metadata: { orderId: "" },
    paymentStatus: "paid" as const,
  }));
};
