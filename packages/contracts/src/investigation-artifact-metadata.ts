import { type Static, Type } from "@sinclair/typebox";
import { DateTimeSchema } from "./common.js";
import { InvestigationArtifactV1Schema } from "./investigation.js";

// Current storage state is separate from the immutable artifact snapshot in a report.
export const InvestigationArtifactMetadataV1Schema = Type.Object(
  {
    artifact: InvestigationArtifactV1Schema,
    storedAt: DateTimeSchema,
    expiredAt: Type.Union([DateTimeSchema, Type.Null()]),
    retentionProtected: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type InvestigationArtifactMetadataV1 = Static<typeof InvestigationArtifactMetadataV1Schema>;
