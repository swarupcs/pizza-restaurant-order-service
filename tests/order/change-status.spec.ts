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
import { OrderStatus } from "../../src/order/orderTypes";
import { ROLES } from "../../src/types";
import { clearDb, connectDb, disconnectDb } from "../utils/db";
import { customerDoc, orderDocument } from "../utils/fixtures";
import {
  publishedMessage,
  resetBrokerMocks,
  sendMessage,
} from "../mocks/broker";

describe("PATCH /orders/change-status/:orderId", () => {
  let jwks: ReturnType<typeof createJWKSMock>;
  let adminToken: string;
  let managerToken: string;
  let customerToken: string;
  let orderId: string;

  beforeAll(async () => {
    jwks = createJWKSMock("http://localhost:5501");
    await connectDb();
  });

  beforeEach(async () => {
    jwks.start();
    await clearDb();
    resetBrokerMocks();

    adminToken = jwks.token({ sub: "10", role: ROLES.ADMIN });
    managerToken = jwks.token({ sub: "20", role: ROLES.MANAGER, tenant: "1" });
    customerToken = jwks.token({ sub: "1", role: ROLES.CUSTOMER });

    const customer = await customerModel.create(customerDoc());
    const order = await orderModel.create(
      orderDocument({ customerId: customer._id, tenantId: "1" }),
    );
    orderId = order._id.toString();
  });

  afterEach(() => {
    jwks.stop();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  const changeStatus = (
    id: string,
    token: string | undefined,
    status: unknown = OrderStatus.CONFIRMED,
  ) => {
    const req = request(app).patch(`/orders/change-status/${id}`);
    if (token) req.set("Cookie", [`accessToken=${token}`]);
    return req.send({ status });
  };

  describe("Given a manager for the tenant", () => {
    it("should return the 200 status code and the order id", async () => {
      const response = await changeStatus(orderId, managerToken);

      expect(response.statusCode).toBe(200);
      expect((response.body as { _id: string })._id).toBe(orderId);
    });

    it("should move the order to the new status", async () => {
      await changeStatus(orderId, managerToken, OrderStatus.PREPARED);

      expect((await orderModel.findById(orderId))!.orderStatus).toBe(
        OrderStatus.PREPARED,
      );
    });

    it("should walk the full status sequence", async () => {
      for (const status of [
        OrderStatus.CONFIRMED,
        OrderStatus.PREPARED,
        OrderStatus.OUT_FOR_DELIVERY,
        OrderStatus.DELIVERED,
      ]) {
        await changeStatus(orderId, managerToken, status);
      }

      expect((await orderModel.findById(orderId))!.orderStatus).toBe(
        OrderStatus.DELIVERED,
      );
    });

    it("should not touch the payment status", async () => {
      // Only the Stripe webhook may change that.
      await changeStatus(orderId, managerToken);

      expect((await orderModel.findById(orderId))!.paymentStatus).toBe(
        "pending",
      );
    });

    it("should allow moving a status backwards", async () => {
      // BUG, captured rather than asserted as correct. There is no transition
      // check, so a delivered order can be pushed back to received. The
      // controller carries a `todo: req.body.status <- Put proper validation.`
      await changeStatus(orderId, managerToken, OrderStatus.DELIVERED);
      await changeStatus(orderId, managerToken, OrderStatus.RECEIVED);

      expect((await orderModel.findById(orderId))!.orderStatus).toBe(
        OrderStatus.RECEIVED,
      );
    });

    it("should store a status outside the enum", async () => {
      // BUG, captured rather than asserted as correct. `orderStatus` is an
      // enum in the schema, but `findOneAndUpdate` does not run validators
      // unless `runValidators: true` is passed — so an arbitrary string is
      // written straight into the order and broadcast to every consumer. The
      // controller's own `todo: req.body.status <- Put proper validation.`
      // names the fix.
      const response = await changeStatus(orderId, managerToken, "teleported");

      expect(response.statusCode).toBe(200);
      expect((await orderModel.findById(orderId))!.orderStatus).toBe(
        "teleported",
      );
      expect(publishedMessage().body.data.orderStatus).toBe("teleported");
    });
  });

  describe("Given an admin", () => {
    it("should let an admin change any tenant's order", async () => {
      const otherTenantOrder = await orderModel.create(
        orderDocument({
          customerId: new mongoose.Types.ObjectId(),
          tenantId: "99",
        }),
      );

      const response = await changeStatus(
        otherTenantOrder._id.toString(),
        adminToken,
      );

      expect(response.statusCode).toBe(200);
    });
  });

  describe("Access control", () => {
    it("should return 401 if the caller is not authenticated", async () => {
      const response = await changeStatus(orderId, undefined);

      expect(response.statusCode).toBe(401);
      expect((await orderModel.findById(orderId))!.orderStatus).toBe(
        OrderStatus.RECEIVED,
      );
    });

    it("should return 403 for a manager from another tenant", async () => {
      const otherManager = jwks.token({
        sub: "21",
        role: ROLES.MANAGER,
        tenant: "9",
      });

      const response = await changeStatus(orderId, otherManager);

      expect(response.statusCode).toBe(403);
      expect((await orderModel.findById(orderId))!.orderStatus).toBe(
        OrderStatus.RECEIVED,
      );
    });

    it("should let a customer change the status of anyone's order", async () => {
      // BUG, captured rather than asserted as correct — and the most serious
      // one in this service.
      //
      // The role gate reads:
      //
      //     if (role === ROLES.MANAGER || ROLES.ADMIN) {
      //
      // The second operand is the *string* "admin", not a comparison, so the
      // condition is always truthy and the body runs for every role. The only
      // rejection inside it is scoped to managers, so a customer sails
      // through: any authenticated user can mark any order delivered, for any
      // restaurant.
      //
      // The fix is `if (role === ROLES.MANAGER || role === ROLES.ADMIN)`, at
      // which point this test expects 403 — and the `return next(403)` at the
      // bottom of the handler, currently unreachable, starts doing its job.
      const response = await changeStatus(
        orderId,
        customerToken,
        OrderStatus.DELIVERED,
      );

      expect(response.statusCode).toBe(200);
      expect((await orderModel.findById(orderId))!.orderStatus).toBe(
        OrderStatus.DELIVERED,
      );
    });

    it("should publish an event for the customer's unauthorised change", async () => {
      // Following the consequence through: the bogus transition is broadcast
      // to notification-service, so the real customer is emailed that their
      // order was delivered.
      await changeStatus(orderId, customerToken, OrderStatus.DELIVERED);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(publishedMessage().body.event_type).toBe("ORDER_STATUS_UPDATE");
    });
  });

  describe("The published event", () => {
    it("should publish to the order topic keyed by order id", async () => {
      await changeStatus(orderId, managerToken);

      const { topic, key } = publishedMessage();

      expect(topic).toBe("order");
      expect(key).toBe(orderId);
    });

    it("should carry the updated order flat under data", async () => {
      // `changeStatus` builds the payload with `.toObject()`, so the fields
      // land at the top of `data`. The create path spreads the Mongoose
      // document instead and is broken because of it — see
      // tests/order/create.spec.ts.
      await changeStatus(orderId, managerToken, OrderStatus.PREPARED);

      const data = publishedMessage().body.data;

      expect(data.orderStatus).toBe(OrderStatus.PREPARED);
      expect(data.total).toBe(1162);
      expect(data._doc).toBeUndefined();
    });

    it("should embed the whole customer", async () => {
      await changeStatus(orderId, managerToken);

      const customer = publishedMessage().body.data.customerId as {
        email: string;
      };

      expect(customer.email).toBe("swarup@test.com");
    });

    it("should publish the post-update status, not the previous one", async () => {
      // `{ new: true }` on the update is what makes this true.
      await changeStatus(orderId, managerToken, OrderStatus.OUT_FOR_DELIVERY);

      expect(publishedMessage().body.data.orderStatus).toBe(
        OrderStatus.OUT_FOR_DELIVERY,
      );
    });
  });

  describe("Invalid input", () => {
    it("should return 400 when the order does not exist", async () => {
      const missing = new mongoose.Types.ObjectId().toString();

      const response = await changeStatus(missing, managerToken);

      expect(response.statusCode).toBe(400);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("should return 500 for a malformed order id", async () => {
      // BUG, captured rather than asserted as correct. No id validation, so a
      // CastError becomes a 500 rather than a 400.
      const response = await changeStatus("not-an-id", managerToken);

      expect(response.statusCode).toBe(500);
    });

    it("should report success for a request with no status at all", async () => {
      // BUG, captured rather than asserted as correct. `req.body.status` is
      // undefined and Mongoose drops undefined values from an update, so the
      // order is untouched — but the client still gets a 200 with the order
      // id, and an ORDER_STATUS_UPDATE goes out announcing a change that never
      // happened. Validating the body would turn this into a 400.
      const response = await request(app)
        .patch(`/orders/change-status/${orderId}`)
        .set("Cookie", [`accessToken=${managerToken}`])
        .send({});

      expect(response.statusCode).toBe(200);
      expect((await orderModel.findById(orderId))!.orderStatus).toBe(
        OrderStatus.RECEIVED,
      );
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});
