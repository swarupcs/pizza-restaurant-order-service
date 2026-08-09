import request from "supertest";

jest.mock("../src/common/factories/brokerFactory", () =>
  require("./mocks/broker"),
);
jest.mock("../src/payment/stripe", () => require("./mocks/stripe"));

import app from "../src/app";

// App-level behaviour only: no database, no controllers.
describe("app", () => {
  describe("GET /", () => {
    it("should return the 200 status code", async () => {
      const response = await request(app).get("/").send();

      expect(response.statusCode).toBe(200);
    });

    it("should return the health-check greeting", async () => {
      const response = await request(app).get("/").send();

      expect(response.body as { message: string }).toEqual({
        message: "Hello from order service service!",
      });
    });
  });

  describe("Unknown routes", () => {
    it("should return 404 for a path that is not mounted", async () => {
      const response = await request(app).get("/does-not-exist").send();

      expect(response.statusCode).toBe(404);
    });

    it("should return 404 for a method the route does not handle", async () => {
      // /coupons is mounted for POST only.
      const response = await request(app).delete("/coupons").send();

      expect(response.statusCode).toBe(404);
    });
  });

  describe("Body parsing", () => {
    it("should return 400 for a malformed JSON body", async () => {
      const response = await request(app)
        .post("/coupons")
        .set("Content-Type", "application/json")
        .send("{ not valid json");

      // express.json() rejects it before `authenticate` ever runs, so this is
      // a 400 rather than the 401 an unauthenticated POST would normally get.
      expect(response.statusCode).toBe(400);
    });
  });

  describe("CORS", () => {
    it("should echo an allowed origin with credentials enabled", async () => {
      // credentials must be on because the access token travels as an
      // httpOnly cookie, and the CORS spec forbids pairing that with `*`.
      const response = await request(app)
        .get("/")
        .set("Origin", "http://localhost:5173")
        .send();

      expect(response.headers["access-control-allow-origin"]).toBe(
        "http://localhost:5173",
      );
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("should allow the admin UI origin too", async () => {
      const response = await request(app)
        .get("/")
        .set("Origin", "http://localhost:5174")
        .send();

      expect(response.headers["access-control-allow-origin"]).toBe(
        "http://localhost:5174",
      );
    });

    it("should not grant access to an unlisted origin", async () => {
      const response = await request(app)
        .get("/")
        .set("Origin", "https://evil.example.com")
        .send();

      expect(response.headers["access-control-allow-origin"]).not.toBe(
        "https://evil.example.com",
      );
    });
  });
});
