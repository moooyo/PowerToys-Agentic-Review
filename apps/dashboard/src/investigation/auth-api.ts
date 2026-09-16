import {
  type InvestigationAccount,
  InvestigationAccountListSchema,
  InvestigationAccountSchema,
  type InvestigationChangePasswordRequest,
  InvestigationChangePasswordRequestSchema,
  type InvestigationCreateAccountRequest,
  InvestigationCreateAccountRequestSchema,
  type InvestigationLoginRequest,
  InvestigationLoginRequestSchema,
  type InvestigationResetAccountPasswordRequest,
  InvestigationResetAccountPasswordRequestSchema,
  type InvestigationSession,
  InvestigationSessionSchema,
  type InvestigationUpdateAccountRequest,
  InvestigationUpdateAccountRequestSchema,
} from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createSampleAuthApi } from "./sample-auth";
import { createHttpTransport, InvestigationHttpError } from "./transport";

export type Account = InvestigationAccount;
export type CreateAccountInput = InvestigationCreateAccountRequest;
export type UpdateAccountInput = InvestigationUpdateAccountRequest;
export type ResetPasswordInput = InvestigationResetAccountPasswordRequest;
export type PasswordLoginInput = InvestigationLoginRequest;
export type PasswordChangeInput = InvestigationChangePasswordRequest;
export type { InvestigationSession };

export interface AuthApi {
  session(): Promise<InvestigationSession>;
  login(input: PasswordLoginInput): Promise<InvestigationSession>;
  logout(): Promise<void>;
  changePassword(input: PasswordChangeInput): Promise<void>;
  listAccounts(): Promise<{ items: Account[] }>;
  createAccount(input: CreateAccountInput): Promise<Account>;
  updateAccount(id: string, input: UpdateAccountInput): Promise<Account>;
  resetAccountPassword(id: string, input: ResetPasswordInput): Promise<Account>;
}

export function decodeSession(value: unknown): InvestigationSession {
  if (!Value.Check(InvestigationSessionSchema, value))
    throw new Error("The account service returned an invalid session.");
  return value;
}

function requestInput<T extends TSchema>(schema: T, value: Static<T>): Static<T> {
  if (!Value.Check(schema, value))
    throw new InvestigationHttpError(
      400,
      "The account form contains invalid values. Review the highlighted requirements.",
    );
  return value;
}

export function createHttpAuthApi(fetcher: typeof fetch = fetch): AuthApi {
  const protectedRequest = createHttpTransport(fetcher);
  const request = async (path: string, body?: unknown): Promise<Response> => {
    const response = await fetcher(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let message =
        response.status === 401
          ? path === "/api/auth/login"
            ? "The username or password is incorrect."
            : path === "/api/auth/password"
              ? "The current password could not be verified. Try again."
              : "Your session expired. Sign in again."
          : response.status === 429
            ? "Too many sign-in attempts. Wait before trying again."
            : `The account request failed (${response.status}).`;
      const detail: unknown = await response.json().catch(() => null);
      if (
        response.status !== 401 &&
        typeof detail === "object" &&
        detail !== null &&
        "message" in detail &&
        typeof detail.message === "string"
      )
        message = detail.message;
      throw new InvestigationHttpError(response.status, message);
    }
    return response;
  };
  const expectEmpty = async (path: string, body: unknown): Promise<void> => {
    const response = await request(path, body);
    if (response.status !== 204)
      throw new Error("The account service did not confirm the requested session change.");
  };
  return {
    session: async () => decodeSession(await (await request("/api/auth/session")).json()),
    login: async (input) =>
      decodeSession(
        await (
          await request("/api/auth/login", requestInput(InvestigationLoginRequestSchema, input))
        ).json(),
      ),
    logout: () => expectEmpty("/api/auth/logout", {}),
    changePassword: (input) =>
      expectEmpty(
        "/api/auth/password",
        requestInput(InvestigationChangePasswordRequestSchema, input),
      ),
    listAccounts: () => protectedRequest("/api/accounts", InvestigationAccountListSchema),
    createAccount: (input) =>
      protectedRequest("/api/accounts", InvestigationAccountSchema, {
        method: "POST",
        body: requestInput(InvestigationCreateAccountRequestSchema, input),
      }),
    updateAccount: (id, input) =>
      protectedRequest(
        `/api/accounts/${encodeURIComponent(id)}/update`,
        InvestigationAccountSchema,
        { method: "POST", body: requestInput(InvestigationUpdateAccountRequestSchema, input) },
      ),
    resetAccountPassword: (id, input) =>
      protectedRequest(
        `/api/accounts/${encodeURIComponent(id)}/password`,
        InvestigationAccountSchema,
        {
          method: "POST",
          body: requestInput(InvestigationResetAccountPasswordRequestSchema, input),
        },
      ),
  };
}

export const authApi: AuthApi =
  process.env.NODE_ENV === "development" ? createSampleAuthApi() : createHttpAuthApi();
