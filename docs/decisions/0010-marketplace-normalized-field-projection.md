# Marketplace normalized field projection

Recorded: 2026-09-12. Decision: accepted for the customer-disabled Marketplace
adapter and all later paid-export work.

## Evidence

- Bright Data's Marketplace customization documentation says customers may
  choose the fields included in a dataset view or export.
- `GET /datasets/{dataset_id}/metadata` is the provider source for available
  field names, types, active state and descriptions.
- The documented public `POST /datasets/filter` payload contains
  `dataset_id`, `records_limit` and `filter`; it exposes no selected-field
  projection property.
- The provider documents incomplete fill rates for some fields. A field's
  missing-value behavior therefore has to be explicit in Dhumi's versioned
  output schema.
- Dhumi already retains exact provider bytes as a private `raw` Artifact and a
  separately validated customer-facing `normalized` Artifact.

Sources:

- `Project Specs/08_References/Bright_Data_Local_Docs/Marketplace Dataset API/Brief/Customization and filtering.md`
- `Project Specs/08_References/Bright_Data_Local_Docs/Marketplace Dataset API/Apis/Get dataset metadata.md`
- `Project Specs/08_References/Bright_Data_Local_Docs/Marketplace Dataset API/Apis/Filter dataset (BETA).md`

## Decision

1. A future Marketplace Service configuration must pin `selected_fields` as
   an ordered array of 1-100 unique exact field names.
2. Each selected name must exist in that immutable Template version's reviewed
   output field dictionary. Inactive, suppressed, unknown and duplicated names
   are rejected before provider submission.
3. The normalized Artifact contains exactly the selected fields in the selected
   order. Provider-only and unselected properties are not copied.
4. A missing selected value becomes `null`. The pinned per-field JSON Schema
   must explicitly permit `null`; otherwise normalization fails closed. This
   prevents a missing required value from being silently accepted.
5. The raw Artifact remains the exact downloaded provider bytes. Field
   selection never changes the provider Filter payload and never rewrites raw
   evidence.
6. The immutable Template/output schema version identifies field meaning and
   type. A SHA-256 projection fingerprint binds the Template slug/version,
   schema version and ordered selection without creating a new schema version
   for every customer selection.
7. The selected list remains traceable through the immutable Service version;
   the Run pins that Service version and the normalized Artifact records the
   output schema version.
8. Field aliases/renames are outside this first contract. They require a
   separately versioned public property and collision rules.

## Implemented boundary

`back-end/src/services/brightdata/marketplace/marketplaceResultNormalizer.ts`
implements the customer-disabled normalizer primitive. It:

- accepts only bounded, uncompressed JSON snapshot content;
- supports the documented single-object JSON shape and JSON arrays;
- projects only reviewed selected fields;
- validates the projected array against the pinned field schemas;
- emits deterministic JSON plus schema and projection identities;
- fails closed for an invalid contract, selection or provider value.

Focused unit tests use only synthetic input. No provider request, database
migration, public API change, Template publication or customer execution was
introduced by this decision.

## Field-count boundary

This decision is dictionary-driven and is not limited to three example fields.
It can select any field in a future reviewed LinkedIn Posts dictionary, up to
the public 100-field selection ceiling. The repository currently proves only
the synthetic `url` and `text` fixture dictionary. Neither the screenshot's
historical count nor an asserted 32-field count is treated as schema evidence.
The exact provider dictionary must be captured and reviewed before it is
published in a new immutable Template version.
