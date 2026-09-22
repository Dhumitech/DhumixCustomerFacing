# Local Review Exports

This directory may contain private, Git-ignored copies exported for a human
review. It is not a runtime input, output store, recovery source or production
integration surface.

For the local backend, Azurite is the authoritative result/evidence byte store
and PostgreSQL is the authoritative metadata, lifecycle and audit store.
Deleting a review export does not delete the authoritative object. Editing an
export must never change a Run, Artifact, qualification or publication record.

Rules:

- never commit exported provider bytes, credentials, dataset IDs, snapshot IDs
  or customer input;
- never read this directory from application or worker code;
- create exports only through an explicit review operation;
- verify checksum and byte count against the authoritative metadata; and
- use Azure Blob Storage, not this directory, after production cutover.
