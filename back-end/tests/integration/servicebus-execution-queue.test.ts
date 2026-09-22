import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { ServiceBusEmulatorRuntimeConfig } from "../../src/config/pattern4Environment.js";
import type { JobCommandEnvelope } from "../../src/services/jobs/jobCommand.js";
import {
  createServiceBusDeadLetterCommandReceiver,
  createServiceBusJobCommandPublisher,
  createServiceBusJobCommandReceiver,
} from "../../src/services/jobs/serviceBusExecutionQueue.js";

const enabled = process.env.RUN_SERVICE_BUS_EMULATOR_TESTS === "true";
const describeServiceBus = enabled ? describe : describe.skip;

const defaultConnection =
  "Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;" +
  "SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;";

async function beforeDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string) {
  return Promise.race([
    operation,
    wait(timeoutMs).then(() => {
      throw new Error(message);
    }),
  ]);
}

describeServiceBus("Service Bus execution queue adapter", () => {
  it("suppresses a dispatcher crash duplicate with the same durable event ID", async () => {
    const config: ServiceBusEmulatorRuntimeConfig = {
      driver: "emulator",
      connectionString: process.env.SERVICE_BUS_TEST_CONNECTION_STRING ?? defaultConnection,
      queueName: process.env.SERVICE_BUS_TEST_QUEUE ?? "dhumi-run-commands",
    };
    const runId = randomUUID();
    const command: JobCommandEnvelope = {
      event_id: randomUUID(),
      topic: "jobs.execute",
      schema_version: 1,
      aggregate_type: "run",
      aggregate_id: runId,
      tenant_id: randomUUID(),
      ordering_key: runId,
      payload: { run_id: runId },
    };
    const publisher = createServiceBusJobCommandPublisher(config);
    const receiver = createServiceBusJobCommandReceiver(config, 1);
    let subscription: { close(): Promise<void> } | undefined;
    let deliveries = 0;
    let resolveFirst: (() => void) | undefined;
    let rejectFirst: ((reason: unknown) => void) | undefined;
    const first = new Promise<void>((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });

    try {
      subscription = await receiver.subscribe(
        async (message) => {
          if (message.command.event_id !== command.event_id) {
            await message.abandon();
            return;
          }
          deliveries += 1;
          await message.complete();
          resolveFirst?.();
        },
        async (error) => rejectFirst?.(error),
      );
      await publisher.publish(command);
      await publisher.publish(command);
      await Promise.race([
        first,
        wait(10_000).then(() => {
          throw new Error("First duplicate-detection delivery missed its deadline");
        }),
      ]);
      await wait(1_000);
      expect(deliveries).toBe(1);
    } finally {
      await Promise.allSettled([
        subscription?.close() ?? Promise.resolve(),
        publisher.close(),
        receiver.close(),
      ]);
    }
  }, 30_000);

  it("round-trips and explicitly completes one strict Run command in peek-lock mode", async () => {
    const config: ServiceBusEmulatorRuntimeConfig = {
      driver: "emulator",
      connectionString: process.env.SERVICE_BUS_TEST_CONNECTION_STRING ?? defaultConnection,
      queueName: process.env.SERVICE_BUS_TEST_QUEUE ?? "dhumi-run-commands",
    };
    const runId = randomUUID();
    const command: JobCommandEnvelope = {
      event_id: randomUUID(),
      topic: "jobs.execute",
      schema_version: 1,
      aggregate_type: "run",
      aggregate_id: runId,
      tenant_id: randomUUID(),
      ordering_key: runId,
      payload: { run_id: runId },
    };
    const publisher = createServiceBusJobCommandPublisher(config);
    const receiver = createServiceBusJobCommandReceiver(config, 1);
    let subscription: { close(): Promise<void> } | undefined;
    let resolveDelivery: ((value: JobCommandEnvelope) => void) | undefined;
    let rejectDelivery: ((reason: unknown) => void) | undefined;
    const delivered = new Promise<JobCommandEnvelope>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });

    try {
      subscription = await receiver.subscribe(
        async (message) => {
          if (message.command.event_id !== command.event_id) {
            await message.abandon();
            return;
          }
          await message.complete();
          resolveDelivery?.(message.command);
        },
        async (error) => rejectDelivery?.(error),
      );
      await publisher.publish(command);
      const outcome = await Promise.race([
        delivered,
        wait(10_000).then(() => {
          throw new Error("Service Bus command was not delivered before the test deadline");
        }),
      ]);
      expect(outcome).toEqual(command);
    } finally {
      await Promise.allSettled([
        subscription?.close() ?? Promise.resolve(),
        publisher.close(),
        receiver.close(),
      ]);
    }
  });

  it("finds and settles one explicitly dead-lettered command by authoritative event ID", async () => {
    const config: ServiceBusEmulatorRuntimeConfig = {
      driver: "emulator",
      connectionString: process.env.SERVICE_BUS_TEST_CONNECTION_STRING ?? defaultConnection,
      queueName: process.env.SERVICE_BUS_TEST_QUEUE ?? "dhumi-run-commands",
    };
    const runId = randomUUID();
    const command: JobCommandEnvelope = {
      event_id: randomUUID(),
      topic: "jobs.execute",
      schema_version: 1,
      aggregate_type: "run",
      aggregate_id: runId,
      tenant_id: randomUUID(),
      ordering_key: runId,
      payload: { run_id: runId },
    };
    const publisher = createServiceBusJobCommandPublisher(config);
    const receiver = createServiceBusJobCommandReceiver(config, 1);
    let deadLetters = createServiceBusDeadLetterCommandReceiver(config);
    let subscription: { close(): Promise<void> } | undefined;
    let resolveDeadLetter: (() => void) | undefined;
    let rejectDeadLetter: ((reason: unknown) => void) | undefined;
    const deadLettered = new Promise<void>((resolve, reject) => {
      resolveDeadLetter = resolve;
      rejectDeadLetter = reject;
    });

    try {
      subscription = await receiver.subscribe(
        async (message) => {
          if (message.command.event_id !== command.event_id) {
            await message.abandon();
            return;
          }
          await message.deadLetter("CONTROLLED_TEST_DEAD_LETTER");
          resolveDeadLetter?.();
        },
        async (error) => rejectDeadLetter?.(error),
      );
      await publisher.publish(command);
      await Promise.race([
        deadLettered,
        wait(10_000).then(() => {
          throw new Error("Service Bus command was not dead-lettered before the deadline");
        }),
      ]);
      await beforeDeadline(
        subscription.close(),
        5_000,
        "Active queue subscription did not close before DLQ inspection",
      );
      subscription = undefined;

      const delivery = await deadLetters.receiveByEventId(command.event_id, 10_000);
      expect(delivery?.command).toEqual(command);
      expect(delivery?.deadLetterReason).toBe("CONTROLLED_TEST_DEAD_LETTER");
      await beforeDeadline(
        delivery?.complete() ?? Promise.resolve(),
        5_000,
        "DLQ delivery did not settle before its deadline",
      );

      // Verify settlement through a fresh receiver. The emulator may retain a
      // settled delivery in the current receiver's local receive buffer even
      // after completeMessage() has acknowledged it.
      await beforeDeadline(
        deadLetters.close(),
        5_000,
        "First DLQ receiver did not close before verification",
      );
      deadLetters = createServiceBusDeadLetterCommandReceiver(config);
      await expect(deadLetters.receiveByEventId(command.event_id, 500)).resolves.toBeNull();
    } finally {
      await Promise.race([
        Promise.allSettled([
          subscription?.close() ?? Promise.resolve(),
          publisher.close(),
          receiver.close(),
          deadLetters.close(),
        ]),
        wait(5_000),
      ]);
    }
  }, 45_000);
});
