# Marketplace stored-sample download format contract

Status: accepted for the pre-purchase Marketplace sample endpoint, 2026-09-17.

This decision applies to `POST /v1/catalog/templates/{slug}/sample/downloads`.
It does not define a future paid export or a raw-provider-data download.
Both formats contain the same authorized, bounded, selected and pre-purchase-
masked sample rows. Neither format removes masking or initiates provider work.

| Format | Contract | Intended use |
| --- | --- | --- |
| `json` | Preserves the projected JSON field values and types without spreadsheet-formula prefixes. The file is a newly serialized projection, **not** byte-identical source/provider JSON. | Machine ingestion and exact projected values. |
| `csv` | UTF-8 comma-separated table with CRLF rows, quoted/escaped cells and a leading tab inside quoted cells when a value could be interpreted as a spreadsheet formula. Null/undefined cells become empty; non-string values are stringified. Therefore CSV is **not** a lossless interchange format. | Human spreadsheet viewing of the masked sample. |

The `checksum` and `byte_count` in each authorization describe that format's
actual stored bytes. A JSON and CSV download of the same projection need not
have equal checksums or byte counts. The existing Tenant authorization, rate
limit, idempotency, audit and short-lived signed URL apply to both.

The leading-tab mitigation follows [OWASP's CSV Injection guidance](https://owasp.org/www-community/attacks/CSV_Injection),
but OWASP explicitly states that no sanitization strategy is safe for every
spreadsheet application and downstream consumer. Treat downloaded CSV as
untrusted when opening or re-exporting it; use JSON when exact projected values
matter. This is a format contract, not a promise that every spreadsheet program
will preserve the mitigation after editing and saving.

Implementation: `marketplaceSampleDownloadService.ts` serializes both formats;
the OpenAPI request-format description and portal note expose the distinction.
Unit tests cover formula-like CSV cells, their byte-level checksum and
unchanged JSON values. No new endpoint, migration, Bright Data call or billing
change is required for this decision.
