import { type Static, Type } from "@sinclair/typebox";
import {
  DateTimeSchema,
  EntityIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "./common.js";

// Authorization uses this exact, case-sensitive identity pair, never an email or display name.
export const OperatorPrincipalSchema = Type.Object(
  {
    issuer: Type.String({ minLength: 1, maxLength: 2_048 }),
    subject: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);
export type OperatorPrincipal = Static<typeof OperatorPrincipalSchema>;

export const OperatorRepositoryRoleSchema = Type.Union([
  Type.Literal("viewer"),
  Type.Literal("reviewer"),
  Type.Literal("maintainer"),
  Type.Literal("admin"),
]);
export type OperatorRepositoryRole = Static<typeof OperatorRepositoryRoleSchema>;

export const OperatorRepositoryPermissionSchema = Type.Union([
  Type.Literal("read"),
  Type.Literal("review"),
  Type.Literal("configure"),
  Type.Literal("manage_access"),
]);
export type OperatorRepositoryPermission = Static<typeof OperatorRepositoryPermissionSchema>;

export const OperatorAccessContextSchema = Type.Object(
  {
    principal: OperatorPrincipalSchema,
    platformAdministrator: Type.Boolean(),
    repository: Type.Union([
      Type.Null(),
      Type.Object(
        {
          repositoryId: EntityIdSchema,
          role: OperatorRepositoryRoleSchema,
          source: Type.Union([Type.Literal("platform"), Type.Literal("repository")]),
          permissions: Type.Array(OperatorRepositoryPermissionSchema, {
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
          }),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
export type OperatorAccessContext = Static<typeof OperatorAccessContextSchema>;

export const RepositoryAccessGrantSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    principal: OperatorPrincipalSchema,
    // Revocation retains a tombstone/version so a stale writer cannot recreate old access.
    role: Type.Union([OperatorRepositoryRoleSchema, Type.Null()]),
    version: PositiveIntegerSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    updatedBy: OperatorPrincipalSchema,
  },
  { additionalProperties: false },
);
export type RepositoryAccessGrant = Static<typeof RepositoryAccessGrantSchema>;

export const RepositoryAccessChangeRequestSchema = Type.Object(
  {
    changeId: EntityIdSchema,
    principal: OperatorPrincipalSchema,
    role: Type.Union([OperatorRepositoryRoleSchema, Type.Null()]),
    expectedVersion: NonNegativeIntegerSchema,
    reason: Type.String({ minLength: 1, maxLength: 2_048 }),
  },
  { additionalProperties: false },
);
export type RepositoryAccessChangeRequest = Static<typeof RepositoryAccessChangeRequestSchema>;

export const RepositoryAccessAuditSchema = Type.Object(
  {
    id: EntityIdSchema,
    repositoryId: EntityIdSchema,
    changeId: EntityIdSchema,
    principal: OperatorPrincipalSchema,
    actor: OperatorPrincipalSchema,
    previousRole: Type.Union([OperatorRepositoryRoleSchema, Type.Null()]),
    role: Type.Union([OperatorRepositoryRoleSchema, Type.Null()]),
    previousVersion: NonNegativeIntegerSchema,
    version: PositiveIntegerSchema,
    reason: Type.String({ minLength: 1, maxLength: 2_048 }),
    createdAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type RepositoryAccessAudit = Static<typeof RepositoryAccessAuditSchema>;

export const RepositoryAccessChangeResponseSchema = Type.Object(
  {
    // This immutable receipt describes the accepted change, not the current membership.
    change: RepositoryAccessAuditSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type RepositoryAccessChangeResponse = Static<typeof RepositoryAccessChangeResponseSchema>;

const pageProperties = {
  repositoryId: EntityIdSchema,
  page: PositiveIntegerSchema,
  pageSize: Type.Integer({ minimum: 1, maximum: 50 }),
  total: NonNegativeIntegerSchema,
};
export const RepositoryAccessListResponseSchema = Type.Object(
  { ...pageProperties, items: Type.Array(RepositoryAccessGrantSchema, { maxItems: 50 }) },
  { additionalProperties: false },
);
export type RepositoryAccessListResponse = Static<typeof RepositoryAccessListResponseSchema>;

export const RepositoryAccessAuditListResponseSchema = Type.Object(
  { ...pageProperties, items: Type.Array(RepositoryAccessAuditSchema, { maxItems: 50 }) },
  { additionalProperties: false },
);
export type RepositoryAccessAuditListResponse = Static<
  typeof RepositoryAccessAuditListResponseSchema
>;
