import mongoose from "mongoose";

/**
 * Connects to the in-memory replica set started by tests/globalSetup.ts.
 *
 * Note this deliberately does *not* read `config.get("database.url")` the way
 * catelog-service's equivalent does. The URI is only known at runtime — the
 * replica set picks a free port — so globalSetup hands it over through the
 * environment.
 */
export const connectDb = async () => {
  await mongoose.connect(process.env.MONGO_TEST_URI as string);
};

export const disconnectDb = async () => {
  await mongoose.connection.close();
};

/**
 * Empties every collection without dropping the database, so the unique
 * indexes declared on the coupon, idempotency and topping-cache schemas
 * survive between tests. Several specs depend on those indexes being present.
 */
export const clearDb = async () => {
  const collections = await mongoose.connection.db!.collections();
  for (const collection of collections) {
    await collection.deleteMany({});
  }
};

/**
 * Mongoose only builds the indexes declared on a schema lazily. The specs that
 * assert on duplicate-key behaviour need them built up front.
 */
export const syncIndexes = async () => {
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.syncIndexes()),
  );
};
