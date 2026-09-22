# ADR 0001: Validate caller correlation IDs and fall back safely

Status: Accepted

## Context

The public contract permits a caller to send an optional `X-Request-ID` and
requires Dhumi to return an accepted or generated correlation ID. Fastify can
consume a request-ID header automatically, but it does not validate the caller
value. Rejecting a malformed optional correlation header would also add a new
business-response status to every operation.

## Decision

Keep Fastify's automatic `requestIdHeader` option disabled. Dhumi's custom
request-ID generator accepts the caller value only when it matches the
OpenAPI length and safe-character rules. Missing or invalid values are replaced
with a server-generated UUID. The final accepted/generated ID is used in logs,
Problem responses and the `X-Request-ID` response header.

An invalid optional correlation ID does not reject an otherwise valid business
request.

## Consequences

- Arbitrary caller text cannot become the structured-log request ID.
- Existing operation response sets do not gain an undeclared `400` or `422`.
- Clients that need end-to-end correlation must send a value matching the
  published OpenAPI schema and use the ID returned by Dhumi.
- The server-generated UUID remains authoritative whenever input is absent or
  invalid.
