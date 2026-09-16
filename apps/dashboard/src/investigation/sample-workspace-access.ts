import type {
  ActionContextV1,
  InvestigationAccountPermission,
  InvestigationActionIntentV1,
  InvestigationActionKind,
  InvestigationSession,
} from "@agentic-review/contracts";
import type { InvestigationApi } from "./api";
import { InvestigationHttpError } from "./transport";

type User = NonNullable<InvestigationSession["user"]>;
type Grant = {
  permission: InvestigationAccountPermission;
  action?: InvestigationActionKind;
  execution?: boolean;
};

function forbidden(): never {
  throw new InvestigationHttpError(
    403,
    "Your account does not have permission for this operation.",
  );
}

function requiresTaskCreation(action: InvestigationActionKind): boolean {
  return action === "start-task" || action === "reviews.verify";
}

function canPerform(user: User, grant: Grant): boolean {
  return (
    user.permissions.includes(grant.permission) &&
    (!grant.execution || user.allowRepositoryExecution) &&
    (grant.action === undefined ||
      (user.actionCapabilities.includes(grant.action) &&
        (!requiresTaskCreation(grant.action) || user.permissions.includes("task:create"))))
  );
}

function authorize(user: User, repositoryId: string, grant?: Grant): void {
  if (!user.repositoryIds.includes(repositoryId) || (grant && !canPerform(user, grant)))
    forbidden();
}

function scopeActionContext(context: ActionContextV1, user: User): ActionContextV1 {
  const scoped = structuredClone(context);
  scoped.actor = { id: user.id, displayName: user.displayName };
  scoped.fixedActions = scoped.fixedActions.map((entry) => {
    const allowed = canPerform(user, { permission: "action:prepare", action: entry.action });
    return {
      ...entry,
      allowed: entry.allowed && allowed,
      reason: allowed ? entry.reason : "Your account cannot prepare this action.",
      guards: [
        ...entry.guards,
        {
          code: "sample_account_prepare",
          satisfied: allowed,
          message: "Preparing this action requires the account's matching business permissions.",
        },
      ],
    };
  });
  scoped.nextActions = scoped.nextActions.map((entry) => {
    const prepare = canPerform(user, { permission: "action:prepare", action: entry.action });
    const execute = canPerform(user, { permission: "action:execute", action: entry.action });
    return {
      ...entry,
      allowed: entry.allowed && prepare && execute,
      canPrepare: entry.canPrepare && prepare,
      readyToExecute: entry.readyToExecute && prepare && execute,
      guards: [
        ...entry.guards,
        {
          code: "sample_account_prepare",
          satisfied: prepare,
          message: "Preparing this action requires the account's matching business permissions.",
        },
        {
          code: "sample_account_execute",
          satisfied: execute,
          message: "Confirming this action requires the account's matching business permissions.",
        },
      ],
    };
  });
  return scoped;
}

// This facade scopes the isolated Development data to the current password session.
// The underlying adapter retains ownership of synthetic state and never starts a worker.
export function createSessionScopedSampleApi(
  api: InvestigationApi,
  session: () => Promise<InvestigationSession>,
  onExpired?: () => void,
): InvestigationApi {
  let intentOwners: Map<string, { actorId: string; idempotencyKey: string }> | undefined;

  function expired(): never {
    onExpired?.();
    throw new InvestigationHttpError(401, "Your session expired. Sign in again.");
  }

  async function currentUser(expectedId?: string): Promise<User> {
    let value: InvestigationSession;
    try {
      value = await session();
    } catch (error) {
      if (error instanceof InvestigationHttpError && error.status === 401) onExpired?.();
      throw error;
    }
    if (!value.authenticated || (expectedId !== undefined && value.user.id !== expectedId))
      expired();
    return structuredClone(value.user);
  }

  async function currentAccess(user: User, repositoryId: string, grant?: Grant): Promise<User> {
    const current = await currentUser(user.id);
    authorize(current, repositoryId, grant);
    return current;
  }

  async function result<T>(user: User, value: T, repositoryId: string, grant?: Grant): Promise<T> {
    await currentAccess(user, repositoryId, grant);
    return structuredClone(value);
  }

  function requireGrant(user: User, grant: Grant): void {
    if (!canPerform(user, grant)) forbidden();
  }

  async function workItem(user: User, id: string) {
    const item = await api.workItem(id);
    await currentAccess(user, item.repositoryId);
    return item;
  }

  async function report(user: User, id: string, workItemId?: string) {
    const header = await api.report(id);
    await currentAccess(user, header.context.repository.id);
    if (workItemId !== undefined && header.context.workItem.id !== workItemId) {
      throw new InvestigationHttpError(409, "The sample report belongs to another work item.");
    }
    return header;
  }

  function scopedKey(user: User, key: string): string {
    return `sample-account:${encodeURIComponent(user.id)}:${key}`;
  }

  function ownedIntent(
    user: User,
    value: InvestigationActionIntentV1,
  ): InvestigationActionIntentV1 {
    const owner = intentOwners?.get(value.id);
    const intent = owner ? { ...value, ...owner } : value;
    authorize(user, intent.repositoryId);
    if (intent.actorId !== user.id) forbidden();
    return intent;
  }

  async function readIntent(user: User, id: string): Promise<InvestigationActionIntentV1> {
    const value = await api.actionIntent(id);
    const current = await currentAccess(user, value.repositoryId);
    return ownedIntent(current, value);
  }

  return {
    async repositories() {
      const user = await currentUser();
      const values = await api.repositories();
      const current = await currentUser(user.id);
      return structuredClone({
        items: values.items.filter((item) => current.repositoryIds.includes(item.id)),
      });
    },

    async repositoryWebhookSettings(repositoryId) {
      const user = await currentUser();
      authorize(user, repositoryId);
      const settings = await api.repositoryWebhookSettings(repositoryId);
      return result(user, settings, repositoryId);
    },

    updateRepositoryWebhookSettings(repositoryId, input) {
      const snapshot = structuredClone(input);
      return (async () => {
        const user = await currentUser();
        const grant: Grant = { permission: "repository:manage" };
        await currentAccess(user, repositoryId, grant);
        const settings = await api.updateRepositoryWebhookSettings(repositoryId, snapshot);
        return result(user, settings, repositoryId, grant);
      })();
    },

    async workItems(repositoryId, kind) {
      const user = await currentUser();
      if (repositoryId !== undefined && !user.repositoryIds.includes(repositoryId))
        return { items: [] };
      const values = await api.workItems(repositoryId, kind);
      const current = await currentUser(user.id);
      return structuredClone({
        items: values.items.filter((item) => current.repositoryIds.includes(item.repositoryId)),
      });
    },

    async workItem(id) {
      const user = await currentUser();
      const item = await workItem(user, id);
      return result(user, item, item.repositoryId);
    },

    importWorkItem(repositoryId, input) {
      const snapshot = structuredClone(input);
      return (async () => {
        const user = await currentUser();
        const grant: Grant = { permission: "repository:manage" };
        authorize(user, repositoryId, grant);
        const imported = await api.importWorkItem(repositoryId, snapshot);
        return result(user, imported, imported.workItem.repositoryId, grant);
      })();
    },

    async tasks(workItemId) {
      const user = await currentUser();
      const values = await api.tasks(workItemId);
      const current = await currentUser(user.id);
      return structuredClone({
        items: values.items.filter((item) => current.repositoryIds.includes(item.repository.id)),
      });
    },

    async task(id) {
      const user = await currentUser();
      const detail = await api.task(id);
      const current = await currentAccess(user, detail.task.repository.id);
      return structuredClone({
        ...detail,
        children: detail.children.filter((child) =>
          current.repositoryIds.includes(child.repository.id),
        ),
        latestReport:
          detail.latestReport &&
          current.repositoryIds.includes(detail.latestReport.context.repository.id)
            ? detail.latestReport
            : null,
      });
    },

    createTask(input) {
      const snapshot = structuredClone(input);
      return (async () => {
        const user = await currentUser();
        const grant: Grant = {
          permission: "task:create",
          execution: snapshot.executionMode === "execute",
        };
        requireGrant(user, grant);
        const item = await workItem(user, snapshot.workItemId);
        if (snapshot.parentReportRef) await report(user, snapshot.parentReportRef.id, item.id);
        await currentAccess(user, item.repositoryId, grant);
        const created = await api.createTask({
          ...snapshot,
          idempotencyKey: scopedKey(user, snapshot.idempotencyKey),
        });
        return result(user, created, created.repository.id, grant);
      })();
    },

    resumeTask(id, idempotencyKey, budget) {
      const snapshot = structuredClone(budget);
      return (async () => {
        const user = await currentUser();
        requireGrant(user, { permission: "task:create" });
        const detail = await api.task(id);
        const grant: Grant = {
          permission: "task:create",
          execution: detail.task.executionPolicy.mode === "execute",
        };
        await currentAccess(user, detail.task.repository.id, grant);
        const resumed = await api.resumeTask(id, scopedKey(user, idempotencyKey), snapshot);
        return result(user, resumed, resumed.repository.id, grant);
      })();
    },

    async cancelTask(id) {
      const user = await currentUser();
      const grant: Grant = { permission: "task:cancel" };
      requireGrant(user, grant);
      const detail = await api.task(id);
      await currentAccess(user, detail.task.repository.id, grant);
      const cancelled = await api.cancelTask(id);
      return result(user, cancelled, cancelled.repository.id, grant);
    },

    async report(id) {
      const user = await currentUser();
      const header = await report(user, id);
      return result(user, header, header.context.repository.id);
    },

    async findings(id, cursor, limit) {
      const user = await currentUser();
      const header = await report(user, id);
      await currentAccess(user, header.context.repository.id);
      const page = await api.findings(id, cursor, limit);
      return result(user, page, header.context.repository.id);
    },

    async exportReport(id) {
      const user = await currentUser();
      const header = await report(user, id);
      await currentAccess(user, header.context.repository.id);
      const exported = await api.exportReport(id);
      return result(user, exported, exported.context.repository.id);
    },

    async artifact(id, signal) {
      signal?.throwIfAborted();
      const user = await currentUser();
      const metadata = await api.artifact(id, signal);
      const detail = await api.task(metadata.artifact.taskId);
      const scoped = await result(user, metadata, detail.task.repository.id);
      signal?.throwIfAborted();
      return scoped;
    },

    async actionContext(workItemId, reportId) {
      const user = await currentUser();
      const item = await workItem(user, workItemId);
      if (reportId !== undefined) await report(user, reportId, item.id);
      await currentAccess(user, item.repositoryId);
      const context = await api.actionContext(workItemId, reportId);
      const current = await currentAccess(user, context.repositoryId);
      return scopeActionContext(context, current);
    },

    prepareAction(input) {
      const snapshot = structuredClone(input);
      return (async () => {
        const user = await currentUser();
        const grant: Grant = { permission: "action:prepare", action: snapshot.action };
        requireGrant(user, grant);
        const item = await workItem(user, snapshot.workItemId);
        if (snapshot.reportRef) await report(user, snapshot.reportRef.id, item.id);
        if (snapshot.payload.kind === "navigate" && snapshot.payload.reportRef) {
          await report(user, snapshot.payload.reportRef.id, item.id);
        }
        await currentAccess(user, item.repositoryId, grant);
        const intent = await api.prepareAction({
          ...snapshot,
          idempotencyKey: scopedKey(user, snapshot.idempotencyKey),
        });
        intentOwners ??= new Map();
        intentOwners.set(intent.id, { actorId: user.id, idempotencyKey: snapshot.idempotencyKey });
        return result(user, ownedIntent(user, intent), intent.repositoryId, grant);
      })();
    },

    async actionIntent(id) {
      const user = await currentUser();
      const intent = await readIntent(user, id);
      return result(user, intent, intent.repositoryId);
    },

    async confirmAction(id, version, payloadDigest) {
      const user = await currentUser();
      requireGrant(user, { permission: "action:execute" });
      const intent = await readIntent(user, id);
      const grant: Grant = { permission: "action:execute", action: intent.action };
      await currentAccess(user, intent.repositoryId, grant);
      const confirmed = await api.confirmAction(id, version, payloadDigest);
      const current = await currentAccess(user, confirmed.repositoryId, grant);
      return structuredClone(ownedIntent(current, confirmed));
    },

    async reconcileAction(id) {
      const user = await currentUser();
      requireGrant(user, { permission: "action:execute" });
      const intent = await readIntent(user, id);
      const grant: Grant = { permission: "action:execute", action: intent.action };
      await currentAccess(user, intent.repositoryId, grant);
      const reconciled = await api.reconcileAction(id);
      const current = await currentAccess(user, reconciled.repositoryId, grant);
      return structuredClone(ownedIntent(current, reconciled));
    },
  };
}
