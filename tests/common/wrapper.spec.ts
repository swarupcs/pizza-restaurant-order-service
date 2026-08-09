import { NextFunction, Request, RequestHandler, Response } from "express";
import createHttpError, { HttpError } from "http-errors";

import { asyncWrapper } from "../../src/utils";

describe("asyncWrapper", () => {
  const req = {} as Request;
  const res = {} as Response;

  const run = async (handler: RequestHandler) => {
    const next = jest.fn() as unknown as NextFunction & jest.Mock;
    asyncWrapper(handler)(req, res, next);
    // Let the rejection settle before inspecting `next`.
    await new Promise((resolve) => setImmediate(resolve));
    return next;
  };

  it("should not call next when the handler resolves", async () => {
    const next = await run(async () => undefined);

    expect(next).not.toHaveBeenCalled();
  });

  it("should pass a rejected promise to next as a 500", async () => {
    const next = await run(async () => {
      throw new Error("database unreachable");
    });

    const error = next.mock.calls[0][0] as HttpError;

    expect(error.status).toBe(500);
    expect(error.message).toBe("database unreachable");
  });

  it("should flatten a status the error already carried", async () => {
    // BUG, captured rather than asserted as correct. An error thrown with a
    // meaningful status arrives at globalErrorHandler as a 500, so a "not
    // found" becomes a server error.
    //
    // Every controller in this service sidesteps it by calling
    // `next(createHttpError(...))` directly instead of throwing, which skips
    // the wrapper — which is why nothing has surfaced this yet. The fix is to
    // forward the error untouched when it is already an HttpError.
    const next = await run(async () => {
      throw createHttpError(404, "Order does not exists.");
    });

    const error = next.mock.calls[0][0] as HttpError;

    expect(error.status).toBe(500);
    expect(error.message).toBe("Order does not exists.");
  });

  it("should handle a rejection with a non-Error value", async () => {
    const next = await run(async () => {
      throw "just a string";
    });

    const error = next.mock.calls[0][0] as HttpError;

    expect(error.status).toBe(500);
    expect(error.message).toBe("Internal server error");
  });

  it("should not catch a synchronous throw", async () => {
    // `Promise.resolve(fn())` only wraps the return value — if `fn` throws
    // before returning, the exception propagates out of the wrapper rather
    // than reaching `.catch`. Express 5 catches it downstream, which is why
    // this has never been visible in a response.
    const next = jest.fn() as unknown as NextFunction;

    expect(() =>
      asyncWrapper(() => {
        throw new Error("thrown synchronously");
      })(req, res, next),
    ).toThrow("thrown synchronously");

    expect(next).not.toHaveBeenCalled();
  });

  it("should forward req, res and next to the handler", async () => {
    const handler = jest.fn();

    const next = await run(handler as unknown as RequestHandler);

    expect(handler).toHaveBeenCalledWith(req, res, next);
  });
});
