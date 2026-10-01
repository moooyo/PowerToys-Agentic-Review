import type {
  ActionContextV1,
  InvestigationAccountPermission,
  InvestigationActionIntentV1,
  InvestigationActionKind,
  InvestigationCommentCommand,
  InvestigationCommentPublicationSummary,
  InvestigationNativePromptCatalog,
  InvestigationPublicationRecoveryStatus,
  InvestigationSession,
  InvestigationWebhookDelivery,
} from "@agentic-review/contracts";
import {
  InvestigationPublicationRecoveryRequestSchema,
  InvestigationWebhookRetryRequestSchema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { InvestigationApi, RepositoryAutoReplySettings } from "./api";
import type { InvestigationReadApi } from "./read-api";
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
  const autoReplyOwners = new Map<
    string,
    { version: number; authorizedById: string | null; updatedById: string | null }
  >();
  const nativePromptOwners = new Map<
    string,
    { version: number; digest: string; createdBy: string }
  >();
  const nativePromptBindingOwners = new Map<string, { version: number; updatedBy: string }>();

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

  function authorizeAutoReply(user: User, repositoryId: string, enabled: boolean): void {
    authorize(user, repositoryId, { permission: "repository:manage" });
    if (enabled) {
      requireGrant(user, { permission: "action:prepare", action: "comment" });
      requireGrant(user, { permission: "action:execute", action: "comment" });
    }
  }

  function scopedAutoReplySettings(
    settings: RepositoryAutoReplySettings,
  ): RepositoryAutoReplySettings {
    const owner = autoReplyOwners.get(settings.repositoryId);
    return owner?.version === settings.version
      ? { ...settings, authorizedById: owner.authorizedById, updatedById: owner.updatedById }
      : settings;
  }

  function scopedNativePrompts(
    value: InvestigationNativePromptCatalog,
  ): InvestigationNativePromptCatalog {
    return {
      ...value,
      items: value.items.map((item) => {
        const bindingOwner = nativePromptBindingOwners.get(`${value.repositoryId}:${item.kind}`);
        return {
          ...item,
          binding:
            bindingOwner?.version === item.binding.version
              ? { ...item.binding, updatedBy: bindingOwner.updatedBy }
              : item.binding,
          versions: item.versions.map((version) => {
            const owner = nativePromptOwners.get(version.id);
            return owner?.version === version.version && owner.digest === version.digest
              ? { ...version, createdBy: owner.createdBy }
              : version;
          }),
        };
      }),
    };
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

  async function scopedDigestKey(user: User, key: string, prefix: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([user.id, key])),
    );
    return `${prefix}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  function scopePublicationRecovery(
    value: InvestigationPublicationRecoveryStatus,
    user: User,
  ): InvestigationPublicationRecoveryStatus {
    const allowed =
      canPerform(user, { permission: "action:prepare", action: "comment" }) &&
      canPerform(user, { permission: "action:execute", action: "comment" });
    return {
      ...value,
      publication: value.publication ? scopeComment(value.publication, user) : null,
      availableActions: allowed ? value.availableActions : [],
    };
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

  function scopeComment(
    value: InvestigationCommentPublicationSummary,
    user: User,
  ): InvestigationCommentPublicationSummary {
    const prepare = canPerform(user, { permission: "action:prepare", action: "comment" });
    const execute = canPerform(user, { permission: "action:execute", action: "comment" });
    return {
      ...value,
      availableActions: value.availableActions.filter(
        (action) => prepare && (action === "reconcile" || execute),
      ),
    };
  }

  async function readComment(user: User, id: string) {
    const value = await api.comment(id);
    const current = await currentAccess(user, value.repositoryId);
    return scopeComment(value, current);
  }

  function authorizeCommentCommand(
    user: User,
    repositoryId: string,
    operation: "sync" | "reconcile",
  ) {
    authorize(user, repositoryId, { permission: "action:prepare", action: "comment" });
    if (operation === "sync")
      requireGrant(user, { permission: "action:execute", action: "comment" });
  }

  async function commentCommand(
    id: string,
    input: InvestigationCommentCommand,
    operation: "sync" | "reconcile",
  ) {
    const user = await currentUser();
    requireGrant(user, { permission: "action:prepare", action: "comment" });
    if (operation === "sync")
      requireGrant(user, { permission: "action:execute", action: "comment" });
    const comment = await readComment(user, id);
    const current = await currentUser(user.id);
    authorizeCommentCommand(current, comment.repositoryId, operation);
    const updated = await (operation === "sync" ? api.syncComment : api.reconcileComment)(id, {
      ...input,
      idempotencyKey: scopedKey(user, input.idempotencyKey),
    });
    const latest = await currentUser(user.id);
    authorizeCommentCommand(latest, updated.repositoryId, operation);
    return structuredClone(scopeComment(updated, latest));
  }

  function webhookRetryGrant(value: InvestigationWebhookDelivery): Grant {
    return { permission: "task:create", execution: value.mode === "e2e" };
  }

  function scopeWebhook(
    value: InvestigationWebhookDelivery,
    user: User,
  ): InvestigationWebhookDelivery {
    const allowed =
      canPerform(user, { permission: "repository:manage" }) &&
      canPerform(user, webhookRetryGrant(value));
    return { ...value, availableActions: allowed ? value.availableActions : [] };
  }

  const publications: InvestigationReadApi["publications"] = async (query = {}, signal) => {
    signal?.throwIfAborted();
    const snapshot = structuredClone(query);
    const user = await currentUser();
    if (snapshot.repositoryId !== undefined) authorize(user, snapshot.repositoryId);
    if (snapshot.workItemId !== undefined) await workItem(user, snapshot.workItemId);
    if (snapshot.taskId !== undefined) {
      const detail = await api.task(snapshot.taskId);
      await currentAccess(user, detail.task.repository.id);
    }
    const value = await api.publications(snapshot, signal);
    const current = await currentUser(user.id);
    if (snapshot.repositoryId !== undefined) authorize(current, snapshot.repositoryId);
    signal?.throwIfAborted();
    return structuredClone({
      ...value,
      items: value.items
        .filter((item) => current.repositoryIds.includes(item.repositoryId))
        .map((item) => scopeComment(item, current)),
    });
  };

  const workItemSnapshot: InvestigationReadApi["workItemSnapshot"] = async (
    id,
    query = {},
    signal,
  ) => {
    signal?.throwIfAborted();
    const snapshot = structuredClone(query);
    const user = await currentUser();
    const item = await workItem(user, id);
    const value = await api.workItemSnapshot(id, snapshot, signal);
    const scoped = await result(user, value, item.repositoryId);
    signal?.throwIfAborted();
    return scoped;
  };

  return {
    async workItemAuthor(id, signal) {
      signal?.throwIfAborted();
      const user = await currentUser();
      const item = await workItem(user, id);
      const value = await api.workItemAuthor(id, signal);
      const scoped = await result(user, value, item.repositoryId);
      signal?.throwIfAborted();
      return scoped;
    },
    async publicationRecovery(taskId, signal) {
      signal?.throwIfAborted();
      const user = await currentUser();
      const detail = await api.task(taskId);
      await currentAccess(user, detail.task.repository.id);
      const value = await api.publicationRecovery(taskId, signal);
      const current = await currentAccess(user, detail.task.repository.id);
      signal?.throwIfAborted();
      return structuredClone(scopePublicationRecovery(value, current));
    },
    async recoverPublication(taskId, input) {
      const snapshot = structuredClone(input);
      const user = await currentUser();
      const prepare: Grant = { permission: "action:prepare", action: "comment" };
      const execute: Grant = { permission: "action:execute", action: "comment" };
      requireGrant(user, prepare);
      requireGrant(user, execute);
      if (!Value.Check(InvestigationPublicationRecoveryRequestSchema, snapshot)) {
        throw new InvestigationHttpError(
          400,
          "The sample publication recovery request is invalid.",
        );
      }
      const detail = await api.task(taskId);
      const idempotencyKey = await scopedDigestKey(
        user,
        snapshot.idempotencyKey,
        "sample-publication-recovery",
      );
      const current = await currentAccess(user, detail.task.repository.id, prepare);
      requireGrant(current, execute);
      const value = await api.recoverPublication(taskId, { ...snapshot, idempotencyKey });
      const latest = await currentAccess(user, detail.task.repository.id, prepare);
      requireGrant(latest, execute);
      return structuredClone(scopePublicationRecovery(value, latest));
    },
    async nativePrompts(repositoryId, signal) {
      signal?.throwIfAborted();
      const user = await currentUser();
      authorize(user, repositoryId);
      const value = await api.nativePrompts(repositoryId, signal);
      const scoped = await result(user, scopedNativePrompts(value), repositoryId);
      signal?.throwIfAborted();
      return scoped;
    },
    async publishNativePrompt(repositoryId, kind, input) {
      const snapshot = structuredClone(input);
      const user = await currentUser();
      const grant: Grant = { permission: "repository:manage" };
      await currentAccess(user, repositoryId, grant);
      const value = await api.publishNativePrompt(repositoryId, kind, snapshot);
      await currentAccess(user, repositoryId, grant);
      nativePromptOwners.set(value.id, {
        version: value.version,
        digest: value.digest,
        createdBy: user.id,
      });
      return structuredClone({ ...value, createdBy: user.id });
    },
    async bindNativePrompt(repositoryId, kind, input) {
      const snapshot = structuredClone(input);
      const user = await currentUser();
      const grant: Grant = { permission: "repository:manage" };
      await currentAccess(user, repositoryId, grant);
      const value = await api.bindNativePrompt(repositoryId, kind, snapshot);
      await currentAccess(user, repositoryId, grant);
      nativePromptBindingOwners.set(`${repositoryId}:${kind}`, {
        version: value.version,
        updatedBy: user.id,
      });
      return structuredClone({ ...value, updatedBy: user.id });
    },
    async repositoryIntakeDetails(repositoryId) {
      const user = await currentUser();
      authorize(user, repositoryId);
      const value = await api.repositoryIntakeDetails(repositoryId);
      return result(user, value, repositoryId);
    },
    async repositoryGitHubUser(repositoryId, lookup) {
      const user = await currentUser();
      authorize(user, repositoryId);
      const value = await api.repositoryGitHubUser(repositoryId, lookup);
      return result(user, value, repositoryId);
    },
    async currentComment(id, signal) {
      signal?.throwIfAborted();
      const user = await currentUser();
      const comment = await readComment(user, id);
      const value = await api.currentComment(id, signal);
      const scoped = await result(user, value, comment.repositoryId);
      signal?.throwIfAborted();
      return scoped;
    },
    async findingSource(reportId, findingId, query = {}, signal) {
      signal?.throwIfAborted();
      const snapshot = structuredClone(query);
      const user = await currentUser();
      const header = await report(user, reportId);
      const value = await api.findingSource(reportId, findingId, snapshot, signal);
      const scoped = await result(user, value, header.context.repository.id);
      signal?.throwIfAborted();
      return scoped;
    },
    async taskDefaults(signal) {
      signal?.throwIfAborted();
      const user = await currentUser();
      const value = await api.taskDefaults(signal);
      await currentUser(user.id);
      signal?.throwIfAborted();
      return structuredClone(value);
    },
    async taskOutput(id, query, signal) {
      signal?.throwIfAborted();
      const snapshot = structuredClone(query);
      const user = await currentUser();
      const detail = await api.task(id);
      await currentAccess(user, detail.task.repository.id);
      const value = await api.taskOutput(id, snapshot, signal);
      const scoped = await result(user, value, detail.task.repository.id);
      signal?.throwIfAborted();
      return scoped;
    },
    async taskArtifacts(id, query = {}, signal) {
      signal?.throwIfAborted();
      const snapshot = structuredClone(query);
      const user = await currentUser();
      const detail = await api.task(id);
      await currentAccess(user, detail.task.repository.id);
      const value = await api.taskArtifacts(id, snapshot, signal);
      const scoped = await result(user, value, detail.task.repository.id);
      signal?.throwIfAborted();
      return scoped;
    },
    async reports(query = {}, signal) {
      signal?.throwIfAborted();
      const snapshot = structuredClone(query);
      const user = await currentUser();
      if (snapshot.repositoryId !== undefined) authorize(user, snapshot.repositoryId);
      if (snapshot.workItemId !== undefined) await workItem(user, snapshot.workItemId);
      if (snapshot.taskId !== undefined) {
        const detail = await api.task(snapshot.taskId);
        await currentAccess(user, detail.task.repository.id);
      }
      const value = await api.reports(snapshot, signal);
      const current = await currentUser(user.id);
      if (snapshot.repositoryId !== undefined) authorize(current, snapshot.repositoryId);
      signal?.throwIfAborted();
      return structuredClone({
        ...value,
        items: value.items.filter((item) =>
          current.repositoryIds.includes(item.context.repository.id),
        ),
      });
    },
    publications,
    publicationDirectory: publications,
    workItemSnapshot,
    workItemDiscussion: workItemSnapshot,
    async workspaceSearch(query, signal) {
      signal?.throwIfAborted();
      const snapshot = structuredClone(query);
      const user = await currentUser();
      if (snapshot.repositoryId !== undefined) authorize(user, snapshot.repositoryId);
      const value = await api.workspaceSearch(snapshot, signal);
      const current = await currentUser(user.id);
      if (snapshot.repositoryId !== undefined) authorize(current, snapshot.repositoryId);
      signal?.throwIfAborted();
      return structuredClone({
        ...value,
        items: value.items.filter((item) => current.repositoryIds.includes(item.repositoryId)),
        truncated: current.repositoryIds.length > 0 && value.truncated,
      });
    },
    async reportMediaPublication(id, signal) {
      signal?.throwIfAborted();
      const user = await currentUser();
      const header = await report(user, id);
      const value = await api.reportMediaPublication(id, signal);
      const scoped = await result(user, value, header.context.repository.id);
      signal?.throwIfAborted();
      return scoped;
    },
    async workers() {
      const user = await currentUser();
      if (!user.isAdmin) forbidden();
      const value = await api.workers();
      const current = await currentUser(user.id);
      if (!current.isAdmin) forbidden();
      return structuredClone(value);
    },
    async updateWorkerE2e(id, input) {
      const snapshot = structuredClone(input);
      const user = await currentUser();
      if (!user.isAdmin) forbidden();
      const value = await api.updateWorkerE2e(id, snapshot);
      const current = await currentUser(user.id);
      if (!current.isAdmin) forbidden();
      return structuredClone(value);
    },
    async webhookDeliveries(query = {}) {
      const snapshot = structuredClone(query);
      const user = await currentUser();
      if (
        snapshot.repositoryId !== undefined &&
        !user.repositoryIds.includes(snapshot.repositoryId)
      )
        return { items: [], nextCursor: null };
      const value = await api.webhookDeliveries(snapshot);
      const current = await currentUser(user.id);
      return structuredClone({
        ...value,
        items: value.items
          .filter((item) => current.repositoryIds.includes(item.repositoryId))
          .map((item) => scopeWebhook(item, current)),
      });
    },
    async webhookDelivery(id) {
      const user = await currentUser();
      const value = await api.webhookDelivery(id);
      const current = await currentAccess(user, value.repositoryId);
      return structuredClone(scopeWebhook(value, current));
    },
    async retryWebhookDelivery(id, input) {
      const snapshot = structuredClone(input);
      const user = await currentUser();
      requireGrant(user, { permission: "repository:manage" });
      requireGrant(user, { permission: "task:create" });
      if (!Value.Check(InvestigationWebhookRetryRequestSchema, snapshot))
        throw new InvestigationHttpError(400, "The webhook retry request is invalid.");
      const idempotencyKey = await scopedDigestKey(user, snapshot.idempotencyKey, "sample-webhook");
      const value = await api.webhookDelivery(id);
      const current = await currentAccess(user, value.repositoryId, webhookRetryGrant(value));
      requireGrant(current, { permission: "repository:manage" });
      const updated = await api.retryWebhookDelivery(id, {
        ...snapshot,
        idempotencyKey,
      });
      const latest = await currentAccess(user, updated.repositoryId, webhookRetryGrant(updated));
      requireGrant(latest, { permission: "repository:manage" });
      return structuredClone(scopeWebhook(updated, latest));
    },
    async scheduler() {
      const user = await currentUser();
      const value = await api.scheduler();
      await currentUser(user.id);
      return structuredClone({ ...value, leases: [] });
    },
    async updateScheduler(input) {
      const snapshot = structuredClone(input);
      const user = await currentUser();
      if (!user.isAdmin) forbidden();
      const value = await api.updateScheduler(snapshot);
      const current = await currentUser(user.id);
      if (!current.isAdmin) forbidden();
      return structuredClone({ ...value, leases: [] });
    },
    async commentDeliveries(query = {}) {
      const snapshot = structuredClone(query);
      const user = await currentUser();
      if (
        snapshot.repositoryId !== undefined &&
        !user.repositoryIds.includes(snapshot.repositoryId)
      )
        return { items: [], nextCursor: null };
      if (snapshot.commentId !== undefined) await readComment(user, snapshot.commentId);
      if (snapshot.taskId !== undefined) {
        const detail = await api.task(snapshot.taskId);
        await currentAccess(user, detail.task.repository.id);
      }
      const values = await api.commentDeliveries(snapshot);
      const current = await currentUser(user.id);
      return structuredClone({
        ...values,
        items: values.items.filter((item) => current.repositoryIds.includes(item.repositoryId)),
      });
    },

    async comments(query = {}) {
      const snapshot = structuredClone(query);
      const user = await currentUser();
      if (
        snapshot.repositoryId !== undefined &&
        !user.repositoryIds.includes(snapshot.repositoryId)
      )
        return { items: [] };
      const values = await api.comments(snapshot);
      const current = await currentUser(user.id);
      return structuredClone({
        items: values.items
          .filter((item) => current.repositoryIds.includes(item.repositoryId))
          .map((item) => scopeComment(item, current)),
      });
    },

    async comment(id) {
      const user = await currentUser();
      return structuredClone(await readComment(user, id));
    },

    async commentAttempts(id, query = {}) {
      const snapshot = structuredClone(query);
      const user = await currentUser();
      const comment = await readComment(user, id);
      await currentAccess(user, comment.repositoryId);
      const values = await api.commentAttempts(id, snapshot);
      return result(user, values, comment.repositoryId);
    },

    syncComment(id, input) {
      return commentCommand(id, structuredClone(input), "sync");
    },

    reconcileComment(id, input) {
      return commentCommand(id, structuredClone(input), "reconcile");
    },

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

    async repositoryAutoReplySettings(repositoryId) {
      const user = await currentUser();
      authorize(user, repositoryId);
      const settings = await api.repositoryAutoReplySettings(repositoryId);
      return result(user, scopedAutoReplySettings(settings), repositoryId);
    },

    updateRepositoryAutoReplySettings(repositoryId, input) {
      const snapshot = structuredClone(input);
      return (async () => {
        const user = await currentUser();
        authorizeAutoReply(user, repositoryId, snapshot.enabled);
        const current = await currentUser(user.id);
        authorizeAutoReply(current, repositoryId, snapshot.enabled);
        const previous = scopedAutoReplySettings(
          await api.repositoryAutoReplySettings(repositoryId),
        );
        const beforeSave = await currentUser(user.id);
        authorizeAutoReply(beforeSave, repositoryId, snapshot.enabled);
        const settings = await api.updateRepositoryAutoReplySettings(repositoryId, snapshot);
        autoReplyOwners.set(repositoryId, {
          version: settings.version,
          authorizedById: settings.enabled
            ? previous.authorizationEpoch === settings.authorizationEpoch
              ? previous.authorizedById
              : beforeSave.id
            : null,
          updatedById: beforeSave.id,
        });
        const latest = await currentUser(user.id);
        authorizeAutoReply(latest, repositoryId, snapshot.enabled);
        return structuredClone(scopedAutoReplySettings(settings));
      })();
    },

    async repositoryAutoReplies(repositoryId) {
      const user = await currentUser();
      authorize(user, repositoryId);
      const replies = await api.repositoryAutoReplies(repositoryId);
      return result(user, replies, repositoryId);
    },

    async repositoryProgressReplies(repositoryId) {
      const user = await currentUser();
      authorize(user, repositoryId);
      const replies = await api.repositoryProgressReplies(repositoryId);
      return result(user, replies, repositoryId);
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

    async tasks(workItemId, signal) {
      signal?.throwIfAborted();
      const user = await currentUser();
      const values = await api.tasks(workItemId, signal);
      const current = await currentUser(user.id);
      signal?.throwIfAborted();
      const items = values.items.filter((item) =>
        current.repositoryIds.includes(item.repository.id),
      );
      const visibleIds = new Set(items.map((item) => item.id));
      return structuredClone({
        items,
        ...(values.usageByTaskId
          ? {
              usageByTaskId: Object.fromEntries(
                Object.entries(values.usageByTaskId).filter(([id]) => visibleIds.has(id)),
              ),
            }
          : {}),
      });
    },

    async task(id, signal) {
      signal?.throwIfAborted();
      const user = await currentUser();
      const detail = await api.task(id, signal);
      const current = await currentAccess(user, detail.task.repository.id);
      signal?.throwIfAborted();
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
