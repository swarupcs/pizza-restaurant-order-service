import mongoose from "mongoose";

import { CartItem } from "../../src/types";
import {
  OrderStatus,
  PaymentMode,
  PaymentStatus,
} from "../../src/order/orderTypes";

/**
 * Fixed ids so a spec can assert on them without threading values around.
 * They have to be *valid ObjectId strings* even where the field is declared a
 * String: `orderModel`'s embedded topping schema types `id` as an ObjectId, so
 * an arbitrary string fails validation on save — while `toppingCacheModel`
 * stores `toppingId` as a String and compares it with `===`.
 */
export const PRODUCT_ID = "660000000000000000000001";
export const TOPPING_ID = "660000000000000000000002";

/**
 * The default cart prices to **900** against the default caches:
 *
 *     Size "Large"   800   (base)
 *     Crust "Thick"   50   (aditional)
 *     Cheese topping  50   (from the topping cache)
 *
 * Every expected total in the specs is derived from that number, so changing
 * it here changes them all consistently.
 */
export const BASE_ITEM_PRICE = 900;

export const cartItem = (overrides: Partial<CartItem> = {}): CartItem =>
  ({
    _id: PRODUCT_ID,
    name: "Margherita",
    image: "https://cdn.test/margherita.png",
    priceConfiguration: {
      Size: {
        priceType: "base",
        availableOptions: { Small: 400, Medium: 600, Large: 800 },
      },
      Crust: {
        priceType: "aditional",
        availableOptions: { Thin: 0, Thick: 50 },
      },
    },
    chosenConfiguration: {
      priceConfiguration: { Size: "Large", Crust: "Thick" },
      selectedToppings: [
        {
          id: TOPPING_ID,
          name: "Cheese",
          price: 50,
          image: "https://cdn.test/cheese.png",
        },
      ],
    },
    qty: 1,
    ...overrides,
  }) as CartItem;

/** A cart item with no toppings — isolates product pricing from topping pricing. */
export const cartItemWithoutToppings = (overrides: Partial<CartItem> = {}) =>
  cartItem({
    chosenConfiguration: {
      priceConfiguration: { Size: "Large", Crust: "Thick" },
      selectedToppings: [],
    },
    ...overrides,
  });

/**
 * What order-service caches locally after consuming a PRODUCT_CREATE event.
 * This is the only price source `calculateTotal` trusts — the prices carried
 * in the cart body are ignored.
 */
export const productCacheDoc = (overrides: Record<string, unknown> = {}) => ({
  productId: PRODUCT_ID,
  priceConfiguration: {
    Size: {
      priceType: "base",
      availableOptions: { Small: 400, Medium: 600, Large: 800 },
    },
    Crust: {
      priceType: "aditional",
      availableOptions: { Thin: 0, Thick: 50 },
    },
  },
  ...overrides,
});

export const toppingCacheDoc = (overrides: Record<string, unknown> = {}) => ({
  toppingId: TOPPING_ID,
  price: 50,
  tenantId: "1",
  ...overrides,
});

export const customerDoc = (overrides: Record<string, unknown> = {}) => ({
  userId: "1",
  firstName: "Swarup",
  lastName: "Das",
  email: "swarup@test.com",
  addresses: [{ text: "12 Park Street, Kolkata", isDefault: false }],
  ...overrides,
});

export const couponDoc = (overrides: Record<string, unknown> = {}) => ({
  title: "Launch offer",
  code: "SAVE10",
  // A year out, so the suite does not start failing on a calendar boundary.
  validUpto: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  discount: 10,
  tenantId: 1,
  ...overrides,
});

/** The body `POST /orders` expects. */
export const orderPayload = (overrides: Record<string, unknown> = {}) => ({
  cart: [cartItem()],
  couponCode: "",
  tenantId: "1",
  paymentMode: PaymentMode.CASH,
  customerId: new mongoose.Types.ObjectId().toString(),
  comment: "Ring the bell twice",
  address: "12 Park Street, Kolkata",
  ...overrides,
});

/** A persisted order, for the read and status-change specs. */
export const orderDocument = (overrides: Record<string, unknown> = {}) => ({
  cart: [cartItem()],
  address: "12 Park Street, Kolkata",
  comment: "Ring the bell twice",
  customerId: new mongoose.Types.ObjectId(),
  deliveryCharges: 100,
  discount: 0,
  taxes: 162,
  total: 1162,
  tenantId: "1",
  orderStatus: OrderStatus.RECEIVED,
  paymentMode: PaymentMode.CASH,
  paymentStatus: PaymentStatus.PENDING,
  ...overrides,
});
