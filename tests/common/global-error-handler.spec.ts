import { NextFunction, Request, Response } from "express";
import createHttpError, { HttpError } from "http-errors";

import { globalErrorHandler } from "../../src/common/middleware/globalErrorHandler";

interface ErrorEnvelope {
  errors: {
    ref: string;
    type: string;
    msg: string;
    path: string;
    location: string;
    stack: string | null;
  }[];
}

describe("globalErrorHandler", () => {
  const makeResponse = () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return res as unknown as Response & {
      status: jest.Mock;
      json: jest.Mock;
    };
  };

  const req = { path: "/orders", method: "POST" } as Request;
  const next = jest.fn() as unknown as NextFunction;

  const bodyOf = (res: { json: jest.Mock }) =>
    res.json.mock.calls[0][0] as ErrorEnvelope;

  it("should use the status carried by the error", () => {
    const res = makeResponse();

    globalErrorHandler(createHttpError(403, "Not allowed."), req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("should fall back to 500 for an error with no status", () => {
    const res = makeResponse();

    globalErrorHandler(new Error("boom") as HttpError, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("should return the standard envelope", () => {
    const res = makeResponse();

    globalErrorHandler(
      createHttpError(400, "Order does not exists."),
      req,
      res,
      next,
    );

    const error = bodyOf(res).errors[0];

    expect(error.msg).toBe("Order does not exists.");
    expect(error.type).toBe("BadRequestError");
    expect(error.path).toBe("/orders");
    expect(error.location).toBe("server");
  });

  it("should attach a unique reference id to every error", () => {
    // The client is shown an opaque id and the log carries the same id next to
    // the real error — the only bridge between the two in production.
    const first = makeResponse();
    const second = makeResponse();

    globalErrorHandler(createHttpError(400, "Bad"), req, first, next);
    globalErrorHandler(createHttpError(400, "Bad"), req, second, next);

    expect(bodyOf(first).errors[0].ref).toEqual(expect.any(String));
    expect(bodyOf(first).errors[0].ref).not.toBe(bodyOf(second).errors[0].ref);
  });

  it("should include the stack outside production", () => {
    const res = makeResponse();

    globalErrorHandler(createHttpError(400, "Bad"), req, res, next);

    expect(bodyOf(res).errors[0].stack).toEqual(expect.any(String));
  });

  describe("in production", () => {
    let previous: string | undefined;

    beforeEach(() => {
      previous = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
    });

    afterEach(() => {
      process.env.NODE_ENV = previous;
    });

    it("should null the stack", () => {
      const res = makeResponse();

      globalErrorHandler(createHttpError(400, "Bad"), req, res, next);

      expect(bodyOf(res).errors[0].stack).toBeNull();
    });

    it("should replace the message with a generic one", () => {
      // Important here specifically: several handlers surface raw Mongoose
      // messages through asyncWrapper, and those name collections and fields.
      const res = makeResponse();

      globalErrorHandler(
        new Error(
          "E11000 duplicate key error collection: order-service.coupons",
        ) as HttpError,
        req,
        res,
        next,
      );

      expect(bodyOf(res).errors[0].msg).toBe("An unexpected error occurred.");
    });

    it("should hide 4xx messages too, like catelog-service and unlike auth-service", () => {
      // Worth pinning down because the three services differ. auth-service
      // echoes the message for a 400 and masks everything else; this one and
      // catelog-service mask every status. A client here is told
      // "An unexpected error occurred." when its coupon code was simply wrong.
      const res = makeResponse();

      globalErrorHandler(
        createHttpError(400, "Coupon does not exists"),
        req,
        res,
        next,
      );

      expect(bodyOf(res).errors[0].msg).toBe("An unexpected error occurred.");
    });

    it("should still return the real status code", () => {
      // The status is not masked, only the message — so a client can still
      // distinguish its own mistake from a server failure.
      const res = makeResponse();

      globalErrorHandler(createHttpError(403, "Not allowed."), req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
