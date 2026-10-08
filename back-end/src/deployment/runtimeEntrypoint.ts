import { readFile } from "node:fs/promises";

const role = process.argv[2];
if (!["api", "outbox", "jobs", "restore-results"].includes(role ?? "")) throw new Error("Unknown demo process role");
const settings: unknown = JSON.parse(await readFile("/run/secrets/runtime.json", "utf8"));
if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Invalid mounted runtime settings");
for (const [key, value] of Object.entries(settings)) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string" || /^POSTGRES_|^PGPASSWORD$/.test(key)) throw new Error("Runtime settings contain an unsupported value");
  if (role !== "jobs" && /^(BRIGHTDATA_API_KEY|PROVIDER_REFERENCE_LOCAL_KEY)$/.test(key)) throw new Error("Provider secrets belong only to the Job Manager");
  process.env[key] = value;
}
if (process.env.NODE_ENV !== "test" || process.env.DEMO_DISABLE_OTP !== "true") throw new Error("This entrypoint is for the explicit hosted demo profile");
if (role === "api") await import("../server.js");
else if (role === "outbox") { const { startOutboxDispatcher } = await import("../worker/outboxDispatcher.js"); await startOutboxDispatcher(); }
else if (role === "jobs") {
  if (process.env.RUN_EXECUTOR_DRIVER !== "bright_data") throw new Error("Hosted demo requires the real executor");
  const { startJobManager } = await import("../worker/jobManager.js"); await startJobManager();
} else await import("./restoreResults.js");
