import Stripe from "stripe";
import config from "config";
import {
  CustomMetadata,
  GatewayPaymentStatus,
  PaymentGW,
  PaymentOptions,
  VerifiedSession,
} from "./paymentTypes";

/**
 * Stripe's SDK types payment_status as the three documented values plus an
 * open-ended string, so new API values don't break compilation. We keep the
 * domain type closed and narrow here, at the gateway boundary, so an
 * unrecognised status fails loudly instead of flowing into order state.
 */
const toGatewayPaymentStatus = (status: string): GatewayPaymentStatus => {
  if (
    status === "paid" ||
    status === "unpaid" ||
    status === "no_payment_required"
  ) {
    return status;
  }
  throw new Error(`Unexpected Stripe payment_status: ${status}`);
};

export class StripeGW implements PaymentGW {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(config.get("stripe.secretKey"));
  }

  async createSession(options: PaymentOptions) {
    const session = await this.stripe.checkout.sessions.create(
      {
        // todo: get customer email from database
        // customer_email: options.email
        metadata: {
          orderId: options.orderId,
          restaurantId: options.tenantId,
        },
        billing_address_collection: "required",
        // todo: In Future, Capture structured address from customer
        // payment_intent_data: {
        //     shipping: {
        //         name: "Rakesh K",
        //         address: {
        //             line1: "some line",
        //             city: "Mumbai",
        //             country: "India",
        //             postal_code: "898798"
        //         }
        //     }
        // },
        line_items: [
          {
            price_data: {
              unit_amount: options.amount * 100,
              product_data: {
                name: "Online Pizza order",
                description: "Total amount to be paid",
                images: ["https://placehold.jp/150x150.png"],
              },
              currency: options.currency || "inr",
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${config.get("frontend.clientUI")}/payment?success=true&orderId=${options.orderId}&restaurantId=${options.tenantId}`,
        cancel_url: `${config.get("frontend.clientUI")}/payment?success=false&orderId=${options.orderId}&restaurantId=${options.tenantId}`,
      },
      { idempotencyKey: options.idempotenencyKey },
    );

    return {
      id: session.id,
      paymentUrl: session.url,
      paymentStatus: toGatewayPaymentStatus(session.payment_status),
    };
  }

  async getSession(id: string) {
    const session = await this.stripe.checkout.sessions.retrieve(id);

    const verifiedSession: VerifiedSession = {
      id: session.id,
      paymentStatus: toGatewayPaymentStatus(session.payment_status),
      metadata: session.metadata as unknown as CustomMetadata,
    };

    return verifiedSession;
  }
}
