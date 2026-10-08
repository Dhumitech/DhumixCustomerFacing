# Azure Service Bus — connected 8 October 2026

The existing Outbox Dispatcher and Job Manager now use **real Azure Service
Bus**, with the same durable command format, event IDs, manual settlement and
Run fencing. Their active configuration comes from private `back-end/.env.azure`.
OTP remains disabled and collaboration deferred, as the owner requested.

| Resource/configuration | Verified value |
| --- | --- |
| Resource group | `rg-dhumcustomerfacing-centralindia` |
| Subscription / region | `373d10ba-f7db-4db1-938b-14a73655bb0a` / Central India |
| Namespace | `sb-dhumi-ci-01`, Standard |
| Endpoint | `sb-dhumi-ci-01.servicebus.windows.net` |
| Queue | `dhumi-run-commands` |
| TLS / authentication | TLS 1.2 minimum; Microsoft Entra; local/SAS authentication disabled |
| Duplicate detection | Enabled, five-minute window, durable outbox event ID as MessageId |
| Lock / settlement | One-minute peek lock; existing explicit renewal; manual complete/abandon/dead-letter |
| TTL / maximum deliveries | One hour / five, matching the tested emulator settings |
| Expired commands | Dead-lettered |
| Sessions / partitioning | Disabled; PostgreSQL guards Run transitions/fencing |
| Queue size | 1 GB |

Standard supports the required [duplicate detection](https://learn.microsoft.com/en-us/azure/service-bus-messaging/duplicate-detection).
The resource is defined in [service-bus.bicep](service-bus.bicep). Validation and
what-if passed; the incremental deployment created only the namespace and queue.
The existing Storage account, database VM, SQL schemas and networking were unchanged.
The namespace has an authenticated public endpoint; no private endpoint was added.

## Portable credentials in the same env

Two separate Entra applications keep [permissions scoped to this queue](https://learn.microsoft.com/en-us/azure/service-bus-messaging/authenticate-application):

| Application | Role | Backend process |
| --- | --- | --- |
| `app-dhumi-outbox-ci-01` | Azure Service Bus Data Sender | Outbox Dispatcher only |
| `app-dhumi-jobs-ci-01` | Azure Service Bus Data Receiver | Job Manager; explicit receiver/DLQ tools when authorized |

Neither has namespace management, subscription Contributor or the other role.
They are independent of the Blob service principal and PostgreSQL credentials.
The one-year credential expiry is recorded in the restricted provisioning receipt;
keep renewal part of the deployment handoff. No existing password was reset.

The populated master includes `SERVICE_BUS_DRIVER=azure`, the fully qualified
namespace, `SERVICE_BUS_RUN_COMMAND_QUEUE=dhumi-run-commands`, tenant ID and
separate sender/receiver client IDs and secrets. `SERVICE_BUS_CONNECTION_STRING`
is empty. Share the master privately; the [public structure](backend.env.example)
contains blank secrets. The shared role projector gives only sender credentials
to outbox, only receiver credentials to Job Manager, and none to API/frontend.
Do not paste a SAS key or set `UseDevelopmentEmulator=true` for this Azure driver.

## Checks and activation

From `back-end`:

```powershell
npm run deployment:check
npm run queue:check
```

`queue:check` opens/authenticates a sender link through an empty batch and peeks
with the receiver principal. It sends, locks and consumes no messages; it makes
no SQL, provider or email call. Alternate private file:

```powershell
node --import tsx scripts/azure/check-service-bus.mjs --env=/secure/dhumi/backend.env
```

Before activation, six live delivery assertions passed with two diagnostic
commands and three publish operations: deduplication, explicit lock renewal,
abandon/redelivery, completion and dead-letter round trip. They used unrelated
random identifiers and direct queue adapters; no application Run or database
row was created, and no provider/email call occurred. Primary/DLQ were empty
before/after; no diagnostic messages remain.

The original emulator command queue and DLQ, active Runs and pending SQL commands
were also empty at cutover. Only the two workers were restarted. They now match
the canonical env, authenticate with their respective identities and have no
recorded errors. API/frontend, SQL service, Redis and Blob were retained.
No SQL migration/data/role/password change occurred; **live `leads_engine` and
its other project's environment/services remain untouched**.

Backend build/application and test TypeScript, unit tests and three actual emulator
regressions pass. The previous dependency and lock pins remain enforced; a new
dated fixture permits only the exact owner-authorized deployment/check commands.
Existing emulator tooling remains valid for the separate local stack.

This verifies transport and worker connections. A fresh paid provider Run was
not submitted to test this infrastructure. Owner manual Runs now travel through
Azure SQL outbox → Azure queue → real Job Manager → Azure Blob. Redis and
application/frontend hosting remain local; they are the next deployment work.

For lock/settlement behavior see [Microsoft's guidance](https://learn.microsoft.com/en-us/azure/service-bus-messaging/message-transfers-locks-settlement).
The cached skill index dates from May 2026; refresh it upstream when maintaining
the tooling. The optional [Microsoft Docs MCP](https://github.com/MicrosoftDocs/mcp/blob/main/README.md)
can supply current references; this change verified the current Microsoft pages directly.
