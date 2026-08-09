/**
 * Stand-in for src/common/factories/brokerFactory.
 *
 * `orderRouter.ts` and `paymentRouter.ts` both call `createMessageBroker()` at
 * module load, so a spec that imports the app would otherwise construct a real
 * KafkaBroker and every publish would hang trying to reach localhost:9092.
 *
 * Specs opt in with:
 *
 *     jest.mock("../../src/common/factories/brokerFactory", () => require("../mocks/broker"));
 *
 * The `require`-inside-factory form matters: `jest.mock` is hoisted above
 * `const` declarations, so a factory that closed over a top-level const would
 * hit a temporal-dead-zone error.
 */
export const sendMessage = jest.fn<Promise<void>, [string, string, string?]>();
export const connectProducer = jest.fn<Promise<void>, []>();
export const disconnectProducer = jest.fn<Promise<void>, []>();
export const connectConsumer = jest.fn<Promise<void>, []>();
export const disconnectConsumer = jest.fn<Promise<void>, []>();
export const consumeMessage = jest.fn<Promise<void>, [string[], boolean]>();

export const createMessageBroker = jest.fn(() => ({
  sendMessage,
  connectProducer,
  disconnectProducer,
  connectConsumer,
  disconnectConsumer,
  consumeMessage,
}));

/**
 * Reads back the nth published message, already parsed.
 *
 * Every publish in this service goes to the "order" topic with the order id as
 * the partition key, so the key is returned alongside the body — several specs
 * assert on it, because it is what guarantees a single order's events stay
 * ordered.
 */
export const publishedMessage = (call = 0) => {
  const [topic, payload, key] = sendMessage.mock.calls[call];
  return {
    topic,
    key,
    body: JSON.parse(payload) as {
      event_type: string;
      data: Record<string, unknown>;
    },
  };
};

export const resetBrokerMocks = () => {
  sendMessage.mockClear();
  connectProducer.mockClear();
  disconnectProducer.mockClear();
  connectConsumer.mockClear();
  disconnectConsumer.mockClear();
  consumeMessage.mockClear();
  createMessageBroker.mockClear();
};
