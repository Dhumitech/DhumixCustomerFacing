import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClientSecretCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { addServiceBusChecks, serviceBusConfiguration, serviceBusEnvironmentShape } from "../../src/config/serviceBusEnvironment.js";
import { createServiceBusJobCommandPublisher, createServiceBusJobCommandReceiver, createServiceBusDeadLetterCommandReceiver } from "../../src/services/jobs/serviceBusExecutionQueue.js";
import { projectDeploymentEnvironment } from "../../src/deployment/environment.js";
import { loadOutboxDispatcherConfig } from "../../src/config/pattern4Environment.js";

const mock = vi.hoisted(() => ({ sender: { sendMessages: vi.fn(), close: vi.fn() }, receiver: {
  subscribe: vi.fn(), close: vi.fn(), completeMessage: vi.fn(), abandonMessage: vi.fn(), deadLetterMessage: vi.fn(), renewMessageLock: vi.fn() },
  createSender: vi.fn(), createReceiver: vi.fn(), close: vi.fn() }));
vi.mock("@azure/identity", () => ({ ClientSecretCredential: vi.fn(function () {}) }));
vi.mock("@azure/service-bus", () => ({ ServiceBusClient: vi.fn(function () {
  mock.createSender.mockReturnValue(mock.sender); mock.createReceiver.mockReturnValue(mock.receiver); return mock;
}) }));
const namespace = "sb-example-ci-01.servicebus.windows.net";
const tenantId = "11111111-1111-4111-8111-111111111111", senderId = "22222222-2222-4222-8222-222222222222", receiverId = "33333333-3333-4333-8333-333333333333";
function source() { return { NODE_ENV: "test" as const, SERVICE_BUS_DRIVER: "azure" as const,
  SERVICE_BUS_CONNECTION_STRING: "", SERVICE_BUS_RUN_COMMAND_QUEUE: "dhumi-run-commands", SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE: namespace,
  SERVICE_BUS_TENANT_ID: tenantId, SERVICE_BUS_SENDER_CLIENT_ID: senderId, SERVICE_BUS_SENDER_CLIENT_SECRET: "sender-secret",
  SERVICE_BUS_RECEIVER_CLIENT_ID: receiverId, SERVICE_BUS_RECEIVER_CLIENT_SECRET: "receiver-secret" }; }
const schema = (role: "sender" | "receiver") => z.object({ ...serviceBusEnvironmentShape, NODE_ENV: z.enum(["development", "test", "production"]) }).superRefine((v, c) => addServiceBusChecks(v, c, role));
const config = (role: "sender" | "receiver") => serviceBusConfiguration(schema(role).parse(source()), role);
const command = { event_id: "44444444-4444-4444-8444-444444444444", topic: "jobs.cancel" as const, schema_version: 1 as const,
  aggregate_type: "run" as const, aggregate_id: receiverId, tenant_id: tenantId, ordering_key: receiverId, payload: { run_id: receiverId } };

describe("Azure Service Bus scoped authentication and persistent queue behavior", () => {
  it("scopes sender credentials to dispatcher and receiver credentials to Job Manager", () => {
    const sender = projectDeploymentEnvironment("outbox", source(), {}), receiver = projectDeploymentEnvironment("jobs", source(), {});
    expect(sender.SERVICE_BUS_SENDER_CLIENT_SECRET).toBe("sender-secret");
    expect(sender.SERVICE_BUS_RECEIVER_CLIENT_SECRET).toBeUndefined();
    expect(receiver.SERVICE_BUS_RECEIVER_CLIENT_SECRET).toBe("receiver-secret");
    expect(receiver.SERVICE_BUS_SENDER_CLIENT_SECRET).toBeUndefined();
    expect(projectDeploymentEnvironment("api", source(), {}).SERVICE_BUS_TENANT_ID).toBeUndefined();
    expect(projectDeploymentEnvironment("storage", source(), {}).SERVICE_BUS_RECEIVER_CLIENT_SECRET).toBeUndefined();
  });
  it("allows each Azure role without the other role's secret", () => {
    const sender = source(); sender.SERVICE_BUS_RECEIVER_CLIENT_SECRET = "";
    expect(serviceBusConfiguration(schema("sender").parse(sender), "sender")).toMatchObject({ driver: "azure", credential: { clientId: senderId, clientSecret: "sender-secret" } });
    const receiver = source(); receiver.SERVICE_BUS_SENDER_CLIENT_SECRET = "";
    expect(serviceBusConfiguration(schema("receiver").parse(receiver), "receiver")).toMatchObject({ credential: { clientId: receiverId, clientSecret: "receiver-secret" } });
  });
  it("composes the actual dispatcher configuration with its sender credentials", () => {
    const env = { ...source(), DATABASE_HOST: "localhost", DATABASE_NAME: "dhumi_test", DATABASE_SSL_MODE: "disable",
      DATABASE_OUTBOX_DISPATCHER_USER: "dhumi_test_outbox_dispatcher_login", DATABASE_OUTBOX_DISPATCHER_PASSWORD: "dispatcher-password-at-least-20-characters", OUTBOX_DISPATCHER_ID: "test-azure-dispatcher" };
    expect(loadOutboxDispatcherConfig(env).serviceBus).toMatchObject({ driver: "azure", credential: { clientId: senderId } });
  });
  it("does not weaken PostgreSQL TLS for an Azure production dispatcher", () => {
    const env = { ...source(), NODE_ENV: "production", DATABASE_HOST: "localhost", DATABASE_NAME: "dhumi_test", DATABASE_SSL_MODE: "disable",
      DATABASE_OUTBOX_DISPATCHER_USER: "dhumi_test_outbox_dispatcher_login", DATABASE_OUTBOX_DISPATCHER_PASSWORD: "dispatcher-password-at-least-20-characters", OUTBOX_DISPATCHER_ID: "test-azure-dispatcher" };
    expect(() => loadOutboxDispatcherConfig(env)).toThrow(/verify-full in production/);
  });
  it.each(["SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE", "SERVICE_BUS_TENANT_ID", "SERVICE_BUS_SENDER_CLIENT_ID", "SERVICE_BUS_SENDER_CLIENT_SECRET"] as const)("rejects missing %s for Azure sender", key => {
    const env = source(); env[key] = ""; expect(schema("sender").safeParse(env).success).toBe(false);
  });
  it("rejects SAS fallback, URLs and localhost for the Azure driver", () => {
    expect(schema("sender").safeParse({ ...source(), SERVICE_BUS_CONNECTION_STRING: "Endpoint=sb://localhost;UseDevelopmentEmulator=true;" }).success).toBe(false);
    for (const fqdn of ["localhost", "https://" + namespace, namespace + "/queue", "evil.example.com"])
      expect(schema("sender").safeParse({ ...source(), SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE: fqdn }).success).toBe(false);
  });
  it("retains production emulator rejection while allowing Azure authentication", () => {
    expect(schema("sender").safeParse({ ...source(), NODE_ENV: "production" }).success).toBe(true);
    expect(schema("sender").safeParse({ ...source(), NODE_ENV: "production", SERVICE_BUS_DRIVER: "emulator", SERVICE_BUS_CONNECTION_STRING: "Endpoint=sb://localhost;UseDevelopmentEmulator=true;" }).success).toBe(false);
  });
  it("uses the sender principal with the same durable event ID and broker metadata", async () => {
    const publisher = createServiceBusJobCommandPublisher(config("sender"));
    await publisher.publish(command);
    expect(ClientSecretCredential).toHaveBeenLastCalledWith(tenantId, senderId, "sender-secret");
    expect(ServiceBusClient).toHaveBeenLastCalledWith(namespace, expect.anything());
    expect(mock.sender.sendMessages).toHaveBeenCalledWith(expect.objectContaining({ body: command, messageId: command.event_id, correlationId: command.aggregate_id, subject: command.topic }));
    await publisher.close(); expect(mock.sender.close).toHaveBeenCalled();
  });
  it("uses the receiver principal with manual peek-lock settlement and explicit renewal", async () => {
    const receiver = createServiceBusJobCommandReceiver(config("receiver"), 2);
    const handler = vi.fn(async (delivery: { renewLock(): Promise<void>; complete(): Promise<void> }) => { await delivery.renewLock(); await delivery.complete(); });
    mock.receiver.subscribe.mockReturnValue({ close: vi.fn() });
    await receiver.subscribe(handler, vi.fn());
    expect(ClientSecretCredential).toHaveBeenLastCalledWith(tenantId, receiverId, "receiver-secret");
    expect(mock.createReceiver).toHaveBeenCalledWith("dhumi-run-commands", { receiveMode: "peekLock" });
    const call = mock.receiver.subscribe.mock.calls.at(-1)!;
    expect(call[1]).toEqual({ autoCompleteMessages: false, maxConcurrentCalls: 2 });
    const message = { body: command, messageId: command.event_id, subject: command.topic, deliveryCount: 1 };
    await call[0].processMessage(message);
    expect(mock.receiver.renewMessageLock).toHaveBeenCalledWith(message);
    expect(mock.receiver.completeMessage).toHaveBeenCalledWith(message);
    await call[0].processMessage({ ...message, messageId: "wrong-event" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mock.receiver.deadLetterMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deadLetterReason: "JOB_COMMAND_INVALID" }));
    await receiver.close();
  });
  it("uses receive-only authentication for the existing explicit DLQ operator path", async () => {
    const receiver = createServiceBusDeadLetterCommandReceiver(config("receiver"));
    expect(ClientSecretCredential).toHaveBeenLastCalledWith(tenantId, receiverId, "receiver-secret");
    expect(mock.createReceiver).toHaveBeenLastCalledWith("dhumi-run-commands", { receiveMode: "peekLock", subQueueType: "deadLetter" });
    await receiver.close();
  });
});
