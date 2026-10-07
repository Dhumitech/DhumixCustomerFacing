import Fastify, { type FastifyBaseLogger } from "fastify";
import pino from "pino";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createRequestId, installRequestContext, requestTraceId } from "../../src/middleware/requestContext.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("server request traces for 0073", () => {
  it.each(["customer-request-001", "11111111-1111-4111-8111-111111111111"])(
    "keeps caller %s as correlation only and binds every request log to the server trace",
    async caller => {
      const lines: Record<string, unknown>[] = [];
      const stream = new Writable({ write(chunk, _encoding, done) { lines.push(JSON.parse(String(chunk))); done(); } });
      const app = Fastify({
        loggerInstance: pino({ level: "info" }, stream) as FastifyBaseLogger, genReqId: createRequestId,
        childLoggerFactory(logger, bindings, options, raw) {
          return logger.child({ ...bindings, trace_id: requestTraceId(raw) }, options);
        },
      });
      installRequestContext(app);
      app.get("/test", async request => {
        request.log.info("inside transaction");
        return { trace: request.traceId, correlation: request.id };
      });
      try {
        const responses = await Promise.all([app.inject({ url: "/test", headers: { "x-request-id": caller } }), app.inject({ url: "/test", headers: { "x-request-id": caller } })]);
        const traces = responses.map(response => response.json<{trace:string}>().trace);
        expect(traces[0]).toMatch(uuid); expect(traces[1]).toMatch(uuid);
        expect(traces[0]).not.toBe(traces[1]);
        expect(traces).not.toContain(caller);
        for (const response of responses) expect(response.headers["x-request-id"]).toBe(caller);
        expect(lines).toHaveLength(6);
        for (const trace of traces) {
          const requestLogs = lines.filter(line => line.trace_id === trace);
          expect(requestLogs).toHaveLength(3);
          expect(requestLogs.every(line => line.reqId === caller)).toBe(true);
        }
      } finally { await app.close(); }
    },
  );

  it("uses the same server trace as correlation when the caller header is missing or invalid", async () => {
    const app = Fastify({ genReqId: createRequestId }); installRequestContext(app);
    app.get("/test", async request => ({ trace: request.traceId, correlation: request.id }));
    try {
      for (const headers of [{}, { "x-request-id": "contains spaces" }, { "x-request-id": "short" }]) {
        const response = await app.inject({ url: "/test", headers });
        const body = response.json<{trace:string;correlation:string}>();
        expect(body.trace).toMatch(uuid); expect(body.correlation).toBe(body.trace);
        expect(response.headers["x-request-id"]).toBe(body.trace);
      }
    } finally { await app.close(); }
  });
});
