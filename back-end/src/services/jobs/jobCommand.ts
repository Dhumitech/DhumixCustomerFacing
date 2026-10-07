import { z } from "zod";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());

export const jobCommandEnvelopeSchema = z
  .strictObject({
    event_id: canonicalUuid,
    topic: z.enum(["jobs.execute", "jobs.cancel", "jobs.reconcile", "jobs.recover"]),
    schema_version: z.literal(1),
    aggregate_type: z.literal("run"),
    aggregate_id: canonicalUuid,
    // Version 1 queue envelopes are persistent messages, not database columns.
    tenant_id: canonicalUuid,
    ordering_key: canonicalUuid,
    payload: z.strictObject({ run_id: canonicalUuid,initiated_by_user_id:canonicalUuid.optional(),trace_id:canonicalUuid.optional() }),
  })
  .superRefine((value, context) => {
    if(value.topic==='jobs.execute'&&value.payload.initiated_by_user_id!==undefined)context.addIssue({code:'custom',path:['payload'],message:'Execution command cannot carry a cancellation actor'});
    if (
      value.aggregate_id !== value.ordering_key ||
      value.aggregate_id !== value.payload.run_id
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload", "run_id"],
        message: "Run command identifiers must agree",
      });
    }
  });

export type JobCommandEnvelope = z.infer<typeof jobCommandEnvelopeSchema>;

export function parseJobCommandEnvelope(value: unknown): JobCommandEnvelope {
  return jobCommandEnvelopeSchema.parse(value);
}
