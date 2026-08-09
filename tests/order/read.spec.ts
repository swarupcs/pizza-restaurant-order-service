import request from "supertest";
import mongoose from "mongoose";
import createJWKSMock from "mock-jwks";

jest.mock("../../src/common/factories/brokerFactory", () =>
  require("../mocks/broker"),
);
jest.mock("../../src/payment/stripe", () => require("../mocks/stripe"));

import app from "../../src/app";
import orderModel from "../../src/order/orderModel";
import customerModel from "../../src/customer/customerModel";
import { ROLES } from "../../src/types";
import { clearDb, connectDb, disconnectDb } from "../utils/db";
import { customerDoc, orderDocument } from "../utils/fixtures";

describe("Reading orders", () => {
  let jwks: ReturnType<typeof createJWKSMock>;
  let adminToken: string;
  let managerToken: string;
  let customerToken: string;
  let customerId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    jwks = createJWKSMock("http://localhost:5501");
    await connectDb();
  });

  beforeEach(async () => {
    jwks.start();
    await clearDb();

    adminToken = jwks.token({ sub: "10", role: ROLES.ADMIN });
    managerToken = jwks.token({ sub: "20", role: ROLES.MANAGER, tenant: "1" });
    customerToken = jwks.token({ sub: "1", role: ROLES.CUSTOMER });

    const customer = await customerModel.create(customerDoc());
    customerId = customer._id;
  });

  afterEach(() => {
    jwks.stop();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  const get = (path: string, token?: string) => {
    const req = request(app).get(path);
    return token ? req.set("Cookie", [`accessToken=${token}`]) : req;
  };

  describe("GET /orders", () => {
    beforeEach(async () => {
      await orderModel.create(orderDocument({ customerId, tenantId: "1" }));
      await orderModel.create(orderDocument({ customerId, tenantId: "2" }));
    });

    it("should return 401 if the caller is not authenticated", async () => {
      const response = await get("/orders");

      expect(response.statusCode).toBe(401);
    });

    it("should return 403 for a customer", async () => {
      // Customers use /orders/mine; this endpoint is the restaurant dashboard.
      const response = await get("/orders", customerToken);

      expect(response.statusCode).toBe(403);
    });

    it("should return every order for an admin", async () => {
      const response = await get("/orders", adminToken);

      expect(response.statusCode).toBe(200);
      expect(response.body as unknown[]).toHaveLength(2);
    });

    it("should let an admin filter by tenant", async () => {
      const response = await get("/orders?tenantId=2", adminToken);

      const orders = response.body as { tenantId: string }[];

      expect(orders).toHaveLength(1);
      expect(orders[0].tenantId).toBe("2");
    });

    it("should scope a manager to their own tenant", async () => {
      // The tenant comes from the token, not the query string, so a manager
      // cannot widen it.
      const response = await get("/orders", managerToken);

      const orders = response.body as { tenantId: string }[];

      expect(orders).toHaveLength(1);
      expect(orders[0].tenantId).toBe("1");
    });

    it("should ignore a tenantId query from a manager", async () => {
      const response = await get("/orders?tenantId=2", managerToken);

      const orders = response.body as { tenantId: string }[];

      expect(orders).toHaveLength(1);
      expect(orders[0].tenantId).toBe("1");
    });

    it("should return the newest order first", async () => {
      await orderModel.create(
        orderDocument({ customerId, tenantId: "1", address: "Newest" }),
      );

      const response = await get("/orders", managerToken);
      const orders = response.body as { address: string }[];

      expect(orders[0].address).toBe("Newest");
    });

    it("should populate the customer", async () => {
      // The dashboard renders the customer's name next to each order and has
      // no second call to resolve it.
      const response = await get("/orders", adminToken);
      const orders = response.body as { customerId: { email: string } }[];

      expect(orders[0].customerId.email).toBe("swarup@test.com");
    });

    it("should include the cart", async () => {
      // Unlike /orders/mine, which projects it away.
      const response = await get("/orders", adminToken);
      const orders = response.body as { cart: unknown[] }[];

      expect(orders[0].cart).toHaveLength(1);
    });

    it("should return every order unpaginated", async () => {
      // BUG, captured rather than asserted as correct. The controller carries
      // a `todo: VERY IMPORTANT. add pagination.` — an admin request returns
      // the entire order history of the platform in one response, and it grows
      // without bound.
      await orderModel.create(
        Array.from({ length: 25 }, () =>
          orderDocument({ customerId, tenantId: "1" }),
        ),
      );

      const response = await get("/orders", adminToken);

      expect(response.body as unknown[]).toHaveLength(27);
    });
  });

  describe("GET /orders/mine", () => {
    beforeEach(async () => {
      await orderModel.create(orderDocument({ customerId }));
    });

    it("should return 401 if the caller is not authenticated", async () => {
      const response = await get("/orders/mine");

      expect(response.statusCode).toBe(401);
    });

    it("should return the caller's own orders", async () => {
      const response = await get("/orders/mine", customerToken);

      expect(response.statusCode).toBe(200);
      expect(response.body as unknown[]).toHaveLength(1);
    });

    it("should resolve the customer from the token subject", async () => {
      // The customer record is looked up by userId — the `sub` claim — not
      // taken from the request, so one customer cannot read another's orders.
      const other = await customerModel.create(
        customerDoc({ userId: "2", email: "other@test.com" }),
      );
      await orderModel.create(orderDocument({ customerId: other._id }));

      const response = await get("/orders/mine", customerToken);

      expect(response.body as unknown[]).toHaveLength(1);
    });

    it("should return 400 when the caller has no customer record", async () => {
      const strangerToken = jwks.token({ sub: "404", role: ROLES.CUSTOMER });

      const response = await get("/orders/mine", strangerToken);

      expect(response.statusCode).toBe(400);
    });

    it("should project the cart away", async () => {
      // The list view only needs totals and status; carts are large.
      const response = await get("/orders/mine", customerToken);
      const orders = response.body as { cart?: unknown; total: number }[];

      expect(orders[0].cart).toBeUndefined();
      expect(orders[0].total).toBe(1162);
    });

    it("should work for a manager who also has a customer record", async () => {
      // The route reads `sub` and never checks the role, so any authenticated
      // user with a customer record can use it.
      const token = jwks.token({ sub: "1", role: ROLES.MANAGER, tenant: "1" });

      const response = await get("/orders/mine", token);

      expect(response.statusCode).toBe(200);
      expect(response.body as unknown[]).toHaveLength(1);
    });
  });

  describe("GET /orders/:orderId", () => {
    let orderId: string;

    beforeEach(async () => {
      const order = await orderModel.create(
        orderDocument({ customerId, tenantId: "1" }),
      );
      orderId = order._id.toString();
    });

    it("should return 401 if the caller is not authenticated", async () => {
      const response = await get(`/orders/${orderId}`);

      expect(response.statusCode).toBe(401);
    });

    it("should let an admin read any order", async () => {
      const response = await get(`/orders/${orderId}`, adminToken);

      expect(response.statusCode).toBe(200);
    });

    it("should return 403 to a manager for their own tenant's order", async () => {
      // BUG, captured rather than asserted as correct. The projection defaults
      // to `{ customerId: 1 }`, which is an *inclusion* projection — so
      // `tenantId` is not fetched, `order.tenantId === tenantId` compares
      // undefined against the token's tenant, and the manager is refused their
      // own restaurant's order. A manager can only ever read one by asking for
      // the field that the check needs:
      //     GET /orders/:id?fields=tenantId
      // Defaulting the projection to `{}` fixes both this and the empty-body
      // case below.
      const response = await get(`/orders/${orderId}`, managerToken);

      expect(response.statusCode).toBe(403);
    });

    it("should let a manager read it once tenantId is projected in", async () => {
      // The same request with the field the check depends on. This is the
      // behaviour the test above should have, and will have after the fix.
      const response = await get(
        `/orders/${orderId}?fields=tenantId`,
        managerToken,
      );

      expect(response.statusCode).toBe(200);
    });

    it("should return 403 for a manager from another tenant", async () => {
      const otherManager = jwks.token({
        sub: "21",
        role: ROLES.MANAGER,
        tenant: "9",
      });

      const response = await get(`/orders/${orderId}`, otherManager);

      expect(response.statusCode).toBe(403);
    });

    it("should let a customer read their own order", async () => {
      const response = await get(`/orders/${orderId}`, customerToken);

      expect(response.statusCode).toBe(200);
    });

    it("should return 403 for a customer reading someone else's order", async () => {
      const other = await customerModel.create(
        customerDoc({ userId: "2", email: "other@test.com" }),
      );
      const otherOrder = await orderModel.create(
        orderDocument({ customerId: other._id, tenantId: "1" }),
      );

      const response = await get(
        `/orders/${otherOrder._id.toString()}`,
        customerToken,
      );

      expect(response.statusCode).toBe(403);
    });

    it("should return 400 for a customer with no customer record", async () => {
      const strangerToken = jwks.token({ sub: "404", role: ROLES.CUSTOMER });

      const response = await get(`/orders/${orderId}`, strangerToken);

      expect(response.statusCode).toBe(400);
    });

    it("should return 400 when the order does not exist", async () => {
      // 400 rather than 404 — the message is "Order does not exists."
      const missing = new mongoose.Types.ObjectId().toString();

      const response = await get(`/orders/${missing}`, adminToken);

      expect(response.statusCode).toBe(400);
    });

    it("should narrow the response to the requested fields", async () => {
      // The client polls this endpoint for live status with
      // ?fields=orderStatus,paymentStatus rather than refetching the cart.
      const response = await get(
        `/orders/${orderId}?fields=orderStatus,paymentStatus`,
        adminToken,
      );

      const order = response.body as Record<string, unknown>;

      expect(order.orderStatus).toBe("received");
      expect(order.paymentStatus).toBe("pending");
      expect(order.total).toBeUndefined();
      expect(order.cart).toBeUndefined();
    });

    it("should always include the customer, whatever fields were asked for", async () => {
      // `customerId` is seeded into the projection unconditionally, because
      // the ownership check below it dereferences the populated customer.
      const response = await get(
        `/orders/${orderId}?fields=orderStatus`,
        adminToken,
      );

      const order = response.body as { customerId: { email: string } };

      expect(order.customerId.email).toBe("swarup@test.com");
    });

    it("should return almost nothing when no fields are given", async () => {
      // BUG, captured rather than asserted as correct. `fields` defaults to
      // `[]`, so the projection reduces to `{ customerId: 1 }` — an inclusion
      // projection naming a single field. A plain
      // `GET /orders/:orderId` therefore returns only `_id` and the populated
      // customer: no total, no status, no cart. Every real caller has to pass
      // `?fields=` listing everything it wants.
      //
      // The fix is to use the projection only when `fields` is non-empty.
      const response = await get(`/orders/${orderId}`, adminToken);
      const order = response.body as Record<string, unknown>;

      expect(order.total).toBeUndefined();
      expect(order.cart).toBeUndefined();
      expect(order.orderStatus).toBeUndefined();
      expect(Object.keys(order).sort()).toEqual(["_id", "customerId"]);
    });

    it("should return 500 for a malformed order id", async () => {
      // BUG, captured rather than asserted as correct. There is no id
      // validation on the route, so a bad id becomes a Mongoose CastError and
      // asyncWrapper reports 500 instead of 400.
      const response = await get("/orders/not-an-id", adminToken);

      expect(response.statusCode).toBe(500);
    });

    it("should return 500 when the order points at a deleted customer", async () => {
      // BUG, captured rather than asserted as correct. `populate` yields null
      // for a dangling reference, and the customer branch then reads
      // `order.customerId._id`. The caller here has a customer record of their
      // own — it is the *order's* reference that dangles — so the earlier
      // "No customer found." guard does not catch it and the request 500s.
      const orphan = await orderModel.create(
        orderDocument({
          customerId: new mongoose.Types.ObjectId(),
          tenantId: "1",
        }),
      );

      const response = await get(
        `/orders/${orphan._id.toString()}`,
        customerToken,
      );

      expect(response.statusCode).toBe(500);
    });
  });
});
