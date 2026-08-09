import { MongoMemoryReplSet } from "mongodb-memory-server";

export default async function globalTeardown() {
  const replSet = global.__MONGO_REPLSET__ as MongoMemoryReplSet | undefined;
  if (replSet) {
    await replSet.stop();
  }
}
