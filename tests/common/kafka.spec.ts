import { EachMessagePayload } from "kafkajs";

jest.mock("kafkajs", () => {
  const producer = {
    connect: jest.fn(),
    disconnect: jest.fn(),
    send: jest.fn(),
  };
  const consumer = {
    connect: jest.fn(),
    disconnect: jest.fn(),
    subscribe: jest.fn(),
    run: jest.fn(),
  };
  const Kafka = jest.fn().mockImplementation(() => ({
    producer: () => producer,
    consumer: jest.fn(() => consumer),
  }));
  return { Kafka, __producer: producer, __consumer: consumer };
});

// The two consumer callbacks are covered against a real database in
// tests/cache/handlers.spec.ts; here only the dispatch to them matters.
jest.mock("../../src/productCache/productUpdateHandler", () => ({
  handleProductUpdate: jest.fn(),
}));
jest.mock("../../src/toppingCache/toppingUpdateHandler", () => ({
  handleToppingUpdate: jest.fn(),
}));

import { Kafka } from "kafkajs";
import { KafkaBroker } from "../../src/config/kafka";
import { handleProductUpdate } from "../../src/productCache/productUpdateHandler";
import { handleToppingUpdate } from "../../src/toppingCache/toppingUpdateHandler";

const kafkajs = jest.requireMock("kafkajs") as {
  __producer: Record<string, jest.Mock>;
  __consumer: Record<string, jest.Mock>;
};

describe("KafkaBroker", () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // consumeMessage logs every message it receives.
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe("construction", () => {
    it("should build a plaintext client outside production", () => {
      new KafkaBroker("order-service", ["localhost:9092"]);

      expect(Kafka).toHaveBeenCalledWith({
        clientId: "order-service",
        brokers: ["localhost:9092"],
      });
    });

    it("should add ssl and sasl in production", () => {
      // A managed broker needs SASL/PLAIN over TLS and is slow to hand out a
      // connection, hence the 45s timeout. This is also why
      // config/production.yaml has to define `kafka.ssl` even though the value
      // is overridden from the environment — node-config throws on `get()` of
      // an undefined key.
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      try {
        new KafkaBroker("order-service", ["broker:9092"]);

        const config = (Kafka as unknown as jest.Mock).mock.calls[0][0] as {
          ssl: boolean;
          connectionTimeout: number;
          sasl: { mechanism: string };
        };

        expect(config.ssl).toBe(true);
        expect(config.connectionTimeout).toBe(45000);
        expect(config.sasl.mechanism).toBe("plain");
      } finally {
        process.env.NODE_ENV = previous;
      }
    });
  });

  describe("producer", () => {
    it("should send the message to the given topic", async () => {
      await new KafkaBroker("order-service", []).sendMessage(
        "order",
        '{"a":1}',
        undefined as unknown as string,
      );

      expect(kafkajs.__producer.send).toHaveBeenCalledWith({
        topic: "order",
        messages: [{ value: '{"a":1}' }],
      });
    });

    it("should attach the key when one is given", async () => {
      // The key pins a single order's events to one partition, which is what
      // keeps ORDER_CREATE ahead of its status updates.
      await new KafkaBroker("order-service", []).sendMessage(
        "order",
        '{"a":1}',
        "order-1",
      );

      expect(kafkajs.__producer.send).toHaveBeenCalledWith({
        topic: "order",
        messages: [{ value: '{"a":1}', key: "order-1" }],
      });
    });

    it("should connect and disconnect the producer", async () => {
      const broker = new KafkaBroker("order-service", []);

      await broker.connectProducer();
      await broker.disconnectProducer();

      expect(kafkajs.__producer.connect).toHaveBeenCalledTimes(1);
      expect(kafkajs.__producer.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe("consumer", () => {
    const runConsumer = async (topics = ["product", "topping"]) => {
      const broker = new KafkaBroker("order-service", []);
      await broker.consumeMessage(topics, false);

      const { eachMessage } = kafkajs.__consumer.run.mock.calls[0][0] as {
        eachMessage: (payload: EachMessagePayload) => Promise<void>;
      };

      return (topic: string, value: string) =>
        eachMessage({
          topic,
          partition: 0,
          message: { value: Buffer.from(value) },
        } as unknown as EachMessagePayload);
    };

    it("should subscribe to the requested topics", async () => {
      await runConsumer();

      expect(kafkajs.__consumer.subscribe).toHaveBeenCalledWith({
        topics: ["product", "topping"],
        fromBeginning: false,
      });
    });

    it("should route a product message to the product handler", async () => {
      const deliver = await runConsumer();

      await deliver("product", '{"event_type":"PRODUCT_CREATE"}');

      expect(handleProductUpdate).toHaveBeenCalledWith(
        '{"event_type":"PRODUCT_CREATE"}',
      );
      expect(handleToppingUpdate).not.toHaveBeenCalled();
    });

    it("should route a topping message to the topping handler", async () => {
      const deliver = await runConsumer();

      await deliver("topping", '{"event_type":"TOPPING_CREATE"}');

      expect(handleToppingUpdate).toHaveBeenCalledWith(
        '{"event_type":"TOPPING_CREATE"}',
      );
      expect(handleProductUpdate).not.toHaveBeenCalled();
    });

    it("should ignore a topic it does not know", async () => {
      const deliver = await runConsumer();

      await deliver("order", "{}");

      expect(handleProductUpdate).not.toHaveBeenCalled();
      expect(handleToppingUpdate).not.toHaveBeenCalled();
    });

    it("should let a handler rejection escape", async () => {
      // BUG, captured rather than asserted as correct. `eachMessage` does not
      // catch, so a failing handler rejects and kafkajs retries the same
      // offset indefinitely — one poison message stalls the partition and
      // every later price update stops arriving. Both handlers already carry a
      // `todo: wrap this parsing in try catch`.
      (handleProductUpdate as jest.Mock).mockRejectedValueOnce(
        new Error("unparseable"),
      );
      const deliver = await runConsumer();

      await expect(deliver("product", "not json")).rejects.toThrow(
        "unparseable",
      );
    });

    it("should connect and disconnect the consumer", async () => {
      const broker = new KafkaBroker("order-service", []);

      await broker.connectConsumer();
      await broker.disconnectConsumer();

      expect(kafkajs.__consumer.connect).toHaveBeenCalledTimes(1);
      expect(kafkajs.__consumer.disconnect).toHaveBeenCalledTimes(1);
    });

    it("should log every message it receives", async () => {
      // BUG, captured rather than asserted as correct. `console.log` on the
      // hot path of every product and topping event, bypassing the winston
      // logger that the rest of the service uses — so these lines carry no
      // service name, no level and no timestamp, and are not silenced in
      // tests.
      const deliver = await runConsumer();

      await deliver("product", '{"event_type":"PRODUCT_CREATE"}');

      expect(logSpy).toHaveBeenCalled();
    });
  });
});
