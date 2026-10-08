import { z } from "zod";
const optionalValue = <T extends z.ZodType>(schema: T) =>
  z.preprocess(value => value === "" ? undefined : value, schema.optional());

export const serviceBusEnvironmentShape = {
  SERVICE_BUS_DRIVER: z.enum(["emulator", "azure"]),
  SERVICE_BUS_CONNECTION_STRING: optionalValue(z.string().trim().min(1).max(2_048)),
  SERVICE_BUS_RUN_COMMAND_QUEUE: z.string().trim().regex(/^[a-z0-9](?:[a-z0-9._-]{0,48}[a-z0-9])?$/).default("dhumi-run-commands"),
  SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE: optionalValue(z.string().regex(/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/)),
  SERVICE_BUS_TENANT_ID: optionalValue(z.uuid()),
  SERVICE_BUS_SENDER_CLIENT_ID: optionalValue(z.uuid()),
  SERVICE_BUS_SENDER_CLIENT_SECRET: optionalValue(z.string().min(1).max(2_048)),
  SERVICE_BUS_RECEIVER_CLIENT_ID: optionalValue(z.uuid()),
  SERVICE_BUS_RECEIVER_CLIENT_SECRET: optionalValue(z.string().min(1).max(2_048)),
};
type Environment = z.infer<z.ZodObject<typeof serviceBusEnvironmentShape>> & {
  readonly NODE_ENV: "development" | "test" | "production";
};
export function addServiceBusChecks(value: Environment, context: z.RefinementCtx, role: "sender" | "receiver"): void {
  const issue = (name: string, message: string) => context.addIssue({ code: "custom", path: [name], message });
  if (value.SERVICE_BUS_DRIVER === "emulator") {
    if (value.NODE_ENV === "production") issue("SERVICE_BUS_DRIVER", "the local Service Bus emulator is forbidden in production");
    const connection = value.SERVICE_BUS_CONNECTION_STRING ?? "";
    if (!/(?:^|;)UseDevelopmentEmulator=true(?:;|$)/i.test(connection) ||
        !/(?:^|;)Endpoint=sb:\/\/(?:localhost|127\.0\.0\.1)(?:[:/;])/i.test(connection))
      issue("SERVICE_BUS_CONNECTION_STRING", "must be a loopback emulator connection string");
    return;
  }
  if (value.SERVICE_BUS_CONNECTION_STRING) issue("SERVICE_BUS_CONNECTION_STRING", "must be unset for Azure Entra authentication");
  const names = role === "sender"
    ? ["SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE", "SERVICE_BUS_TENANT_ID", "SERVICE_BUS_SENDER_CLIENT_ID", "SERVICE_BUS_SENDER_CLIENT_SECRET"] as const
    : ["SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE", "SERVICE_BUS_TENANT_ID", "SERVICE_BUS_RECEIVER_CLIENT_ID", "SERVICE_BUS_RECEIVER_CLIENT_SECRET"] as const;
  for (const name of names) if (!value[name]) issue(name, "is required for this Azure Service Bus role");
}
export interface ServiceBusEmulatorRuntimeConfig {
  readonly driver: "emulator";
  readonly connectionString: string;
  readonly queueName: string;
}
export type ServiceBusRuntimeConfig = ServiceBusEmulatorRuntimeConfig | {
  readonly driver: "azure";
  readonly fullyQualifiedNamespace: string;
  readonly queueName: string;
  readonly credential: { readonly tenantId: string; readonly clientId: string; readonly clientSecret: string };
};
export function serviceBusConfiguration(value: Environment, role: "sender" | "receiver"): ServiceBusRuntimeConfig {
  if (value.SERVICE_BUS_DRIVER === "emulator") return Object.freeze({ driver: "emulator", connectionString: value.SERVICE_BUS_CONNECTION_STRING as string, queueName: value.SERVICE_BUS_RUN_COMMAND_QUEUE });
  return Object.freeze({ driver: "azure", fullyQualifiedNamespace: value.SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE as string,
    queueName: value.SERVICE_BUS_RUN_COMMAND_QUEUE, credential: Object.freeze({ tenantId: value.SERVICE_BUS_TENANT_ID as string,
      clientId: (role === "sender" ? value.SERVICE_BUS_SENDER_CLIENT_ID : value.SERVICE_BUS_RECEIVER_CLIENT_ID) as string,
      clientSecret: (role === "sender" ? value.SERVICE_BUS_SENDER_CLIENT_SECRET : value.SERVICE_BUS_RECEIVER_CLIENT_SECRET) as string }) });
}
