# Bright Data Integration Boundary

Provider lifecycle recovery now requires migration `0044_provider_poll_checkpoint`.
The original submission Attempt holds the durable read deadline, retry wait,
classified provider state and consecutive failure budget. See
`docs/decisions/0009-provider-lifecycle-synchronization.md` at the repository root
for evidence, result policy and rollout limits. This source change alone does
not update running workers or apply the migration.

Only code in this directory may resolve the provider secret or call Bright
Data. Pattern 5 implements the permanent private transport and fenced Run
executor here. Public routes still cannot import or proxy this boundary.

## Import boundary

`services/identity` and `services/workspace` must never import from this
directory. In the accepted layer-first layout they are siblings, so nothing
structural prevents it; the rule is enforced by
`tests/security/integration-boundary.test.ts`, which fails the build if an
Identity or Workspace module references it.

The default worker driver remains `controlled`. Local `bright_data` execution
requires an explicit non-production driver, the existing Job Manager identity,
an environment-matched protected provider mapping and a secret supplied
through `SecretProvider`. Production rejects the local secret/reference-key
adapters. Real traffic and Template publication remain disabled until the
applicable qualification and deployment evidence gates are approved.

## Marketplace catalogue boundary (M2)

The Marketplace catalogue importer is a privileged, review-first boundary. It
reuses the existing operator identity, protected reference mechanism,
catalogue-import records, candidate records and immutable evidence store. It
does not add a public route, customer grant, database LOGIN or background
service.

Its provider transport permits only the documented read operations:

```http
GET /datasets/list
GET /datasets/{dataset_id}/metadata
```

The first accepted set is exact-name matched to LinkedIn Posts and standard
LinkedIn People. Contact-enriched People remains outside M2. Exact response
bytes and checksums are retained privately; provider Dataset IDs are encrypted
and represented internally by deterministic fingerprints. An omitted provider
`size` is preserved as unknown rather than filled with an inferred count.

Provider mode requires the explicit `--confirm-read-only-provider` switch and
performs exactly three GETs: one list and two metadata reads. Fixture mode makes
zero network calls. Neither mode can Search, Filter, purchase, execute or
publish. Candidate approval creates only an internal immutable `coming_soon`
draft; the public Template pointer remains unchanged until the later M5 gate.
