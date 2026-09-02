import { CloneType, type Static, type TSchema, Type } from "@sinclair/typebox";

import { JobExecutionEnvelopeSchema } from "./job-envelope.js";

/**
 * Source-only result-artifact execution envelope. Production Claim remains bound to the
 * version-one envelope until a separately reviewed rollout selects this exact contract.
 */
export const JobExecutionEnvelopeV2Schema = freezeSchema(
  Type.Composite(
    [
      Type.Omit(CloneType(JobExecutionEnvelopeSchema), ["envelopeVersion"]),
      Type.Object(
        {
          envelopeVersion: Type.Literal(2),
          completionMode: Type.Literal("result_artifact_v1"),
        },
        { additionalProperties: false },
      ),
    ],
    { additionalProperties: false },
  ),
);

export type JobExecutionEnvelopeV2 = Static<typeof JobExecutionEnvelopeV2Schema>;

function freezeSchema<TSchemaValue extends TSchema>(schema: TSchemaValue): TSchemaValue {
  const visited = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) {
        freeze(descriptor.value);
      }
    }
    Object.freeze(value);
  };
  freeze(schema);
  return schema;
}
