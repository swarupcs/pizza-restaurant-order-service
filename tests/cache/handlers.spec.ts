import { handleProductUpdate } from "../../src/productCache/productUpdateHandler";
import { handleToppingUpdate } from "../../src/toppingCache/toppingUpdateHandler";
import productCacheModel from "../../src/productCache/productCacheModel";
import toppingCacheModel from "../../src/toppingCache/toppingCacheModel";
import { clearDb, connectDb, disconnectDb, syncIndexes } from "../utils/db";
import { PRODUCT_ID, TOPPING_ID } from "../utils/fixtures";

/**
 * These are the Kafka consumer callbacks. They are what keeps order-service
 * able to price a cart without calling catelog-service, so a bug here shows up
 * as a wrong bill rather than an error.
 */
describe("Cache update handlers", () => {
  beforeAll(async () => {
    await connectDb();
    await syncIndexes();
  });

  beforeEach(async () => {
    await clearDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  const productEvent = (
    id = PRODUCT_ID,
    priceConfiguration: Record<string, unknown> = {
      Size: {
        priceType: "base",
        availableOptions: { Small: 400, Medium: 600, Large: 800 },
      },
    },
  ) =>
    JSON.stringify({
      event_type: "PRODUCT_CREATE",
      data: { id, priceConfiguration },
    });

  const toppingEvent = (id = TOPPING_ID, price = 50, tenantId = "1") =>
    JSON.stringify({
      event_type: "TOPPING_CREATE",
      data: { id, price, tenantId },
    });

  describe("handleProductUpdate", () => {
    it("should insert a product that is not cached yet", async () => {
      // The upsert is what makes PRODUCT_CREATE and PRODUCT_UPDATE the same
      // code path — the handler never has to know which it is.
      await handleProductUpdate(productEvent());

      const cached = await productCacheModel.findOne({ productId: PRODUCT_ID });

      expect(cached).not.toBeNull();
      expect(
        (cached!.priceConfiguration as unknown as Record<string, unknown>).Size,
      ).toEqual({
        priceType: "base",
        availableOptions: { Small: 400, Medium: 600, Large: 800 },
      });
    });

    it("should update the price of a product already cached", async () => {
      await handleProductUpdate(productEvent());
      await handleProductUpdate(
        productEvent(PRODUCT_ID, {
          Size: {
            priceType: "base",
            availableOptions: { Small: 450, Medium: 650, Large: 900 },
          },
        }),
      );

      const cached = await productCacheModel.findOne({ productId: PRODUCT_ID });
      const config = cached!.priceConfiguration as unknown as {
        Size: { availableOptions: { Large: number } };
      };

      expect(config.Size.availableOptions.Large).toBe(900);
    });

    it("should not create a duplicate row on a repeated event", async () => {
      // Kafka delivers at least once, so the same event can arrive twice.
      await handleProductUpdate(productEvent());
      await handleProductUpdate(productEvent());

      expect(await productCacheModel.countDocuments()).toBe(1);
    });

    it("should replace the whole price configuration, not merge it", async () => {
      // `$set` on the top-level field, so a dimension removed in
      // catelog-service disappears here too rather than lingering.
      await handleProductUpdate(
        productEvent(PRODUCT_ID, {
          Size: { priceType: "base", availableOptions: { Large: 800 } },
          Crust: { priceType: "aditional", availableOptions: { Thick: 50 } },
        }),
      );
      await handleProductUpdate(
        productEvent(PRODUCT_ID, {
          Size: { priceType: "base", availableOptions: { Large: 800 } },
        }),
      );

      const cached = await productCacheModel.findOne({ productId: PRODUCT_ID });
      const config = cached!.priceConfiguration as unknown as Record<
        string,
        unknown
      >;

      expect(config.Crust).toBeUndefined();
    });

    it("should keep separate rows for separate products", async () => {
      await handleProductUpdate(productEvent(PRODUCT_ID));
      await handleProductUpdate(productEvent("660000000000000000000009"));

      expect(await productCacheModel.countDocuments()).toBe(2);
    });

    it("should store nested option maps as plain objects", async () => {
      // The cache schema declares `type: Object`, not `type: Map` — unlike
      // catelog-service's own model. That is deliberate here: `getItemTotal`
      // reads `priceConfiguration[key].availableOptions[value]` with plain
      // property access, which a Map would not answer.
      await handleProductUpdate(productEvent());

      const cached = await productCacheModel
        .findOne({ productId: PRODUCT_ID })
        .lean();
      const config = (cached as unknown as { priceConfiguration: unknown })
        .priceConfiguration;

      expect(config).not.toBeInstanceOf(Map);
      expect(
        (config as Record<string, { availableOptions: Record<string, number> }>)
          .Size.availableOptions.Medium,
      ).toBe(600);
    });

    it("should throw on a malformed payload", async () => {
      // BUG, captured rather than asserted as correct. There is a
      // `todo: wrap this parsing in try catch` on the handler. An unparseable
      // message rejects out of `eachMessage`, and kafkajs retries the same
      // offset — so one poison message stalls the whole partition and every
      // later price update stops arriving.
      await expect(handleProductUpdate("not json")).rejects.toThrow();
    });

    it("should throw when the event has no data", async () => {
      await expect(
        handleProductUpdate(JSON.stringify({ event_type: "PRODUCT_CREATE" })),
      ).rejects.toThrow();
    });

    it("should cache an event that carries no price configuration", async () => {
      // BUG, captured rather than asserted as correct. A PRODUCT_DELETE — or
      // any event without prices — upserts a row with an empty configuration
      // rather than removing it. `getItemTotal` then reads
      // `priceConfiguration[key]` as undefined and the order 500s, which is
      // indistinguishable from the product never having been cached.
      await handleProductUpdate(
        JSON.stringify({
          event_type: "PRODUCT_DELETE",
          data: { id: PRODUCT_ID },
        }),
      );

      expect(await productCacheModel.countDocuments()).toBe(1);
    });
  });

  describe("handleToppingUpdate", () => {
    it("should insert a topping that is not cached yet", async () => {
      await handleToppingUpdate(toppingEvent());

      const cached = await toppingCacheModel.findOne({ toppingId: TOPPING_ID });

      expect(cached!.price).toBe(50);
      expect(cached!.tenantId).toBe("1");
    });

    it("should update the price of a topping already cached", async () => {
      await handleToppingUpdate(toppingEvent());
      await handleToppingUpdate(toppingEvent(TOPPING_ID, 75));

      expect(
        (await toppingCacheModel.findOne({ toppingId: TOPPING_ID }))!.price,
      ).toBe(75);
    });

    it("should not create a duplicate row on a repeated event", async () => {
      await handleToppingUpdate(toppingEvent());
      await handleToppingUpdate(toppingEvent());

      expect(await toppingCacheModel.countDocuments()).toBe(1);
    });

    it("should keep separate rows for separate toppings", async () => {
      await handleToppingUpdate(toppingEvent(TOPPING_ID));
      await handleToppingUpdate(toppingEvent("660000000000000000000008"));

      expect(await toppingCacheModel.countDocuments()).toBe(2);
    });

    it("should store the topping id as a string", async () => {
      // It is compared with `===` against `topping.id` from the cart in
      // `getCurrentToppingPrice`, so an ObjectId here would never match.
      await handleToppingUpdate(toppingEvent());

      const cached = await toppingCacheModel
        .findOne({ toppingId: TOPPING_ID })
        .lean();

      expect(
        typeof (cached as unknown as { toppingId: unknown }).toppingId,
      ).toBe("string");
    });

    it("should throw on a malformed payload", async () => {
      // The same missing try/catch as the product handler, and the same
      // consequence for the partition.
      await expect(handleToppingUpdate("not json")).rejects.toThrow();
    });

    it("should throw when the event has no data", async () => {
      await expect(
        handleToppingUpdate(JSON.stringify({ event_type: "TOPPING_CREATE" })),
      ).rejects.toThrow();
    });

    it("should reject a second topping sharing an id", async () => {
      // The unique index on toppingId is what guarantees
      // `getCurrentToppingPrice` cannot pick between two rows.
      await handleToppingUpdate(toppingEvent());

      await expect(
        toppingCacheModel.create({
          toppingId: TOPPING_ID,
          price: 10,
          tenantId: "2",
        }),
      ).rejects.toThrow();
    });
  });
});
