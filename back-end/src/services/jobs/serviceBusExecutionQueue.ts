import {
  ServiceBusClient,
  type ProcessErrorArgs,
  type ServiceBusReceivedMessage,
  type ServiceBusReceiver,
} from "@azure/service-bus";
import type { ServiceBusEmulatorRuntimeConfig } from "../../config/pattern4Environment.js";
import { parseJobCommandEnvelope } from "./jobCommand.js";
import type {
  DeadLetterCommandDelivery,
  DeadLetterCommandReceiver,
  JobCommandDelivery,
  JobCommandPublisher,
  JobCommandReceiver,
} from "./executionQueue.js";

function commandForMessage(message: ServiceBusReceivedMessage) {
  const command = parseJobCommandEnvelope(message.body);
  if (String(message.messageId) !== command.event_id || message.subject !== command.topic) {
    throw new Error("JOB_COMMAND_BROKER_METADATA_MISMATCH");
  }
  return command;
}

export function createServiceBusJobCommandPublisher(
  config: ServiceBusEmulatorRuntimeConfig,
): JobCommandPublisher {
  const client = new ServiceBusClient(config.connectionString);
  const sender = client.createSender(config.queueName);
  return {
    async publish(command): Promise<void> {
      await sender.sendMessages({
        body: command,
        messageId: command.event_id,
        correlationId: command.aggregate_id,
        subject: command.topic,
        contentType: "application/json",
        applicationProperties: {
          schema_version: command.schema_version,
          tenant_id: command.tenant_id,
          ordering_key: command.ordering_key,
        },
      });
    },
    async close(): Promise<void> {
      await sender.close();
      await client.close();
    },
  };
}

function deliveryFor(
  receiver: ServiceBusReceiver,
  message: ServiceBusReceivedMessage,
): JobCommandDelivery {
  const command = commandForMessage(message);
  return {
    command,
    deliveryCount: message.deliveryCount ?? 0,
    async renewLock(): Promise<void> {
      await receiver.renewMessageLock(message);
    },
    async complete(): Promise<void> {
      await receiver.completeMessage(message);
    },
    async abandon(): Promise<void> {
      await receiver.abandonMessage(message);
    },
    async deadLetter(reasonCode): Promise<void> {
      await receiver.deadLetterMessage(message, {
        deadLetterReason: reasonCode,
        deadLetterErrorDescription: "Dhumi rejected the command safely",
      });
    },
  };
}

export function createServiceBusDeadLetterCommandReceiver(
  config: ServiceBusEmulatorRuntimeConfig,
): DeadLetterCommandReceiver {
  const client = new ServiceBusClient(config.connectionString);
  const receiver = client.createReceiver(config.queueName, {
    receiveMode: "peekLock",
    subQueueType: "deadLetter",
  });
  return {
    async receiveByEventId(eventId, maxWaitTimeMs): Promise<DeadLetterCommandDelivery | null> {
      const messages = await receiver.receiveMessages(100, { maxWaitTimeInMs: maxWaitTimeMs });
      let target: ServiceBusReceivedMessage | undefined;
      for (const message of messages) {
        if (String(message.messageId).toLowerCase() === eventId.toLowerCase() && target === undefined) {
          target = message;
        } else {
          await receiver.abandonMessage(message);
        }
      }
      if (target === undefined) return null;

      let command;
      try {
        command = commandForMessage(target);
      } catch (error) {
        await receiver.abandonMessage(target);
        throw error;
      }
      return {
        command,
        deadLetterReason: target.deadLetterReason ?? null,
        deliveryCount: target.deliveryCount ?? 0,
        async complete(): Promise<void> {
          await receiver.completeMessage(target);
        },
        async abandon(): Promise<void> {
          await receiver.abandonMessage(target);
        },
      };
    },
    async close(): Promise<void> {
      await receiver.close();
      await client.close();
    },
  };
}

export function createServiceBusJobCommandReceiver(
  config: ServiceBusEmulatorRuntimeConfig,
  maxConcurrentCalls: number,
): JobCommandReceiver {
  const client = new ServiceBusClient(config.connectionString);
  const receiver = client.createReceiver(config.queueName, { receiveMode: "peekLock" });
  return {
    async subscribe(handler, onError) {
      const subscription = receiver.subscribe(
        {
          async processMessage(message): Promise<void> {
            let delivery: JobCommandDelivery;
            try {
              delivery = deliveryFor(receiver, message);
            } catch {
              await receiver.deadLetterMessage(message, {
                deadLetterReason: "JOB_COMMAND_INVALID",
                deadLetterErrorDescription: "Dhumi rejected the command safely",
              });
              return;
            }
            await handler(delivery);
          },
          async processError(args: ProcessErrorArgs): Promise<void> {
            await onError(args.error);
          },
        },
        {
          autoCompleteMessages: false,
          maxConcurrentCalls,
        },
      );
      return { close: async () => subscription.close() };
    },
    async close(): Promise<void> {
      await receiver.close();
      await client.close();
    },
  };
}
