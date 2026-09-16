import { type Static, type TProperties, Type } from "@sinclair/typebox";
import { DateTimeSchema, EntityIdSchema, PositiveIntegerSchema } from "./common.js";
import { InvestigationActionKindSchema } from "./investigation.js";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const INVESTIGATION_PASSWORD_MIN_LENGTH = 15;
export const INVESTIGATION_PASSWORD_MAX_LENGTH = 128;

export const InvestigationUsernameSchema = Type.String({
  minLength: 3,
  maxLength: 64,
  pattern: "^[a-z0-9][a-z0-9._-]{2,63}$",
});
export const InvestigationUsernameInputSchema = Type.String({
  minLength: 3,
  maxLength: 128,
  pattern: "^\\s*[A-Za-z0-9][A-Za-z0-9._-]{2,63}\\s*$",
});
export function normalizeInvestigationUsername(value: string): string {
  return value.trim().toLowerCase();
}

// TypeBox's value checker counts UTF-16 units for length. The pattern consistently
// limits Unicode scalar values in both runtime validation and the JSON schema.
const passwordScalar = "(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[^\\uD800-\\uDFFF])";
// Passwords are verified exactly as entered, without trimming or case normalization.
export const InvestigationNewPasswordSchema = Type.String({
  minLength: INVESTIGATION_PASSWORD_MIN_LENGTH,
  maxLength: INVESTIGATION_PASSWORD_MAX_LENGTH * 2,
  pattern: `^(?=[\\s\\S]*\\S)${passwordScalar}{${INVESTIGATION_PASSWORD_MIN_LENGTH},${INVESTIGATION_PASSWORD_MAX_LENGTH}}(?![\\s\\S])`,
});
const suppliedPassword = Type.String({
  minLength: 1,
  maxLength: INVESTIGATION_PASSWORD_MAX_LENGTH * 2,
  pattern: `^${passwordScalar}{1,${INVESTIGATION_PASSWORD_MAX_LENGTH}}(?![\\s\\S])`,
});
export const InvestigationAccountPermissionSchema = Type.Union([
  Type.Literal("repository:manage"),
  Type.Literal("task:create"),
  Type.Literal("task:cancel"),
  Type.Literal("action:prepare"),
  Type.Literal("action:execute"),
]);
export type InvestigationAccountPermission = Static<typeof InvestigationAccountPermissionSchema>;

const accessProperties = {
  repositoryIds: Type.Array(EntityIdSchema, { uniqueItems: true, maxItems: 1024 }),
  permissions: Type.Array(InvestigationAccountPermissionSchema, { uniqueItems: true, maxItems: 5 }),
  actionCapabilities: Type.Array(InvestigationActionKindSchema, {
    uniqueItems: true,
    maxItems: 32,
  }),
  allowRepositoryExecution: Type.Boolean(),
};
export const InvestigationAccountAccessSchema = object(accessProperties);
export type InvestigationAccountAccess = Static<typeof InvestigationAccountAccessSchema>;

const accountProperties = {
  id: EntityIdSchema,
  username: InvestigationUsernameSchema,
  displayName: Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" }),
  isAdmin: Type.Boolean(),
  ...accessProperties,
};
export const InvestigationAccountSchema = object({
  ...accountProperties,
  enabled: Type.Boolean(),
  version: PositiveIntegerSchema,
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type InvestigationAccount = Static<typeof InvestigationAccountSchema>;
export const InvestigationAccountListSchema = object({
  items: Type.Array(InvestigationAccountSchema),
});

export const InvestigationSessionUserSchema = object({ ...accountProperties, email: Type.Null() });
export type InvestigationSessionUser = Static<typeof InvestigationSessionUserSchema>;
const sessionProperties = {
  authMode: Type.Literal("password"),
  loginPath: Type.Literal("/api/auth/login"),
};
export const InvestigationSessionSchema = Type.Union([
  object({ ...sessionProperties, authenticated: Type.Literal(false), user: Type.Null() }),
  object({
    ...sessionProperties,
    authenticated: Type.Literal(true),
    user: InvestigationSessionUserSchema,
    expiresAt: DateTimeSchema,
  }),
]);
export type InvestigationSession = Static<typeof InvestigationSessionSchema>;

export const InvestigationLoginRequestSchema = object({
  username: InvestigationUsernameInputSchema,
  password: suppliedPassword,
});
export type InvestigationLoginRequest = Static<typeof InvestigationLoginRequestSchema>;
export const InvestigationChangePasswordRequestSchema = object({
  currentPassword: suppliedPassword,
  newPassword: InvestigationNewPasswordSchema,
});
export type InvestigationChangePasswordRequest = Static<
  typeof InvestigationChangePasswordRequestSchema
>;
export const InvestigationCreateAccountRequestSchema = object({
  username: InvestigationUsernameInputSchema,
  password: InvestigationNewPasswordSchema,
  displayName: accountProperties.displayName,
  isAdmin: Type.Boolean(),
  ...accessProperties,
});
export type InvestigationCreateAccountRequest = Static<
  typeof InvestigationCreateAccountRequestSchema
>;
export const InvestigationUpdateAccountRequestSchema = object({
  version: PositiveIntegerSchema,
  displayName: accountProperties.displayName,
  enabled: Type.Boolean(),
  isAdmin: Type.Boolean(),
  ...accessProperties,
});
export type InvestigationUpdateAccountRequest = Static<
  typeof InvestigationUpdateAccountRequestSchema
>;
export const InvestigationResetAccountPasswordRequestSchema = object({
  version: PositiveIntegerSchema,
  newPassword: InvestigationNewPasswordSchema,
});
export type InvestigationResetAccountPasswordRequest = Static<
  typeof InvestigationResetAccountPasswordRequestSchema
>;
