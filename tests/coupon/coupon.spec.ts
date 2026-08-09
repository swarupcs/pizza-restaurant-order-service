import request from "supertest";
import createJWKSMock from "mock-jwks";

jest.mock("../../src/common/factories/brokerFactory", () =>
  require("../mocks/broker"),
);
jest.mock("../../src/payment/stripe", () => require("../mocks/stripe"));

import app from "../../src/app";
import couponModel from "../../src/coupon/couponModel";
import { ROLES } from "../../src/types";
import { clearDb, connectDb, disconnectDb, syncIndexes } from "../utils/db";
import { couponDoc } from "../utils/fixtures";

describe("Coupon routes", () => {
  let jwks: ReturnType<typeof createJWKSMock>;
  let adminToken: string;
  let managerToken: string;
  let customerToken: string;

  beforeAll(async () => {
    jwks = createJWKSMock("http://localhost:5501");
    await connectDb();
    // The duplicate-code spec depends on the compound unique index existing.
    await syncIndexes();
  });

  beforeEach(async () => {
    jwks.start();
    await clearDb();

    adminToken = jwks.token({ sub: "10", role: ROLES.ADMIN });
    managerToken = jwks.token({ sub: "20", role: ROLES.MANAGER, tenant: "1" });
    customerToken = jwks.token({ sub: "1", role: ROLES.CUSTOMER });
  });

  afterEach(() => {
    jwks.stop();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  const post = (
    path: string,
    token: string | undefined,
    body: Record<string, unknown>,
  ) => {
    const req = request(app).post(path);
    if (token) req.set("Cookie", [`accessToken=${token}`]);
    return req.send(body);
  };

  describe("POST /coupons", () => {
    it("should return 401 if the caller is not authenticated", async () => {
      const response = await post("/coupons", undefined, couponDoc());

      expect(response.statusCode).toBe(401);
      expect(await couponModel.countDocuments()).toBe(0);
    });

    it("should create the coupon", async () => {
      const response = await post("/coupons", adminToken, couponDoc());

      expect(response.statusCode).toBe(200);
      expect(await couponModel.countDocuments()).toBe(1);
    });

    it("should return the created coupon", async () => {
      const response = await post("/coupons", adminToken, couponDoc());
      const body = response.body as { code: string; discount: number };

      expect(body.code).toBe("SAVE10");
      expect(body.discount).toBe(10);
    });

    it("should store tenantId as a number", async () => {
      // The schema types it Number while every other service passes tenant ids
      // around as strings. Mongoose casts on the way in, which is why
      // `getDiscountPercentage` has to convert explicitly on the way out.
      await post("/coupons", adminToken, couponDoc({ tenantId: "1" }));

      const coupon = await couponModel.findOne({ code: "SAVE10" });

      expect(typeof coupon!.tenantId).toBe("number");
      expect(coupon!.tenantId).toBe(1);
    });

    it("should reject a duplicate code for the same tenant", async () => {
      // The compound unique index on { tenantId, code } is what stops two
      // coupons in a restaurant sharing a code.
      await post("/coupons", adminToken, couponDoc());

      const response = await post("/coupons", adminToken, couponDoc());

      // A duplicate-key error is not an HttpError, so asyncWrapper reports it
      // as a 500. A 409 with a usable message would be better, but the write
      // is correctly refused.
      expect(response.statusCode).toBe(500);
      expect(await couponModel.countDocuments()).toBe(1);
    });

    it("should allow the same code for a different tenant", async () => {
      await post("/coupons", adminToken, couponDoc({ tenantId: 1 }));

      const response = await post(
        "/coupons",
        adminToken,
        couponDoc({ tenantId: 2 }),
      );

      expect(response.statusCode).toBe(200);
      expect(await couponModel.countDocuments()).toBe(2);
    });

    it("should return 500 when a required field is missing", async () => {
      // BUG, captured rather than asserted as correct. The controller carries
      // a `todo: add request validation.` — the schema catches it, but as an
      // unhandled ValidationError, so the client gets a 500 rather than a 400
      // naming the field.
      const payload = couponDoc();
      delete (payload as Partial<typeof payload>).code;

      const response = await post("/coupons", adminToken, payload);

      expect(response.statusCode).toBe(500);
      expect(await couponModel.countDocuments()).toBe(0);
    });

    it("should let a customer create a coupon for any restaurant", async () => {
      // BUG, captured rather than asserted as correct. The controller carries
      // a `todo: check if creator is admin or a manger of that restaurant.`
      // and the route has no canAccess — so any authenticated user can mint a
      // discount code for any tenant and immediately spend it.
      const response = await post(
        "/coupons",
        customerToken,
        couponDoc({ code: "FREE100", discount: 100, tenantId: 7 }),
      );

      expect(response.statusCode).toBe(200);
      expect(await couponModel.findOne({ code: "FREE100" })).not.toBeNull();
    });

    it("should let a manager create a coupon for another tenant", async () => {
      // The same missing check, from the role that has a legitimate reason to
      // create coupons — but only for tenant 1.
      const response = await post(
        "/coupons",
        managerToken,
        couponDoc({ tenantId: 99 }),
      );

      expect(response.statusCode).toBe(200);
    });
  });

  describe("POST /coupons/verify", () => {
    beforeEach(async () => {
      await couponModel.create(couponDoc());
    });

    it("should return 401 if the caller is not authenticated", async () => {
      const response = await post("/coupons/verify", undefined, {
        code: "SAVE10",
        tenantId: 1,
      });

      expect(response.statusCode).toBe(401);
    });

    it("should confirm a valid coupon and return its discount", async () => {
      const response = await post("/coupons/verify", customerToken, {
        code: "SAVE10",
        tenantId: 1,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body as { valid: boolean; discount: number }).toEqual({
        valid: true,
        discount: 10,
      });
    });

    it("should return 400 for an unknown code", async () => {
      const response = await post("/coupons/verify", customerToken, {
        code: "NOPE",
        tenantId: 1,
      });

      expect(response.statusCode).toBe(400);
    });

    it("should return 400 for another tenant's code", async () => {
      const response = await post("/coupons/verify", customerToken, {
        code: "SAVE10",
        tenantId: 2,
      });

      expect(response.statusCode).toBe(400);
    });

    it("should report an expired coupon as invalid with no discount", async () => {
      // Note the asymmetry: an unknown code is a 400, an expired one is a 200
      // with `valid: false`. The client has to handle both shapes.
      await couponModel.updateOne(
        { code: "SAVE10" },
        { $set: { validUpto: new Date("2020-01-01") } },
      );

      const response = await post("/coupons/verify", customerToken, {
        code: "SAVE10",
        tenantId: 1,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body as { valid: boolean; discount: number }).toEqual({
        valid: false,
        discount: 0,
      });
    });

    it("should treat a coupon expiring later today as valid", async () => {
      // The comparison is `currentDate <= couponDate` against a full
      // timestamp, so a coupon is live until the moment stored, not until the
      // end of that calendar day.
      await couponModel.updateOne(
        { code: "SAVE10" },
        { $set: { validUpto: new Date(Date.now() + 60 * 1000) } },
      );

      const response = await post("/coupons/verify", customerToken, {
        code: "SAVE10",
        tenantId: 1,
      });

      expect((response.body as { valid: boolean }).valid).toBe(true);
    });

    it("should accept a string tenantId", async () => {
      // The order flow sends a string; Mongoose casts it for the query.
      const response = await post("/coupons/verify", customerToken, {
        code: "SAVE10",
        tenantId: "1",
      });

      expect((response.body as { valid: boolean }).valid).toBe(true);
    });

    it("should return 500 when tenantId cannot be cast to a number", async () => {
      // BUG, captured rather than asserted as correct. Another consequence of
      // the missing `todo: request validation` — a non-numeric tenantId is a
      // CastError and therefore a 500, where the honest answer is a 400.
      const response = await post("/coupons/verify", customerToken, {
        code: "SAVE10",
        tenantId: "not-a-number",
      });

      expect(response.statusCode).toBe(500);
    });
  });
});
