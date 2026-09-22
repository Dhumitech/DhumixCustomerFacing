import type { JobCommandEnvelope } from "./jobCommand.js";

export interface JobCommandPublisher {
  publish(command: JobCommandEnvelope): Promise<void>;
  close(): Promise<void>;
}

export interface JobCommandDelivery {
  readonly command: JobCommandEnvelope;
  readonly deliveryCount: number;
  renewLock(): Promise<void>;
  complete(): Promise<void>;
  abandon(): Promise<void>;
  deadLetter(reasonCode: string): Promise<void>;
}

export interface JobCommandReceiver {
  subscribe(
    handler: (delivery: JobCommandDelivery) => Promise<void>,
    onError: (error: unknown) => Promise<void>,
  ): Promise<{ close(): Promise<void> }>;
  close(): Promise<void>;
}

export interface DeadLetterCommandDelivery {
  readonly command: JobCommandEnvelope;
  readonly deadLetterReason: string | null;
  readonly deliveryCount: number;
  complete(): Promise<void>;
  abandon(): Promise<void>;
}

export interface DeadLetterCommandReceiver {
  receiveByEventId(
    eventId: string,
    maxWaitTimeMs: number,
  ): Promise<DeadLetterCommandDelivery | null>;
  close(): Promise<void>;
}
