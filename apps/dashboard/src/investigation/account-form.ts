import {
  InvestigationAccountSchema,
  InvestigationNewPasswordSchema,
  InvestigationUsernameSchema,
  normalizeInvestigationUsername,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { Account, CreateAccountInput, UpdateAccountInput } from "./auth-api";

export const permissionOptions = [
  { value: "repository:manage", label: "Manage repositories" },
  { value: "task:create", label: "Create investigations" },
  { value: "task:cancel", label: "Cancel investigations" },
  { value: "action:prepare", label: "Prepare actions" },
  { value: "action:execute", label: "Execute actions" },
] satisfies { value: Account["permissions"][number]; label: string }[];

export interface AccountFormValues {
  username: string;
  password: string;
  displayName: string;
  enabled: boolean;
  isAdmin: boolean;
  repositoryIdsText: string;
  permissions: Account["permissions"];
  actionCapabilities: Account["actionCapabilities"];
  allowRepositoryExecution: boolean;
}

export type AccountFormField = "username" | "password" | "displayName" | "repositoryIdsText";

export class AccountFormError extends Error {
  constructor(
    public readonly field: AccountFormField,
    message: string,
  ) {
    super(message);
    this.name = "AccountFormError";
  }
}

export function accountFormValues(account?: Account): AccountFormValues {
  return {
    username: account?.username ?? "",
    password: "",
    displayName: account?.displayName ?? "",
    enabled: account?.enabled ?? true,
    isAdmin: account?.isAdmin ?? false,
    repositoryIdsText: account?.repositoryIds.join("\n") ?? "",
    permissions: [...(account?.permissions ?? [])],
    actionCapabilities: [...(account?.actionCapabilities ?? [])],
    allowRepositoryExecution: account?.allowRepositoryExecution ?? false,
  };
}

export function accountFormIsDirty(form: AccountFormValues, account?: Account): boolean {
  const saved = accountFormValues(account);
  const sameValues = (left: readonly string[], right: readonly string[]) => {
    const leftValues = new Set(left);
    const rightValues = new Set(right);
    return (
      leftValues.size === rightValues.size &&
      [...leftValues].every((value) => rightValues.has(value))
    );
  };
  return (
    normalizeInvestigationUsername(form.username) !==
      normalizeInvestigationUsername(saved.username) ||
    form.displayName.trim() !== saved.displayName.trim() ||
    form.password !== "" ||
    form.enabled !== saved.enabled ||
    form.isAdmin !== saved.isAdmin ||
    !sameValues(
      form.repositoryIdsText.split(/[\s,]+/u).filter(Boolean),
      saved.repositoryIdsText.split(/[\s,]+/u).filter(Boolean),
    ) ||
    form.allowRepositoryExecution !== saved.allowRepositoryExecution ||
    !sameValues(form.permissions, saved.permissions) ||
    !sameValues(form.actionCapabilities, saved.actionCapabilities)
  );
}

export type AccountDirectoryFilter = "all" | "enabled" | "disabled";

export function accountDirectoryFilters(search: string): {
  search: string;
  filter: AccountDirectoryFilter;
} {
  const parameters = new URLSearchParams(search);
  const status = parameters.get("status");
  return {
    search: (parameters.get("q") ?? "").slice(0, 200),
    filter: status === "enabled" || status === "disabled" ? status : "all",
  };
}

export function filterAccounts(
  accounts: Account[],
  search: string,
  filter: AccountDirectoryFilter,
): Account[] {
  const query = search.trim().toLocaleLowerCase();
  return accounts.filter(
    (account) =>
      (filter === "all" || (filter === "enabled" ? account.enabled : !account.enabled)) &&
      `${account.displayName} ${account.username}`.toLocaleLowerCase().includes(query),
  );
}

export function parseRepositoryIds(value: string): string[] {
  const ids = [...new Set(value.split(/[\s,]+/u).filter(Boolean))];
  if (!Value.Check(InvestigationAccountSchema.properties.repositoryIds, ids)) {
    throw new AccountFormError(
      "repositoryIdsText",
      "Enter up to 1,024 exact repository IDs, separated by commas or new lines. Wildcards are not supported.",
    );
  }
  return ids;
}

export function assertNewPassword(password: string): void {
  if (!Value.Check(InvestigationNewPasswordSchema, password)) {
    throw new AccountFormError(
      "password",
      "Use a password between 15 and 128 characters, including a non-whitespace character.",
    );
  }
}

export function accountPasswordResetProblems(
  password: string,
  confirmation: string,
  acknowledged: boolean,
) {
  const errors: { password?: string; confirmation?: string; acknowledged?: string } = {};
  try {
    assertNewPassword(password);
  } catch (cause) {
    errors.password = cause instanceof Error ? cause.message : "Enter a valid new password.";
  }
  if (password !== confirmation) errors.confirmation = "The new passwords do not match.";
  if (!acknowledged) errors.acknowledged = "Confirm the session consequence to continue.";
  return errors;
}

function accountAccessInput(form: AccountFormValues) {
  const displayName = form.displayName.trim();
  if (!Value.Check(InvestigationAccountSchema.properties.displayName, displayName)) {
    throw new AccountFormError("displayName", "Enter a display name between 1 and 120 characters.");
  }
  return {
    displayName,
    isAdmin: form.isAdmin,
    repositoryIds: parseRepositoryIds(form.repositoryIdsText),
    permissions: [...form.permissions],
    actionCapabilities: [...form.actionCapabilities],
    allowRepositoryExecution: form.allowRepositoryExecution,
  };
}

export function createAccountInput(form: AccountFormValues): CreateAccountInput {
  const username = normalizeInvestigationUsername(form.username);
  if (!Value.Check(InvestigationUsernameSchema, username)) {
    throw new AccountFormError(
      "username",
      "Use 3–64 letters, numbers, periods, underscores, or hyphens; start with a letter or number.",
    );
  }
  assertNewPassword(form.password);
  return { ...accountAccessInput(form), username, password: form.password };
}

export function updateAccountInput(form: AccountFormValues, version: number): UpdateAccountInput {
  return { ...accountAccessInput(form), enabled: form.enabled, version };
}

export function accountWriteVersion(
  account: Account,
  conflict: boolean,
  latest: Account | undefined,
  reviewed: boolean,
): number {
  if (!conflict) return account.version;
  if (!latest || latest.id !== account.id || !reviewed) {
    throw new Error("Refresh this account and review its current access before trying again.");
  }
  return latest.version;
}

export async function submitAccountForm(
  form: AccountFormValues,
  account: Account | undefined,
  version: number | undefined,
  api: {
    createAccount: (input: CreateAccountInput) => Promise<Account>;
    updateAccount: (id: string, input: UpdateAccountInput) => Promise<Account>;
  },
  clearPassword: () => void,
): Promise<Account> {
  try {
    if (!account) return await api.createAccount(createAccountInput(form));
    return await api.updateAccount(
      account.id,
      updateAccountInput(form, version ?? account.version),
    );
  } finally {
    clearPassword();
  }
}

export async function submitAccountPassword(
  account: Account,
  newPassword: string,
  version: number,
  reset: (id: string, input: { version: number; newPassword: string }) => Promise<Account>,
  clearPassword: () => void,
): Promise<Account> {
  try {
    assertNewPassword(newPassword);
    return await reset(account.id, { version, newPassword });
  } finally {
    clearPassword();
  }
}
