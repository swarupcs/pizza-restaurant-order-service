import request from "supertest";
import mongoose from "mongoose";
import createJWKSMock from "mock-jwks";

jest.mock("../../src/common/factories/brokerFactory", () =>
  require("../mocks/broker"),
);
jest.mock("../../src/payment/stripe", () => require("../mocks/stripe"));

import app from "../../src/app";
import customerModel from "../../src/customer/customerModel";
import { ROLES } from "../../src/types";
import { clearDb, connectDb, disconnectDb } from "../utils/db";
import { customerDoc } from "../utils/fixtures";

describe("Customer routes", () => {
  let jwks: ReturnType<typeof createJWKSMock>;

  beforeAll(async () => {
    jwks = createJWKSMock("http://localhost:5501");
    await connectDb();
  });

  beforeEach(async () => {
    jwks.start();
    await clearDb();
  });

  afterEach(() => {
    jwks.stop();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  /**
   * auth-service does not yet put the name and email in the token — there is a
   * `todo: add these fields to jwt in auth service` on the controller — but
   * the controller reads them, so the specs mint tokens that carry them.
   */
  const token = (claims: Record<string, unknown> = {}) =>
    jwks.token({
      sub: "1",
      role: ROLES.CUSTOMER,
      firstName: "Swarup",
      lastName: "Das",
      email: "swarup@test.com",
      ...claims,
    });

  describe("GET /customer", () => {
    it("should return 401 if the caller is not authenticated", async () => {
      const response = await request(app).get("/customer").send();

      expect(response.statusCode).toBe(401);
    });

    it("should return the existing customer", async () => {
      await customerModel.create(customerDoc());

      const response = await request(app)
        .get("/customer")
        .set("Cookie", [`accessToken=${token()}`])
        .send();

      expect(response.statusCode).toBe(200);
      expect((response.body as { email: string }).email).toBe(
        "swarup@test.com",
      );
    });

    it("should create the customer on first call", async () => {
      // This endpoint doubles as registration: order-service keeps its own
      // customer record, and the first request from a new user creates it
      // from the token's claims rather than from a request body.
      expect(await customerModel.countDocuments()).toBe(0);

      const response = await request(app)
        .get("/customer")
        .set("Cookie", [`accessToken=${token()}`])
        .send();

      expect(response.statusCode).toBe(200);
      expect(await customerModel.countDocuments()).toBe(1);
    });

    it("should build the new customer from the token claims", async () => {
      await request(app)
        .get("/customer")
        .set("Cookie", [`accessToken=${token({ sub: "77" })}`])
        .send();

      const customer = await customerModel.findOne({ userId: "77" });

      expect(customer!.firstName).toBe("Swarup");
      expect(customer!.email).toBe("swarup@test.com");
      expect(customer!.addresses).toHaveLength(0);
    });

    it("should not create a second customer on a repeat call", async () => {
      await request(app)
        .get("/customer")
        .set("Cookie", [`accessToken=${token()}`])
        .send();
      await request(app)
        .get("/customer")
        .set("Cookie", [`accessToken=${token()}`])
        .send();

      expect(await customerModel.countDocuments()).toBe(1);
    });

    it("should key the customer on the token subject, not the email", async () => {
      // Two users could in principle share an email; `userId` is the identity
      // that matters, and it is the field the lookup uses.
      await request(app)
        .get("/customer")
        .set("Cookie", [`accessToken=${token({ sub: "1" })}`])
        .send();
      await request(app)
        .get("/customer")
        .set("Cookie", [`accessToken=${token({ sub: "2" })}`])
        .send();

      expect(await customerModel.countDocuments()).toBe(2);
    });

    it("should return 500 when the token carries no name or email", async () => {
      // BUG, captured rather than asserted as correct. auth-service does not
      // currently put firstName/lastName/email in the access token, and the
      // schema marks all three required — so against a real token from
      // auth-service today, the very first call for a new customer fails
      // validation and 500s. Either auth-service adds the claims or this
      // endpoint stops requiring them.
      const bare = jwks.token({ sub: "9", role: ROLES.CUSTOMER });

      const response = await request(app)
        .get("/customer")
        .set("Cookie", [`accessToken=${bare}`])
        .send();

      expect(response.statusCode).toBe(500);
      expect(await customerModel.countDocuments()).toBe(0);
    });

    it("should let any authenticated role through", async () => {
      // No canAccess on the route, so a manager gets a customer record too.
      const managerToken = token({ role: ROLES.MANAGER, sub: "30" });

      const response = await request(app)
        .get("/customer")
        .set("Cookie", [`accessToken=${managerToken}`])
        .send();

      expect(response.statusCode).toBe(200);
    });
  });

  describe("PATCH /customer/addresses/:id", () => {
    let customerId: string;

    beforeEach(async () => {
      const customer = await customerModel.create(customerDoc());
      customerId = customer._id.toString();
    });

    it("should return 401 if the caller is not authenticated", async () => {
      const response = await request(app)
        .patch(`/customer/addresses/${customerId}`)
        .send({ address: "New place" });

      expect(response.statusCode).toBe(401);
    });

    it("should append the address", async () => {
      const response = await request(app)
        .patch(`/customer/addresses/${customerId}`)
        .set("Cookie", [`accessToken=${token()}`])
        .send({ address: "9 Camac Street, Kolkata" });

      expect(response.statusCode).toBe(200);

      const customer = await customerModel.findById(customerId);

      expect(customer!.addresses).toHaveLength(2);
      expect(customer!.addresses[1].text).toBe("9 Camac Street, Kolkata");
    });

    it("should keep the existing addresses", async () => {
      // `$push`, not `$set` — a second address must not replace the first.
      await request(app)
        .patch(`/customer/addresses/${customerId}`)
        .set("Cookie", [`accessToken=${token()}`])
        .send({ address: "New place" });

      const customer = await customerModel.findById(customerId);

      expect(customer!.addresses[0].text).toBe("12 Park Street, Kolkata");
    });

    it("should default isDefault to false", async () => {
      // There is a `todo: implement isDefault field in future` here — nothing
      // ever sets it true, so a customer has no default address.
      await request(app)
        .patch(`/customer/addresses/${customerId}`)
        .set("Cookie", [`accessToken=${token()}`])
        .send({ address: "New place" });

      const customer = await customerModel.findById(customerId);

      expect(customer!.addresses.every((a) => a.isDefault === false)).toBe(
        true,
      );
    });

    it("should return the updated customer", async () => {
      const response = await request(app)
        .patch(`/customer/addresses/${customerId}`)
        .set("Cookie", [`accessToken=${token()}`])
        .send({ address: "New place" });

      const body = response.body as { addresses: { text: string }[] };

      expect(body.addresses).toHaveLength(2);
    });

    it("should not touch another user's customer record", async () => {
      // The update is scoped by `{ _id, userId }`, so knowing the id is not
      // enough — the token's subject has to match too.
      const other = await customerModel.create(
        customerDoc({ userId: "2", email: "other@test.com" }),
      );

      await request(app)
        .patch(`/customer/addresses/${other._id.toString()}`)
        .set("Cookie", [`accessToken=${token()}`])
        .send({ address: "Injected" });

      const untouched = await customerModel.findById(other._id);

      expect(untouched!.addresses).toHaveLength(1);
    });

    it("should return 200 with a null body for another user's record", async () => {
      // BUG, captured rather than asserted as correct. The scoping above is
      // right, but `findOneAndUpdate` simply returns null when nothing matches
      // and the controller sends it on unchecked. The caller gets
      // `200 null` instead of a 403 or a 404, so a client cannot tell a
      // rejected write from a successful one.
      const other = await customerModel.create(
        customerDoc({ userId: "2", email: "other@test.com" }),
      );

      const response = await request(app)
        .patch(`/customer/addresses/${other._id.toString()}`)
        .set("Cookie", [`accessToken=${token()}`])
        .send({ address: "Injected" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBeNull();
    });

    it("should return 200 with a null body for a customer that does not exist", async () => {
      const missing = new mongoose.Types.ObjectId().toString();

      const response = await request(app)
        .patch(`/customer/addresses/${missing}`)
        .set("Cookie", [`accessToken=${token()}`])
        .send({ address: "Nowhere" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBeNull();
    });

    it("should push a textless address when the body has none", async () => {
      // BUG, captured rather than asserted as correct. There is no validation
      // on the route, and `$push` does not run the schema's `required: true`
      // on `text` — update validators are off by default. So an empty body
      // appends a junk entry to the customer's address book and returns 200.
      // Validating the body is the fix; `runValidators: true` would at least
      // turn it into an error.
      const response = await request(app)
        .patch(`/customer/addresses/${customerId}`)
        .set("Cookie", [`accessToken=${token()}`])
        .send({});

      expect(response.statusCode).toBe(200);

      const customer = await customerModel.findById(customerId);

      expect(customer!.addresses).toHaveLength(2);
      expect(customer!.addresses[1].text).toBeUndefined();
    });

    it("should return 500 for a malformed customer id", async () => {
      // BUG, captured rather than asserted as correct. CastError becomes a
      // 500 rather than a 400 — the same missing id validation as the order
      // routes.
      const response = await request(app)
        .patch("/customer/addresses/not-an-id")
        .set("Cookie", [`accessToken=${token()}`])
        .send({ address: "Somewhere" });

      expect(response.statusCode).toBe(500);
    });
  });
});
