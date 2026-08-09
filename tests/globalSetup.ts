import { MongoMemoryReplSet } from "mongodb-memory-server";

/**
 * Starts one in-memory MongoDB **replica set** for the whole test run.
 *
 * A replica set, not a standalone, because `OrderController.create` opens a
 * `mongoose.startSession()` and runs the order + idempotency writes inside a
 * transaction. MongoDB rejects transactions on a standalone server with
 * "Transaction numbers are only allowed on a replica set member or mongos",
 * so a plain `mongod` — including the one running on localhost:27017 — cannot
 * exercise the most important path in this service.
 *
 * It is started once here rather than per-suite because the handshake costs
 * several seconds. `--runInBand` means every spec shares this one instance;
 * each spec still clears the collections between tests.
 */
declare global {
  var __MONGO_REPLSET__: MongoMemoryReplSet | undefined;
}

export default async function globalSetup() {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });

  global.__MONGO_REPLSET__ = replSet;
  process.env.MONGO_TEST_URI = replSet.getUri("order-service-test");
}
