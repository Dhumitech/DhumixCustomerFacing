# Dataset Marketplace demo showcase — 8 October 2026

The owner selected catalogue cards with Coming soon. This supersedes the earlier
interactive Marketplace scope for this demo frontend only.

- Keep Dataset Marketplace in the existing workspace navigation and theme.
- Show the already scoped LinkedIn People and LinkedIn Posts collections as
  static cards, each marked Coming soon. Do not invent row counts, prices,
  availability claims, sample records or new dataset products.
- Explain that previews, downloads and access requests are deferred. Do not
  expose buttons, links or search controls that imply those actions work now.
- All Marketplace routes, including previous dataset/group deep links, resolve
  to the showcase inside the existing authenticated organization boundary.
- The page issues no Marketplace catalogue/sample/enquiry/provider requests.
  Normal workspace/organization/session reads remain unchanged.
- Retain the earlier frontend sample components, backend endpoints, database
  data and applied SQL for the later release. Existing code does not authorize
  re-enabling them in this demo navigation.

Use the root front-end package. Qualify route behavior with existing auth/tenant
guards, frontend tests/build and browser appearance. No new dependency, SQL
migration, credential change, worker restart or external call is required.
The separate older packaged rehearsal needs rebuilding from this root source
before releasing this correction; local HMR is not a cloud deployment.
