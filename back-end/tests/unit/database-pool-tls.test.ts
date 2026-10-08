import type { ConnectionOptions, PeerCertificate } from "node:tls";
import { describe, expect, it } from "vitest";
import { createOutboxDispatcherPool } from "../../src/services/database/pools.js";

describe("database pool endpoint verification", () => {
  it.each(["20.244.41.57", "database.example"])("verifies the configured endpoint %s even when the TLS library supplies localhost", async host => {
    const pool = createOutboxDispatcherPool({
      host, port: 5432, database: "dhumi_test", credential: { user: "dhumi_test_outbox_dispatcher_login", password: "test-only-password" },
      poolMin: 0, poolMax: 1, connectionTimeoutMs: 1000, idleTimeoutMs: 1000,
      statementTimeoutMs: 1000, queryTimeoutMs: 1000, idleTransactionTimeoutMs: 1000,
      ssl: { ca: "test-only-public-ca", rejectUnauthorized: true },
    }, () => {});
    try {
      const ssl = pool.options.ssl as ConnectionOptions;
      expect(ssl.rejectUnauthorized).toBe(true);
      const certificate = { subject: { CN: "localhost" }, subjectaltname: "DNS:localhost" } as PeerCertificate;
      expect(ssl.checkServerIdentity!("localhost", certificate)).toBeInstanceOf(Error);
      certificate.subjectaltname = host === "20.244.41.57" ? `IP Address:${host}` : `DNS:${host}`;
      expect(ssl.checkServerIdentity!("localhost", certificate)).toBeUndefined();
    } finally { await pool.end(); }
  });
});
