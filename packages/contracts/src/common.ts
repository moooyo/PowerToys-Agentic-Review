import { type Static, Type } from "@sinclair/typebox";

export const ProtocolVersionSchema = Type.Literal("1.0");
export type ProtocolVersion = Static<typeof ProtocolVersionSchema>;

export const EntityIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
export type EntityId = Static<typeof EntityIdSchema>;

export const DateTimeSchema = Type.String({ format: "date-time" });
export type DateTime = Static<typeof DateTimeSchema>;

export const Sha256Schema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}$",
});
export type Sha256 = Static<typeof Sha256Schema>;

export const GitObjectIdSchema = Type.String({
  minLength: 40,
  maxLength: 64,
  pattern: "^[a-f0-9]{40,64}$",
});
export type GitObjectId = Static<typeof GitObjectIdSchema>;

export const GitHubRepositoryNameSchema = Type.String({
  minLength: 3,
  maxLength: 201,
  pattern: "^[^/\\s]+/[^/\\s]+$",
});
export type GitHubRepositoryName = Static<typeof GitHubRepositoryNameSchema>;

export const NonNegativeIntegerSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
export const PositiveIntegerSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const GitHubNumericIdSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});
export type GitHubNumericId = Static<typeof GitHubNumericIdSchema>;

export const ErrorDetailsSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 128 }),
    message: Type.String({ minLength: 1, maxLength: 2_048 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ErrorDetails = Static<typeof ErrorDetailsSchema>;
