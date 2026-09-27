/* Standalone design fixture. No API, storage, GitHub, or credential operations. */
function createOperations(ctx) {
  "use strict";
  const { state, h } = ctx;
  state.ops ||= {};
  const O = state.ops;
  const esc = h.esc;
  const btn = h.button;
  const panel = (body) => `<section class="ar-panel">${body}</section>`;
  const row = (body) => `<div class="ar-row">${body}</div>`;
  const stack = (body) => `<div class="ar-stack">${body}</div>`;
  const note = (text, tone = "info") => h.notice(text, tone);
  const help = (title, body) =>
    `<details><summary>${esc(title)}</summary><div class="ar-small ar-muted">${body}</div></details>`;
  const read = (id) => ctx.root.querySelector(`#${CSS.escape(String(id))}`)?.value || "";
  const checked = (id) => !!ctx.root.querySelector(`#${CSS.escape(String(id))}`)?.checked;
  const locked = (key) =>
    key.startsWith("repo.")
      ? !allowRepo(key.split(".")[1])
      : /^(acct\.|globalConcurrencyDraft)/.test(key) && !allowAdmin();
  const check = (label, key, value, disabled = false) =>
    `<label class="ar-row ar-small"><input id="ops-${esc(key.replaceAll(".", "-"))}" type="checkbox" aria-label="${esc(label)}" data-ops="${esc(key)}" ${value ? "checked" : ""} ${disabled || locked(key) ? "disabled" : ""} ${locked(key) ? 'aria-describedby="ops-permission-reason"' : ""}> <span>${esc(label)}</span></label>`;
  const field = (label, key, value, type = "text", extra = "") =>
    h.field(
      label,
      `ops-${key.replaceAll(".", "-")}`,
      value,
      type,
      `data-ops="${esc(key)}" ${locked(key) ? 'readonly aria-describedby="ops-permission-reason"' : ""} ${extra}`,
    );
  const select = (label, key, value, items) =>
    `<label class="ar-field"><span>${esc(label)}</span><select id="ops-${esc(key.replaceAll(".", "-"))}" aria-label="${esc(label)}" data-ops="${esc(key)}" ${locked(key) ? 'disabled aria-describedby="ops-permission-reason"' : ""}>${items.map(([v, l]) => `<option value="${esc(v)}" ${value === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  const textarea = (label, key, value, rows = 5) =>
    `<label class="ar-field"><span>${esc(label)}</span><textarea id="ops-${esc(key.replaceAll(".", "-"))}" aria-label="${esc(label)}" rows="${rows}" data-ops="${esc(key)}" ${locked(key) ? 'readonly aria-describedby="ops-permission-reason"' : ""}>${esc(value)}</textarea></label>`;
  const passwordField = (label, id, autocomplete = "new-password", disabled = false) =>
    `<div class="ar-password-field">${h.field(label, id, "", "password", `autocomplete="${autocomplete}" data-ops="ephemeral.${id}" ${disabled ? 'disabled aria-describedby="ops-permission-reason"' : ""}`)}${btn(h.icon("eye"), `ops:password-show:${id}`, "ghost ar-icon-button", `aria-controls="${id}" aria-label="Show ${esc(label.toLowerCase())}" aria-pressed="false" ${disabled ? "disabled" : ""}`)}</div>`;
  const submitButton = (label, action, variant = "primary", attrs = "") =>
    btn(label, action, variant, attrs)
      .replace('type="button"', 'type="submit"')
      .replace(/ data-action="[^"]*"/, "");
  const kv = (label, value) =>
    `<div><div class="ar-muted ar-small">${esc(label)}</div><div>${value}</div></div>`;
  const badge = (text, tone) =>
    h.badge(
      text,
      tone ||
        (["Delivered", "Enabled", "Processed", "Healthy", "Complete"].includes(text)
          ? "success"
          : ["Failed", "Blocked"].includes(text)
            ? "danger"
            : [
                  "Pending",
                  "Unknown",
                  "Acknowledgement unknown",
                  "Awaiting cleanup",
                  "Retry scheduled",
                ].includes(text)
              ? "warning"
              : "neutral"),
    );
  const table = (heads, rows) =>
    `<div class="ar-table-wrap"><table class="ar-table"><thead><tr>${heads.map((s) => `<th scope="col">${s || "Actions"}</th>`).join("")}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((c, i) => `<td data-label="${esc(heads[i] || "Actions")}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const back = (page, label) =>
    btn(
      `${h.icon?.("arrow-left") || ""} Back to ${label.toLowerCase()}`,
      `ops:back:${page}`,
      "quiet",
    );
  const currentAccount = () =>
    O.signedOut ? undefined : O.accounts?.find((account) => account.id === currentAccountId());
  const allowAdmin = () => Boolean(currentAccount()?.enabled && currentAccount()?.isAdmin);
  const hasRepoPermission = (permission, id = "fixture") => {
    const account = currentAccount(),
      repository = O.repositories.find((r) => r.id === id);
    return Boolean(
      account?.enabled &&
        repository &&
        account.repositories.split(/[\s,]+/).includes(repository.repositoryId) &&
        account.permissions.includes(permission),
    );
  };
  const allowRepo = (id = state.page === "repositories" && state.id ? state.id : "fixture") =>
    hasRepoPermission("repository:manage", id);
  const allowPrepare = () => hasRepoPermission("action:prepare");
  const allowSync = () =>
    allowPrepare() &&
    hasRepoPermission("action:execute") &&
    currentAccount().capabilities.includes("comment");
  const allowRecovery = (id) =>
    allowRepo("fixture") &&
    hasRepoPermission("task:create") &&
    (find(O.webhooks, id).mode !== "E2E" || currentAccount().execution);
  const fresh = () => (ctx.fresh ? ctx.fresh() : state.scenario !== "refresh-error");
  const freshnessReason = () =>
    fresh()
      ? ""
      : '<p id="ops-freshness-reason" class="ar-small ar-muted">Snapshot out of date. Refresh before saving.</p>';
  const permissionReason = () =>
    allowAdmin() && (state.page !== "repositories" || allowRepo())
      ? ""
      : `<p id="ops-permission-reason" class="ar-notice info">${state.page === "repositories" ? "Repository edits need this repository’s grant and Manage repositories. Workspace scheduling needs account administration." : "Read-only access. Changes require account administration."}</p>`;
  const disabledWrite = (blocked) => (!allowAdmin() || !fresh() || blocked ? "disabled" : "");
  const chips = (entries) =>
    entries
      .filter(([, , value]) => value)
      .map(([key, label, value]) =>
        btn(
          `${esc(label)}: ${esc(value)} ${h.icon?.("x") || "×"}`,
          `ops:filter-remove:${key}`,
          "small",
          `aria-label="Remove ${esc(label)} filter"`,
        ),
      )
      .join("");
  const inScope = () => !state.repo || ["all", "fixture"].includes(state.repo);
  const currentAccountId = () =>
    O.sessionAccountId ||
    { admin: "acct-admin", preparer: "acct-reviewer", reader: "acct-reader" }[state.role] ||
    "acct-reader";
  const endSession = (message) => {
    discardDirty();
    ctx.clearPrivateSession?.();
    ctx.clearDirty?.();
    O.loginNotice = message;
    state.scenario = "normal";
    ctx.nav("login", null);
  };
  const find = (items, id) => items.find((x) => x.id === id) || items[0];
  const filterText = (items, query = state.q || "") =>
    items.filter((x) => JSON.stringify(x).toLowerCase().includes(query.toLowerCase()));
  const focusError = (message, fieldId) => {
    const scope = ctx.root.querySelector("dialog[open]") || ctx.root;
    const error = scope.querySelector("[data-ops-error]");
    scope.querySelectorAll?.("[data-ops-inline-error]").forEach((node) => {
      node.remove();
    });
    scope.querySelectorAll?.('[aria-invalid="true"]').forEach((input) => {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    });
    if (error) {
      error.innerHTML = `<strong>Check this field</strong> · ${fieldId ? btn(esc(message), `ops:focus-field:${fieldId}`, "quiet small") : esc(message)}`;
      error.hidden = false;
      error.id = "ops-active-form-error";
    } else ctx.toast(message);
    const invalid = fieldId
      ? scope.querySelector(`#${CSS.escape(String(fieldId))}`)
      : scope.querySelector("input:invalid, textarea:invalid, select:invalid");
    if (invalid) {
      const errorId = `${invalid.id}-error`;
      invalid.setAttribute("aria-invalid", "true");
      invalid.setAttribute("aria-describedby", errorId);
      invalid.insertAdjacentHTML(
        "afterend",
        `<span id="${esc(errorId)}" data-ops-inline-error class="ar-field-error">${esc(message)}</span>`,
      );
      invalid.focus();
    }
  };
  const errorSlot = '<div data-ops-error role="alert" hidden class="ar-notice danger"></div>';
  const canonical = (value) =>
    Array.isArray(value)
      ? [...new Set(value)].sort()
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .filter((key) => !["id", "version"].includes(key))
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  const changedCount = (draft, saved) => {
    if (!draft) return 0;
    const left = canonical(draft),
      right = canonical(saved || {});
    return Object.keys(left).filter(
      (key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]),
    ).length;
  };
  const accountBaseline = () => ({
    id: "new",
    username: "",
    displayName: "",
    enabled: true,
    isAdmin: false,
    repositories: "repo-fixture",
    permissions: [],
    capabilities: [],
    execution: false,
    version: 1,
  });
  const repoChangeCount = (id) => changedCount(O.repoDrafts?.[id], O.repoSaved?.[id]);
  const accountChangeCount = (id) =>
    changedCount(
      O.accountDrafts?.[id],
      O.accounts.find((account) => account.id === id) || accountBaseline(),
    ) + (id === "new" && O.passwordDirty ? 1 : 0);
  const globalChanged = () =>
    O.globalConcurrencyDraft !== undefined &&
    Number(O.globalConcurrencyDraft) !== O.globalConcurrency;
  const activeChangeCount = () =>
    state.page === "repositories"
      ? state.tab === "scheduling" || !state.id
        ? Number(globalChanged())
        : repoChangeCount(state.id)
      : state.page === "accounts" && state.id
        ? accountChangeCount(state.id)
        : Number(Boolean(O.passwordDirty));
  const clean = () => {
    const repositoryDraftRemains = Object.keys(O.repoDrafts || {}).some(
      (id) => repoChangeCount(id) > 0,
    );
    const accountDraftRemains = Object.keys(O.accountDrafts || {}).some(
      (id) => accountChangeCount(id) > 0,
    );
    O.dirty = Boolean(
      repositoryDraftRemains || globalChanged() || accountDraftRemains || O.passwordDirty,
    );
    ctx.markDirty(O.dirty);
    const count = activeChangeCount();
    ctx.root.querySelectorAll?.("[data-ops-dirty]").forEach((node) => {
      node.textContent = count
        ? `${count} unsaved ${count === 1 ? "change" : "changes"}`
        : state.page === "accounts" && state.id === "new"
          ? "New account"
          : "All changes saved";
    });
    ctx.root.querySelectorAll?.("[data-ops-save]").forEach((node) => {
      node.disabled = !count || node.dataset.opsAllowed !== "true";
    });
    ctx.root.querySelectorAll?.("[data-ops-discard]").forEach((node) => {
      node.disabled = !count;
    });
    const badgeEl = ctx.root.querySelector("[data-ops-draft-badge]");
    const badgeCount =
      state.page === "repositories" && state.id
        ? repoChangeCount(state.id) + Number(globalChanged())
        : count;
    if (badgeEl) {
      badgeEl.textContent = badgeCount
        ? `${badgeCount} unsaved ${badgeCount === 1 ? "change" : "changes"}`
        : "Saved";
      badgeEl.className = `ar-badge ${badgeCount ? "warning" : "neutral"}`;
    }
  };
  const mark = clean;
  const discardDirty = () => {
    O.repoDrafts = {};
    O.accountDrafts = {};
    delete O.globalConcurrencyDraft;
    O.passwordDirty = false;
    O.dirty = false;
    ctx.root.querySelectorAll?.('[data-ops^="ephemeral."]').forEach((input) => {
      input.value = "";
    });
    ctx.markDirty(false);
  };
  const refresh = () => {
    const focused = ctx.root.querySelector(":focus");
    const active = focused?.dataset.materialSource
      ? ctx.root.querySelector("#" + CSS.escape(focused.dataset.materialSource))
      : focused;
    const key = active?.dataset.ops;
    const start = active?.selectionStart;
    const end = active?.selectionEnd;
    ctx.render();
    if (key) {
      const next = ctx.root.querySelector(`[data-ops="${key}"]`);
      next?.focus();
      if (next && typeof start === "number") {
        try {
          next.setSelectionRange(start, end);
        } catch (_) {
          /* Number fields do not expose a selection range. */
        }
      }
    }
  };
  const dialog = (title, body, confirm, action, danger = false) =>
    ctx.openDialog(
      title,
      body,
      `${btn("Cancel", "ops:dialog-close", "quiet")}${btn(confirm, action, danger ? "danger" : "primary")}`,
    );
  const repoName = "example/dashboard-ui-fixture";
  O.comments ||= [
    {
      id: "pub-204",
      kind: "Issue",
      number: 3101,
      title: "Summary: Settings does not open after an update",
      status: "Pending",
      body: "## Investigation summary\n\nSettings does not open after an update. The report contains reproduction steps; runtime verification is still pending.\n\n- Result: needs verification\n- Validation: Not run\n- Next step: review the proposed verification plan",
      task: "3101",
      report: "3101",
      updated: "4 min ago",
      version: 7,
    },
    {
      id: "pub-203",
      kind: "PR",
      number: 2101,
      title: "Review: Preserve settings when a migration is cancelled",
      status: "Delivered",
      body: "## Review summary\n\nPreserve settings when a migration is cancelled. The static review has two findings for review. Runtime validation has not run.\n\nReport: 2101",
      task: "2101",
      report: "2101",
      updated: "18 min ago",
      version: 3,
    },
    {
      id: "pub-202",
      kind: "PR",
      number: 2102,
      title: "Review: Improve keyboard navigation in Command Palette",
      status: "Failed",
      body: "## Review summary\n\nImprove keyboard navigation in Command Palette. The static review has 26 findings, including a P0 requiring review. Runtime validation has not run.",
      task: "2102",
      report: "2102",
      updated: "52 min ago",
      version: 2,
    },
  ];
  O.webhooks ||= [
    {
      id: "wh-301",
      target: "PR #2101",
      kind: "PR",
      number: 2101,
      mode: "Static",
      event: "pull_request · assigned",
      state: "Processed",
      phase: "Task creation",
      reason: "Investigation created",
      task: "2101",
      comment: "pub-203",
      time: "18 min ago",
    },
    {
      id: "wh-302",
      target: "Issue #3101",
      kind: "Issue",
      number: 3101,
      mode: "Static",
      event: "issues · assigned",
      state: "Failed",
      phase: "Source import",
      reason: "Source snapshot temporarily unavailable",
      task: null,
      comment: null,
      time: "9 min ago",
    },
    {
      id: "wh-303",
      target: "PR #2102",
      kind: "PR",
      number: 2102,
      mode: "Static",
      event: "pull_request · synchronize",
      state: "Ignored",
      phase: "Authorization",
      reason: "Actor is not in the trusted user allowlist",
      task: null,
      comment: null,
      time: "52 min ago",
    },
    {
      id: "wh-304",
      target: "PR #2203",
      kind: "PR",
      number: 2203,
      mode: "E2E",
      event: "pull_request · assigned",
      state: "Processed",
      phase: "Task creation",
      reason: "E2E investigation created; runtime work is in progress",
      task: "2203",
      comment: null,
      time: "3 min ago",
    },
  ];
  O.workers ||= [
    {
      id: "win-review-01",
      contact: "Recent contact",
      admission: "Enabled",
      cleanup: "No pending cleanup",
      active: 1,
      capacity: 2,
      seen: "12 seconds ago",
      platform: "Windows · static + E2E",
      advertised: ["PR review", "Issue analysis", "PR E2E"],
      effective: ["PR review", "Issue analysis", "PR E2E"],
      owner: "2203",
    },
    {
      id: "win-review-02",
      contact: "No recent contact",
      admission: "Enabled",
      cleanup: "No pending cleanup",
      active: 0,
      capacity: 2,
      seen: "34 minutes ago",
      platform: "Windows · static + E2E",
      advertised: ["PR review", "Issue analysis", "PR E2E"],
      effective: ["PR review", "Issue analysis", "PR E2E"],
      owner: null,
    },
    {
      id: "linux-static-01",
      contact: "Never contacted",
      admission: "Disabled",
      cleanup: "No pending cleanup",
      active: 0,
      capacity: 3,
      seen: "No contact recorded",
      platform: "Linux · static policy",
      advertised: null,
      effective: [],
      owner: null,
    },
  ];
  O.repositories ||= [
    {
      id: "fixture",
      repositoryId: "repo-fixture",
      name: repoName,
      mode: "Static + E2E",
      jobs: 3,
      version: 4,
    },
    {
      id: "fork",
      repositoryId: "repo-fixture-fork",
      name: "example/dashboard-ui-fixture-fork",
      mode: "Static only",
      jobs: 0,
      version: 2,
    },
  ];
  O.repoSaved ||= {};
  O.repoDrafts ||= {};
  O.globalConcurrency ||= 6;
  O.accounts ||= [
    {
      id: "acct-admin",
      username: "demo.admin",
      displayName: "Demo administrator",
      enabled: true,
      isAdmin: true,
      repositories: "repo-fixture",
      permissions: [
        "repository:manage",
        "task:create",
        "task:cancel",
        "action:prepare",
        "action:execute",
      ],
      capabilities: [
        "comment",
        "approve",
        "request-changes",
        "merge",
        "start-task",
        "reviews.verify",
        "close",
        "suggestion-comment",
        "trigger-ci",
      ],
      execution: true,
      version: 8,
    },
    {
      id: "acct-reviewer",
      username: "demo.reviewer",
      displayName: "Demo reviewer",
      enabled: true,
      isAdmin: false,
      repositories: "repo-fixture",
      permissions: ["task:create", "action:prepare"],
      capabilities: ["comment"],
      execution: false,
      version: 3,
    },
    {
      id: "acct-reader",
      username: "demo.reader",
      displayName: "Demo reader",
      enabled: true,
      isAdmin: false,
      repositories: "repo-fixture",
      permissions: [],
      capabilities: [],
      execution: false,
      version: 2,
    },
    {
      id: "acct-inactive",
      username: "demo.inactive",
      displayName: "Inactive collaborator",
      enabled: false,
      isAdmin: false,
      repositories: "",
      permissions: [],
      capabilities: [],
      execution: false,
      version: 1,
    },
  ];
  O.accountDrafts ||= {};
  // Display distinct source / task / report identities while sharing the fixture route key.
  O.comments.forEach((c) => {
    if (!c.task.startsWith("task-")) c.task = "task-" + c.task;
    if (!c.report.startsWith("report-")) c.report = "report-" + c.report;
  });
  O.webhooks.forEach((w) => {
    if (w.task && !w.task.startsWith("task-")) w.task = "task-" + w.task;
  });
  const permissions = [
    ["repository:manage", "Manage repositories"],
    ["task:create", "Create investigations"],
    ["task:cancel", "Cancel investigations"],
    ["action:prepare", "Prepare actions"],
    ["action:execute", "Execute actions"],
  ];
  const capabilities = [
    ["comment", "Comment"],
    ["approve", "Approve"],
    ["suggestion-comment", "Code suggestion comment"],
    ["request-changes", "Request changes"],
    ["close", "Close"],
    ["merge", "Merge"],
    ["trigger-ci", "Trigger CI"],
    ["close-as-duplicate", "Close as duplicate"],
    ["start-task", "Start linked task"],
    ["reviews.verify", "Verify PR"],
    ["view-validation", "View validation"],
    ["view-changes", "View changes"],
    ["create-pr", "Create pull request"],
    ["view-evidence", "View evidence"],
    ["resume", "Resume investigation"],
  ];
  const replyTokens = {
    pullRequest: ["identity", "conclusion", "summary", "findings", "details"],
    issue: ["identity", "conclusion", "next_steps", "details"],
    received: ["trigger", "updated_at"],
    started: ["trigger", "updated_at"],
    failed: ["trigger", "updated_at", "failure"],
    completed: ["trigger", "updated_at", "result"],
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const intakeMode = (value) =>
    value.static && value.e2e
      ? "Static + E2E"
      : value.static
        ? "Static only"
        : value.e2e
          ? "E2E only"
          : "Intake disabled";
  const draftActions = (kind, id, count, allowed, label = "Save changes", position = "top") =>
    `<section class="ar-panel ar-changebar"><div class="ar-toolbar"><span data-ops-dirty class="ar-small ar-muted" role="status">${count ? `${count} unsaved ${count === 1 ? "change" : "changes"}` : kind === "account" && id === "new" ? "New account" : "All changes saved"}</span>${row(`${btn("Discard draft", `ops:${kind}-discard:${id}`, "", `id="ops-${kind}-${id}-${position}-discard" data-ops-discard ${!count ? "disabled" : ""}`)}${btn(label, `ops:${kind}-save:${id}`, "primary", `id="ops-${kind}-${id}-${position}-save" data-ops-save data-ops-allowed="${allowed}" ${!allowed || !count ? "disabled" : ""}`)}`)}</div></section>`;
  const viewKeys = {
    comments: {
      commentSearch: "text",
      commentKind: ["", "PR", "Issue"],
      commentStatus: ["", "Pending", "Delivered", "Failed"],
      commentNumber: "number",
      commentTask: "text",
      commentType: ["", "summary", "review"],
      commentMore: "boolean",
    },
    webhooks: {
      webhookSearch: "text",
      webhookState: ["", "Processed", "Failed", "Ignored", "Retry scheduled"],
      webhookKind: ["", "PR", "Issue"],
      webhookNumber: "number",
      webhookMode: ["", "Static", "E2E"],
    },
    workers: {
      workerSearch: "text",
      workerContact: ["", "Recent contact", "No recent contact", "Never contacted"],
      workerCleanup: ["", "pending", "clear"],
    },
    repositories: {
      repoSearch: "text",
      replyTemplate: ["pullRequest", "issue", "received", "started", "failed", "completed"],
    },
    accounts: { accountSearch: "text", accountState: ["", "enabled", "disabled"] },
  };
  const safeViewValue = (rule, value) =>
    rule === "boolean"
      ? value === true || value === "true"
      : typeof value !== "string"
        ? ""
        : rule === "text"
          ? value.slice(0, 160)
          : rule === "number"
            ? /^[1-9]\d{0,14}$/.test(value)
              ? value
              : ""
            : rule.includes(value)
              ? value
              : "";
  const getView = (page) =>
    Object.fromEntries(
      Object.entries(viewKeys[page] || {})
        .map(([key, rule]) => [key, safeViewValue(rule, O[key])])
        .filter(([, value]) => value !== "" && value !== false),
    );
  const applyView = (page, view) => {
    for (const [key, rule] of Object.entries(viewKeys[page] || {}))
      O[key] = safeViewValue(rule, view?.[key]);
  };
  const viewChanged = () => {
    ctx.viewChanged?.();
    refresh();
  };
  const setSection = (tab) => {
    if (ctx.setSection && state.tab !== tab) ctx.setSection(tab);
    else {
      state.tab = tab;
      refresh();
    }
  };
  O.operationHistory ||= { comments: {}, webhooks: {} };
  const addHistory = (type, id, event, result, detail, requestId = "", payload = null) => {
    O.operationHistory[type][id] ||= [];
    const entries = O.operationHistory[type][id];
    const entry = {
      sequence: entries.length + 1,
      time: entries.length ? "Just now" : "Retained snapshot",
      requestId,
      event,
      result,
      detail,
      ...(payload ? { payload: clone(payload) } : {}),
    };
    entries.push(Object.freeze(entry));
    return entry;
  };
  const historyPanel = (type, id) =>
    panel(
      `<h2 class="ar-title">${type === "comments" ? "Delivery history" : "Handling history"}</h2>${table(
        ["When", "Request / attempt", "Event", "Result"],
        [...(O.operationHistory[type][id] || [])]
          .reverse()
          .map((entry) => [
            esc(entry.time),
            `<span class="ar-small">${esc(entry.requestId || "Initial attempt")}</span>`,
            `${esc(entry.event)}${entry.payload ? help("Request payload", `<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(entry.payload, null, 2))}</pre>`) : ""}`,
            `${badge(entry.result)}${help("Details", esc(entry.detail))}`,
          ]),
      )}`,
    );
  O.comments.forEach((c) => {
    if (!O.operationHistory.comments[c.id]?.length)
      addHistory(
        "comments",
        c.id,
        "Publication snapshot retained",
        c.status,
        `Content version v${c.version}; ${c.updated}.`,
        `fixture-initial-${c.id}`,
      );
  });
  O.webhooks.forEach((w) => {
    if (!O.operationHistory.webhooks[w.id]?.length)
      addHistory(
        "webhooks",
        w.id,
        "Initial handling attempt",
        w.state,
        `${w.phase}: ${w.reason}`,
        `fixture-initial-${w.id}`,
      );
  });
  const prototypeOutcomeControls = (type, id, pending, unresolved, permitted) =>
    pending || unresolved
      ? panel(
          `<details ${O.simulationOpen?.[`${type}:${id}`] ? "open" : ""}><summary>Simulation controls</summary><p class="ar-small ar-muted">Choose the next ${type === "comment" ? "delivery" : "handling"} event.</p>${unresolved ? btn("Acknowledge saved request", `ops:${type}-acknowledge:${id}`, "", !permitted ? "disabled" : "") : ""}${pending ? row(`${btn("Successful result", `ops:${type}-outcome:${id}:success`, "", !permitted || unresolved ? "disabled" : "")}${btn("Failed result", `ops:${type}-outcome:${id}:failure`, "", !permitted || unresolved ? "disabled" : "")}`) : ""}</details>`,
        )
      : "";
  const repositoryAccess = (value) =>
    value
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((id) => {
        const repository = O.repositories.find((r) => r.repositoryId === id);
        return `<div>${esc(repository?.name || "Repository not in current directory")}<div class="ar-small ar-muted">${esc(id)}</div></div>`;
      })
      .join("") || '<span class="ar-muted">No repository access</span>';

  function commentDetail(c) {
    if (state.scenario === "unknown" && !O.commentCommands?.[c.id]) {
      O.commentCommands ||= {};
      O.commentCommands[c.id] = {
        id: `fixture-request-${c.id}-retained`,
        action: "sync",
        state: "unknown",
        version: c.version,
        body: c.body,
        message: "A prior publication request is retained. Its acknowledgement is not confirmed.",
      };
      addHistory(
        "comments",
        c.id,
        "Saved request acknowledgement unavailable",
        "Unknown",
        `Last known delivery remains ${c.status}.`,
        O.commentCommands[c.id].id,
        { publication: c.id, version: c.version, body: c.body },
      );
    }
    const command = O.commentCommands?.[c.id];
    const unknown = command?.state === "unknown";
    const conflict = state.scenario === "conflict" && !O.commentReviewed?.[c.id];
    return stack(`${back("comments", "Comments")}${h.heading(c.title, `${repoName} · ${c.id} · v${c.version}`, badge(unknown ? "Acknowledgement unknown" : c.status, unknown ? "warning" : undefined))}
      ${unknown ? note("Acknowledgement unknown. Resolve the saved request before submitting another.", "warning") + row(`${btn("Refresh status", `ops:comment-status:${c.id}`, "primary", !allowPrepare() ? "disabled" : "")}${btn("Retry saved request", `ops:comment-replay:${c.id}`, "", !allowSync() ? "disabled" : "")}`) : ""}
      ${conflict ? note("This publication changed. Review the latest version before syncing.", "warning") + btn("Review latest publication", `ops:comment-review:${c.id}`, "", !fresh() ? "disabled" : "") : ""}
      <div class="ar-grid">${panel(`<h2 class="ar-title">Publication</h2><div class="ar-grid">${kv("Target", `${esc(`${c.kind} #${c.number}`)}<div class="ar-row">${h.githubLink({ repositoryFullName: repoName, kind: c.kind, number: c.number, synthetic: true })}</div>`)}${kv("Updated", esc(c.updated))}${kv("Source report", btn(c.report, `ops:nav:reports:${c.report}`, "quiet"))}${kv("Task", btn(c.task, `ops:nav:tasks:${c.task}`, "quiet"))}</div>`)}${panel(`<h2 class="ar-title">Delivery</h2>${row(`${btn("Check delivery", `ops:comment-check:${c.id}`, "", !allowPrepare() || unknown || conflict ? "disabled" : "")}${btn("Review sync…", `ops:comment-sync:${c.id}`, "primary", !allowSync() || unknown || conflict || !fresh() || c.status === "Pending" ? "disabled" : "")}`)}${!allowSync() ? '<p class="ar-small ar-muted">Check: Prepare actions. Sync: also Execute actions and Comment for this repository.</p>' : ""}${freshnessReason()}${c.status === "Pending" ? '<p class="ar-small ar-muted">Waiting for delivery. A new sync is unavailable until it finishes.</p>' : ""}${O.commentReadNotice?.[c.id] ? `<p class="ar-small" role="status">${esc(O.commentReadNotice[c.id])}</p>` : ""}${command ? help("Saved request", `<p>${esc(command.id)}</p><p>${esc(command.message)}</p>`) : ""}`)}
      </div>${panel(`<h2 class="ar-title">Comment body</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.7">${esc(c.body)}</pre>`)}
      ${prototypeOutcomeControls("comment", c.id, c.status === "Pending", unknown, allowSync())}${historyPanel("comments", c.id)}`);
  }

  function comments() {
    if (state.id) return commentDetail(find(O.comments, state.id));
    const rows = filterText(inScope() ? O.comments : [], O.commentSearch || "").filter(
      (c) =>
        (!O.commentKind || c.kind === O.commentKind) &&
        (!O.commentStatus || c.status === O.commentStatus),
    );
    const chips = [
      ["commentSearch", "Search", O.commentSearch],
      ["commentKind", "Work item", O.commentKind],
      ["commentStatus", "Delivery", O.commentStatus],
      ["commentNumber", "Number", O.commentNumber],
      ["commentTask", "Task ID", O.commentTask],
      ["commentType", "Type", O.commentType],
    ]
      .filter(([, , value]) => value)
      .map(([key, label, value]) =>
        btn(
          `${esc(label)}: ${esc(value)} ×`,
          `ops:comment-remove:${key}`,
          "small",
          `aria-label="Remove ${esc(label)} filter"`,
        ),
      )
      .join("");
    return stack(`${h.heading("Comments", "", btn("Refresh", "ops:refresh:comments"))}
      ${panel(
        `<div class="ar-toolbar">${field("Search publications", "commentSearch", O.commentSearch || "", "search", 'placeholder="Title, body or source number"')}${select(
          "Work item",
          "commentKind",
          O.commentKind || "",
          [
            ["", "All work items"],
            ["PR", "Pull requests"],
            ["Issue", "Issues"],
          ],
        )}${select("Delivery", "commentStatus", O.commentStatus || "", [
          ["", "All delivery states"],
          ["Pending", "Pending"],
          ["Delivered", "Delivered"],
          ["Failed", "Failed"],
        ])}${btn(O.commentMore ? "Fewer filters" : "More filters", "ops:comment-filters", "quiet", `aria-expanded="${!!O.commentMore}"`)}</div>${
          O.commentMore
            ? `<div class="ar-grid">${field("Work item number", "commentNumber", O.commentNumber || "", "number", 'min="1"')}${field("Exact Task ID", "commentTask", O.commentTask || "", "text", 'placeholder="For example: task-2101"')}${select(
                "Publication type",
                "commentType",
                O.commentType || "",
                [
                  ["", "All types"],
                  ["summary", "Investigation summary"],
                  ["review", "Review summary"],
                ],
              )}</div>`
            : ""
        }${chips ? `<div class="ar-row" aria-label="Active publication filters">${chips}</div>` : ""}${row(`<span class="ar-muted ar-small">${rows.filter(commentExtraFilter).length} publications</span>${btn("Clear filters", "ops:comment-clear", "quiet")}`)}`,
      )}
      ${
        rows.filter(commentExtraFilter).length
          ? panel(
              table(
                ["Publication", "Target", "Delivery", "Updated", ""],
                rows
                  .filter(commentExtraFilter)
                  .map((c) => [
                    `<strong>${esc(c.title)}</strong><div class="ar-small ar-muted">${c.id} · v${c.version}</div>`,
                    `${c.kind} #${c.number}`,
                    badge(c.status),
                    c.updated,
                    btn("View publication", `ops:open:comments:${c.id}`, "quiet"),
                  ]),
              ),
            )
          : h.empty(
              "No matching comments",
              inScope()
                ? "Try a different delivery state or work item number."
                : "This repository has no publications.",
              inScope()
                ? btn("Clear filters", "ops:comment-clear")
                : btn("Show all repositories", "ops:all-repositories"),
            )
      }`);
  }
  function commentExtraFilter(c) {
    return (
      (!O.commentNumber || String(c.number) === String(O.commentNumber)) &&
      (!O.commentTask || c.task === String(O.commentTask).trim()) &&
      (!O.commentType || (O.commentType === "summary" ? c.kind === "Issue" : c.kind === "PR"))
    );
  }

  function webhooks() {
    if (!state.id) {
      const rows = filterText(inScope() ? O.webhooks : [], O.webhookSearch || "").filter(
        (w) =>
          (!O.webhookState || w.state === O.webhookState) &&
          (!O.webhookKind || w.kind === O.webhookKind) &&
          (!O.webhookMode || w.mode === O.webhookMode) &&
          (!O.webhookNumber || String(w.number) === O.webhookNumber),
      );
      const active = chips([
        ["webhookSearch", "Search", O.webhookSearch],
        ["webhookState", "Handling", O.webhookState],
        ["webhookKind", "Target", O.webhookKind],
        ["webhookNumber", "Number", O.webhookNumber],
        ["webhookMode", "Mode", O.webhookMode],
      ]);
      return stack(
        `${h.heading("Webhook events", "", btn("Refresh", "ops:refresh:webhooks"))}${panel(
          `<div class="ar-toolbar">${field("Search events", "webhookSearch", O.webhookSearch || "", "search", 'placeholder="Event, target or reason"')}${select(
            "Handling state",
            "webhookState",
            O.webhookState || "",
            [
              ["", "All states"],
              ["Processed", "Processed"],
              ["Failed", "Failed"],
              ["Ignored", "Ignored"],
              ["Retry scheduled", "Retry scheduled"],
            ],
          )}${select("Work item", "webhookKind", O.webhookKind || "", [
            ["", "All work items"],
            ["PR", "Pull requests"],
            ["Issue", "Issues"],
          ])}${field("Exact source number", "webhookNumber", O.webhookNumber || "", "number", 'min="1"')}${select(
            "Investigation mode",
            "webhookMode",
            O.webhookMode || "",
            [
              ["", "All modes"],
              ["Static", "Static"],
              ["E2E", "E2E"],
            ],
          )}</div>${active ? `<div class="ar-row" aria-label="Active event filters">${active}</div>` : ""}${row(`<span class="ar-small ar-muted" role="status">${rows.length} events</span>${btn("Clear filters", "ops:webhook-clear", "quiet")}`)}`,
        )}${
          rows.length
            ? panel(
                table(
                  ["Event", "Work item", "Handling", "Linked Task", "Received", ""],
                  rows.map((w) => [
                    `<strong>${esc(w.event)}</strong><div class="ar-small ar-muted">${w.id} · ${w.mode}</div>`,
                    w.target,
                    badge(w.state),
                    w.task ? btn(w.task, `ops:nav:tasks:${w.task}`, "quiet") : "None created",
                    w.time,
                    btn("View event", `ops:open:webhooks:${w.id}`, "quiet"),
                  ]),
                ),
              )
            : h.empty(
                "No matching webhook events",
                inScope()
                  ? "Try another source number, mode or handling state."
                  : "This repository has no events.",
                inScope()
                  ? btn("Clear filters", "ops:webhook-clear")
                  : btn("Show all repositories", "ops:all-repositories"),
              )
        }`,
      );
    }
    const w = find(O.webhooks, state.id);
    if (state.scenario === "unknown" && !O.webhookCommands?.[w.id]) {
      O.webhookCommands ||= {};
      O.webhookCommands[w.id] = {
        id: `fixture-recovery-${w.id}-retained`,
        state: "unknown",
        attempt: w.attempt || 1,
        message: "A prior recovery request is retained. Its acknowledgement is not confirmed.",
      };
      addHistory(
        "webhooks",
        w.id,
        "Saved recovery acknowledgement unavailable",
        "Unknown",
        `Last known event state remains ${w.state}.`,
        O.webhookCommands[w.id].id,
      );
    }
    const request = O.webhookCommands?.[w.id];
    const unknown = request?.state === "unknown";
    const conflict = state.scenario === "conflict" && !O.webhookReviewed?.[w.id];
    return stack(`${back("webhooks", "Webhooks")}${h.heading(`${w.target} · ${w.event}`, `${repoName} · ${w.id} · received ${w.time}`, badge(w.state))}
      ${unknown ? note("Acknowledgement unknown. Resolve the saved request before another recovery.", "warning") + row(`${btn("Refresh event status", `ops:webhook-status:${w.id}`, "primary", !allowRecovery(w.id) ? "disabled" : "")}${btn("Retry saved request", `ops:webhook-replay:${w.id}`, "", !allowRecovery(w.id) ? "disabled" : "")}`) : ""}
      ${conflict ? note("This event changed. Review the latest state before retrying.", "warning") + btn("Review latest event", `ops:webhook-review:${w.id}`, "", !fresh() ? "disabled" : "") : ""}
      <div class="ar-grid">${panel(`<h2 class="ar-title">Event handling</h2>${kv("Phase", esc(w.phase))}<p>${esc(w.reason)}</p>${row(`${btn("View source snapshot", `ops:nav:${w.kind === "Issue" ? "issues" : "pulls"}:${w.number}`, "quiet")}${h.githubLink({ repositoryFullName: repoName, kind: w.kind, number: w.number, synthetic: true })}`)}<p class="ar-small ar-muted">Attempt ${w.attempt || 1} · ${esc(w.mode)}</p>${freshnessReason()}${w.state === "Failed" || unknown ? btn("Review retry…", `ops:webhook-retry:${w.id}`, "primary", !allowRecovery(w.id) || !fresh() || w.state !== "Failed" || unknown || conflict ? "disabled" : "") : ""}${!allowRecovery(w.id) && w.state === "Failed" ? '<p class="ar-small ar-muted">Retry needs Manage repositories and Create investigations for this repository. E2E also needs execution access.</p>' : ""}${request ? help("Saved recovery request", `<p>${esc(request.id)}</p><p>${esc(request.message)}</p>`) : ""}`)}${panel(`<h2 class="ar-title">Investigation</h2>${w.task ? `${w.reusedTask ? badge("Existing Task linked", "neutral") : ""}<p>${btn(w.task, `ops:nav:tasks:${w.task}`, "quiet")}${ctx.hasRecord?.("reports", w.task.replace(/^task-/, "")) ? btn("View saved report", `ops:nav:reports:${w.task.replace("task-", "report-")}`, "quiet") : '<span class="ar-small ar-muted">No saved report</span>'}</p>` : "<p>No Task linked.</p>"}<h2 class="ar-title">Publication</h2>${w.comment ? `${badge(find(O.comments, w.comment).status)} ${btn("View publication", `ops:nav:comments:${w.comment}`, "quiet")}` : "<p>No publication linked.</p>"}`)}</div>
      ${prototypeOutcomeControls("webhook", w.id, w.state === "Retry scheduled", unknown, allowRecovery(w.id))}${historyPanel("webhooks", w.id)}`);
  }

  function workers() {
    const worker = state.id ? find(O.workers, state.id) : null;
    const matches = filterText(O.workers, O.workerSearch || "").filter(
      (w) =>
        (!O.workerContact || w.contact === O.workerContact) &&
        (!O.workerCleanup ||
          (O.workerCleanup === "pending"
            ? w.cleanup === "Awaiting cleanup"
            : w.cleanup !== "Awaiting cleanup")),
    );
    const visible = worker ? [worker] : matches;
    const cards = visible
      .map((w) => {
        const conflict = state.scenario === "conflict" && !O.workerReviewed?.[w.id];
        return panel(
          `<div class="ar-toolbar"><div><h2 class="ar-title">${worker ? "Worker status" : esc(w.id)}</h2><p class="ar-muted ar-small">${esc(w.platform)} · policy v${w.version || 3}</p></div>${badge(w.contact, w.contact === "Recent contact" ? "neutral" : "warning")}</div><div class="ar-grid">${kv("Last contact", esc(w.seen))}${kv("E2E admission", badge(w.admission === "Enabled" ? "Allowed by server" : "Off", "neutral"))}${kv("Cleanup", badge(w.cleanup))}${kv("E2E owner", w.owner ? btn(`task-${w.owner}`, `ops:nav:tasks:task-${w.owner}`, "quiet") : "No owner")}${kv("Occupied capacity", `${w.active} / ${w.capacity}`)}</div><details><summary>Capabilities and server policy</summary><div class="ar-stack">${kv("Advertised task types", w.advertised ? esc(w.advertised.join(" · ")) : "Waiting for worker capabilities")}${kv("Effective task types", w.effective.length ? esc(w.effective.join(" · ")) : "None confirmed")}<p class="ar-small ar-muted">Contact and free capacity do not confirm eligibility. Stopping E2E also requests cancellation; static work continues.</p></div></details>${conflict ? note("Admission policy changed. Review the latest version.", "warning") + btn("Review current policy", `ops:worker-review:${w.id}`, "", !fresh() ? "disabled" : "") : ""}${row(`${!worker ? btn("View worker", `ops:open:workers:${w.id}`, "quiet") : ""}${btn(w.admission === "Enabled" ? "Stop E2E work…" : "Allow E2E work", `ops:worker-${w.admission === "Enabled" ? "disable" : "enable"}:${w.id}`, w.admission === "Enabled" ? "" : "primary", disabledWrite(conflict || (w.admission !== "Enabled" && (w.cleanup === "Awaiting cleanup" || !w.advertised?.includes("PR E2E")))))}`)}${w.admission !== "Enabled" && !w.advertised?.includes("PR E2E") ? '<p class="ar-small ar-muted">Waiting for advertised E2E support.</p>' : ""}${w.cleanup === "Awaiting cleanup" ? `${btn("View cleanup details", `ops:worker-cleanup:${w.id}`, "quiet")}${help("Simulation controls", btn("Receive cleanup report", `ops:worker-proof:${w.id}`, "", disabledWrite(false)))}` : ""}`,
        );
      })
      .join("");
    return stack(
      `${worker ? back("workers", "Workers") : ""}${h.heading(worker ? worker.id : "Workers", "Workspace-wide", btn("Refresh status", "ops:refresh:workers"))}${permissionReason()}${freshnessReason()}${O.lastRefresh?.workers ? `<p class="ar-small ar-muted" role="status">Refreshed ${O.lastRefresh.workers}</p>` : ""}${
        !worker
          ? panel(
              `<div class="ar-toolbar">${field("Search workers", "workerSearch", O.workerSearch || "", "search", 'placeholder="Worker ID or platform"')}${select(
                "Worker contact",
                "workerContact",
                O.workerContact || "",
                [
                  ["", "All contact states"],
                  ["Recent contact", "Recent contact"],
                  ["No recent contact", "No recent contact"],
                  ["Never contacted", "Never contacted"],
                ],
              )}${select("Cleanup", "workerCleanup", O.workerCleanup || "", [
                ["", "All cleanup states"],
                ["pending", "Awaiting cleanup"],
                ["clear", "No pending cleanup"],
              ])}</div>${row(
                chips([
                  ["workerSearch", "Search", O.workerSearch],
                  ["workerContact", "Contact", O.workerContact],
                  ["workerCleanup", "Cleanup", O.workerCleanup],
                ]),
              )}${row(`<span class="ar-small ar-muted" role="status">${matches.length} workers</span>${btn("Clear filters", "ops:worker-clear", "quiet")}`)}`,
            )
          : ""
      }${visible.length ? `<div class="${worker ? "ar-stack" : "ar-grid"}">${cards}</div>` : h.empty("No matching workers", "Try another contact or cleanup state.", btn("Clear filters", "ops:worker-clear"))}${
        worker
          ? panel(
              `<h2 class="ar-title">Recent activity</h2>${table(
                ["Time", "Event", "Result"],
                worker.events ||
                  (worker.contact === "Never contacted"
                    ? [["—", "No worker contact recorded", "No E2E owner or pending cleanup"]]
                    : [
                        ["12:42:08", "Last heartbeat observed", worker.contact],
                        ["12:40:00", "E2E admission policy checked", worker.admission],
                      ]),
              )}`,
            )
          : ""
      }`,
    );
  }

  function repoDraft(id) {
    O.repoSaved[id] ||= {
      static: true,
      e2e: id !== "fork",
      reviewer: "10041",
      actors: "10041\n10042",
      autoRepliesEnabled: true,
      progressEnabled: true,
      pullRequestTemplate:
        "{{identity}}\n\n## Conclusion\n{{conclusion}}\n\n## Summary\n{{summary}}\n\n## Findings\n{{findings}}\n\n{{details}}",
      issueTemplate:
        "{{identity}}\n\n## Triage result\n{{conclusion}}\n\n## Next steps\n{{next_steps}}\n\n{{details}}",
      progressTemplates: Object.fromEntries(
        ["received", "started", "failed", "completed"].map((stage) => [
          stage,
          "## {{status}}\n\n" + replyTokens[stage].map((token) => "{{" + token + "}}").join("\n\n"),
        ]),
      ),
    };
    O.repoDrafts[id] ||= clone(O.repoSaved[id]);
    return O.repoDrafts[id];
  }
  function globalConcurrencyPanel() {
    return panel(
      `<h2 class="ar-title">Workspace scheduling</h2>${badge("All repositories", "info")}<p>Running static investigations: 3 / ${O.globalConcurrency}</p>${errorSlot}<p data-ops-dirty class="ar-small ar-muted" role="status">${globalChanged() ? "1 unsaved change" : "All changes saved"}</p><div class="ar-toolbar">${field("Maximum concurrent static investigations", "globalConcurrencyDraft", O.globalConcurrencyDraft ?? O.globalConcurrency, "number", 'min="1" max="16"')}${btn("Save concurrency", "ops:global-save", "primary", `id="ops-global-save" data-ops-save data-ops-allowed="${allowAdmin() && fresh()}" ${!globalChanged() || !allowAdmin() || !fresh() ? "disabled" : ""}`)}${btn("Discard draft", "ops:global-discard", "quiet", `id="ops-global-discard" data-ops-discard ${!globalChanged() ? "disabled" : ""}`)}</div><p class="ar-small ar-muted">1–16. Lowering the limit lets running work finish.</p>${help("How scheduling works", "<p>This limit applies across all repositories, regardless of the current filter. Worker capacity may further limit concurrency.</p>")}${O.globalSaveNotice ? note(O.globalSaveNotice, "success") : ""}`,
    );
  }
  function repositories() {
    if (!state.id) {
      const rows = filterText(O.repositories, O.repoSearch || "");
      return stack(
        `${h.heading("Repositories", "Workspace-wide")}${permissionReason()}${freshnessReason()}${panel(`<div class="ar-toolbar">${field("Search repositories", "repoSearch", O.repoSearch || "", "search", 'placeholder="Repository name or exact ID"')}${btn("Clear search", "ops:repo-clear", "quiet")}</div>${row(chips([["repoSearch", "Search", O.repoSearch]]))}<p class="ar-small ar-muted" role="status">${rows.length} repositories</p>`)}${
          rows.length
            ? panel(
                table(
                  ["Repository", "Intake", "Active Tasks", "Version", ""],
                  rows.map((r) => [
                    `<strong>${esc(r.name)}</strong><div class="ar-small ar-muted">${esc(r.repositoryId)}</div>`,
                    badge(r.mode, "info"),
                    r.jobs,
                    `v${r.version}`,
                    btn("View settings", `ops:open:repositories:${r.id}`, "quiet"),
                  ]),
                ),
              )
            : h.empty(
                "No matching repositories",
                "Try the repository name or exact repository ID.",
                btn("Clear search", "ops:repo-clear"),
              )
        }${globalConcurrencyPanel()}`,
      );
    }
    const r = find(O.repositories, state.id),
      d = repoDraft(r.id),
      prefix = `repo.${r.id}.`;
    const tab = ["overview", "intake", "replies", "scheduling"].includes(state.tab)
      ? state.tab
      : "overview";
    const conflict =
      O.repoConflict === r.id || (state.scenario === "conflict" && !O.repoReviewed?.[r.id]);
    const conflictUi =
      conflict && tab !== "scheduling"
        ? note("Settings changed. Your draft is preserved; compare before saving.", "warning") +
          row(
            `${btn("Compare latest", `ops:repo-latest:${r.id}`, "primary", !fresh() ? "disabled" : "")}${btn("Download draft", `ops:repo-export:${r.id}`)}`,
          ) +
          (O.repoLatest === r.id
            ? panel(
                `<h2 class="ar-title">Compare versions</h2>${table(
                  ["Setting", "Your draft", "Latest saved · v" + (r.version + 1)],
                  [
                    ["E2E intake", d.e2e ? "Enabled" : "Disabled", "Disabled"],
                    ["Trusted actors", esc(d.actors.replaceAll("\n", ", ")), "10041"],
                  ],
                )}${row(`${btn("Keep my draft", `ops:repo-keep:${r.id}`, "primary")}${btn("Use latest settings", `ops:repo-use-latest:${r.id}`)}`)}`,
              )
            : "")
        : "";
    let body = "";
    if (tab === "overview")
      body = `<div class="ar-grid">${panel(`<h2 class="ar-title">Repository scope</h2>${kv("Repository ID", esc(r.repositoryId))}<p>${badge(r.mode, "info")}</p>${help("Access requirements", "<p>Grant this exact repository ID on the account. Account administration alone does not grant repository access.</p>")}`)}${panel(`<h2 class="ar-title">Current activity</h2>${kv("Active Tasks", String(r.jobs))}${row(`${btn("View webhook events", `ops:repo-activity:${r.id}:webhooks`, "quiet")}${btn("View publications", `ops:repo-activity:${r.id}:comments`, "quiet")}`)}`)}</div>`;
    if (tab === "intake")
      body = panel(
        `<h2 class="ar-title">Assignment intake</h2>${check("Enable static investigation intake", prefix + "static", d.static)}${check("Enable E2E investigation intake", prefix + "e2e", d.e2e)}<p class="ar-muted ar-small">E2E intake permits repository execution and needs eligible workers.</p><div class="ar-grid">${field("Assignment recipient · numeric GitHub user ID", prefix + "reviewer", d.reviewer)}${textarea("Trusted actor user IDs · one per line", prefix + "actors", d.actors, 4)}</div><p class="ar-muted ar-small">Use immutable positive numeric GitHub user IDs, not usernames.</p>`,
      );
    if (tab === "replies") {
      const key = O.replyTemplate || "pullRequest",
        prop =
          key === "pullRequest"
            ? "pullRequestTemplate"
            : key === "issue"
              ? "issueTemplate"
              : `progressTemplates.${key}`;
      const value =
        key === "pullRequest"
          ? d.pullRequestTemplate
          : key === "issue"
            ? d.issueTemplate
            : d.progressTemplates[key];
      body = panel(
        `<h2 class="ar-title">Automated replies</h2>${check("Enable automatic investigation replies", prefix + "autoRepliesEnabled", d.autoRepliesEnabled)}${check("Include assignment progress comments", prefix + "progressEnabled", d.progressEnabled, !d.autoRepliesEnabled)}${!d.autoRepliesEnabled ? '<p class="ar-small ar-muted">Enable automatic replies to include progress comments.</p>' : ""}${select(
          "Reply template",
          "replyTemplate",
          key,
          [
            ["pullRequest", "PR result"],
            ["issue", "Issue result"],
            ["received", "Assignment received"],
            ["started", "Investigation started"],
            ["failed", "Investigation failed"],
            ["completed", "Investigation completed"],
          ],
        )}${textarea("Reply template content", prefix + prop, value, 9)}${help("Template placeholders", `<p>Use each once, in this order: ${replyTokens[key].map((token) => esc("{{" + token + "}}")).join(", ")}.${["received", "started", "failed", "completed"].includes(key) ? " Optional: {{status}} once." : ""}</p>`)}${btn("Preview reply", `ops:reply-preview:${r.id}`)}`,
      );
    }
    if (tab === "scheduling")
      body =
        (repoChangeCount(r.id)
          ? note(
              `${repoChangeCount(r.id)} repository settings changes remain unsaved. ${btn("Return to repository draft", "ops:repo-tab:intake", "quiet small")}`,
            )
          : "") + globalConcurrencyPanel();
    return stack(
      `${back("repositories", "Repositories")}${h.heading(r.name, `Repository settings · v${r.version}`, `<span data-ops-draft-badge class="ar-badge ${repoChangeCount(r.id) + Number(globalChanged()) ? "warning" : "neutral"}">${repoChangeCount(r.id) + Number(globalChanged()) ? (repoChangeCount(r.id) + Number(globalChanged())) + " unsaved changes" : "Saved"}</span>`)}${permissionReason()}${freshnessReason()}${tab === "scheduling" ? "" : draftActions("repo", r.id, repoChangeCount(r.id), allowRepo(r.id) && fresh() && !conflict, "Save settings")}${h.tabs(
        [
          { id: "overview", label: "Overview" },
          { id: "intake", label: "Intake" },
          { id: "replies", label: "Replies" },
          { id: "scheduling", label: "Scheduling · global" },
        ],
        tab,
        "ops:repo-tab:",
      )}${conflictUi}${tab === "scheduling" ? "" : errorSlot}${body}${["intake", "replies"].includes(tab) ? draftActions("repo", r.id, repoChangeCount(r.id), allowRepo(r.id) && fresh() && !conflict, "Save settings", "bottom") : ""}`,
    );
  }

  function accountDraft(id) {
    const saved = O.accounts.find((a) => a.id === id);
    O.accountDrafts[id] ||= saved
      ? { ...saved, permissions: [...saved.permissions], capabilities: [...saved.capabilities] }
      : accountBaseline();
    return O.accountDrafts[id];
  }
  function accounts() {
    if (!state.id) {
      const rows = filterText(O.accounts, O.accountSearch || "").filter(
        (a) => !O.accountState || (O.accountState === "enabled" ? a.enabled : !a.enabled),
      );
      return stack(
        `${h.heading("Accounts", "Workspace-wide", btn("Create account", "ops:open:accounts:new", "primary", !allowAdmin() ? "disabled" : ""))}${permissionReason()}${panel(
          `<div class="ar-toolbar">${field("Search accounts", "accountSearch", O.accountSearch || "", "search", 'placeholder="Name or username"')}${select(
            "Account state",
            "accountState",
            O.accountState || "",
            [
              ["", "All accounts"],
              ["enabled", "Enabled"],
              ["disabled", "Disabled"],
            ],
          )}</div>${row(
            chips([
              ["accountSearch", "Search", O.accountSearch],
              ["accountState", "State", O.accountState],
            ]),
          )}${row(`<span class="ar-small ar-muted" role="status">${rows.length} accounts</span>${btn("Clear filters", "ops:account-clear", "quiet")}`)}`,
        )}${
          rows.length
            ? panel(
                table(
                  ["Account", "State", "Administration", "Repository access", ""],
                  rows.map((a) => [
                    `<strong>${esc(a.displayName)}</strong><div class="ar-small ar-muted">${esc(a.username)}</div>`,
                    badge(a.enabled ? "Enabled" : "Disabled"),
                    a.isAdmin ? "Administrator" : "None",
                    repositoryAccess(a.repositories),
                    btn("View access", `ops:open:accounts:${a.id}`, "quiet"),
                  ]),
                ),
              )
            : h.empty(
                "No matching accounts",
                "Try another name or account state.",
                btn("Clear filters", "ops:account-clear"),
              )
        }`,
      );
    }
    const id = state.id,
      d = accountDraft(id),
      prefix = `acct.${id}.`,
      isNew = id === "new";
    const conflict =
      !isNew &&
      (O.accountConflict === id || (state.scenario === "conflict" && !O.accountReviewed?.[id]));
    return stack(`${back("accounts", "Accounts")}${h.heading(isNew ? "Create account" : d.displayName, isNew ? "" : `${d.username} · v${d.version}`, badge(d.enabled ? "Enabled" : "Disabled"))}${permissionReason()}${freshnessReason()}${draftActions("account", id, accountChangeCount(id), allowAdmin() && fresh() && !conflict, isNew ? "Create account" : "Save access")}${conflict ? note("Account access changed. Compare before saving; your draft is preserved.", "warning") + btn("Compare latest", `ops:account-latest:${id}`, "primary", !fresh() ? "disabled" : "") : ""}${errorSlot}
      <div class="ar-grid">${panel(`<h2 class="ar-title">Identity</h2>${field("Username", prefix + "username", d.username, "text", isNew ? 'autocomplete="off" autocapitalize="none" spellcheck="false"' : "readonly")}${field("Display name", prefix + "displayName", d.displayName)}${isNew ? passwordField("Initial password · 15–128 characters", "ops-new-account-password", "new-password", !allowAdmin()) : btn("Reset password…", `ops:account-reset:${id}`, "", disabledWrite(conflict))}`)}${panel(`<h2 class="ar-title">Administration</h2>${check("Manage dashboard accounts", prefix + "isAdmin", d.isAdmin)}<h3 class="ar-title">Repository scope</h3>${textarea("Exact repository IDs · one per line", prefix + "repositories", d.repositories, 3)}<p class="ar-small ar-muted">Use exact IDs, such as <strong>repo-fixture</strong>. No wildcards.</p>${help("How access grants work", "<p>Account administration, repository scope, permissions and action capabilities are separate grants. E2E also requires repository execution and Create investigations.</p>")}`)}</div>
      <div class="ar-grid">${panel(`<h2 class="ar-title">Operational permissions</h2>${permissions.map(([p, label]) => check(label, prefix + "permission." + p, d.permissions.includes(p))).join("")}<h3 class="ar-title">Repository execution</h3>${check("Allow E2E / repository execution", prefix + "execution", d.execution)}`)}${panel(`<h2 class="ar-title">Action capabilities</h2>${capabilities.map(([name, label]) => check(label, prefix + "capability." + name, d.capabilities.includes(name))).join("")}`)}</div>
      ${draftActions("account", id, accountChangeCount(id), allowAdmin() && fresh() && !conflict, isNew ? "Create account" : "Save access", "bottom")}${!isNew ? panel(`<h2 class="ar-title">Account availability</h2><p class="ar-small ar-muted">Account availability is saved separately from the access draft above.</p>${btn(d.enabled ? "Disable account…" : "Enable account", `ops:account-toggle:${id}`, d.enabled ? "danger" : "", disabledWrite(conflict))}`) : ""}`);
  }

  function myAccount() {
    const account = currentAccount();
    return stack(
      `${h.heading("My account", `${esc(account?.displayName || "")} · ${esc(account?.username || "")}`)}${panel(`<h2 class="ar-title">Session and access</h2><div class="ar-grid">${kv("Repository scope", repositoryAccess(account?.repositories || ""))}${kv("Account administration", account?.isAdmin ? "Granted" : "Not granted")}${kv("Repository execution", account?.execution ? "Allowed for granted repositories" : "Not allowed")}</div>${help("Permissions and capabilities", `${kv("Permissions", esc(account?.permissions.map((p) => permissions.find(([key]) => key === p)?.[1] || p).join(" · ") || "Read-only"))}${kv("Capabilities", esc(account?.capabilities.map((p) => capabilities.find(([key]) => key === p)?.[1] || p).join(" · ") || "None"))}`)}`)}${panel(`<h2 class="ar-title">Change password</h2><p class="ar-small ar-muted">Changing your password signs you out of every session.</p>${errorSlot}<form data-ops-form="password" data-ops-submit="ops:own-password" autocomplete="off" novalidate><div class="ar-grid">${passwordField("Current password", "ops-current-password", "current-password")}${passwordField("New password · 15–128 characters", "ops-own-password")}${passwordField("Confirm new password", "ops-own-confirm")}</div>${row(`${btn("Discard draft", "ops:own-password-discard")}${submitButton("Review password change", "ops:own-password")}`)}</form>`)}`,
    );
  }
  function login() {
    return `<div class="ar-signin">${h.heading("Sign in", "Agentic Review")}${O.loginNotice ? note(O.loginNotice, "info") : ""}${panel(
      `<form data-ops-form="login" data-ops-submit="ops:login" autocomplete="off" novalidate>${errorSlot}${h.field("Username", "ops-login-username", "", "text", 'data-ops="ephemeral.username" autocomplete="username" placeholder="demo.admin" autocapitalize="none" spellcheck="false"')}${passwordField("Password", "ops-login-password", "current-password")}${submitButton("Sign in", "ops:login")}<p class="ar-small ar-muted">Offline simulation. Use any made-up password; values are never stored or sent.</p>${help(
        "Available accounts",
        O.accounts
          .filter((a) => a.enabled)
          .map((a) => btn(esc(a.username), `ops:login-fill:${a.id}`, "quiet small"))
          .join(""),
      )}</form>`,
    )}</div>`;
  }

  function render(page) {
    const pages = {
      comments,
      comment: comments,
      webhooks,
      webhook: webhooks,
      workers,
      worker: workers,
      repositories,
      repository: repositories,
      accounts,
      "account-edit": accounts,
      account: myAccount,
      login,
    };
    const collections = {
      comments: O.comments,
      webhooks: O.webhooks,
      workers: O.workers,
      repositories: O.repositories,
      accounts: O.accounts,
    };
    if (
      state.id &&
      collections[page] &&
      !(page === "accounts" && state.id === "new") &&
      !collections[page].some((record) => record.id === state.id)
    )
      return h.empty(
        "Record unavailable",
        "This record is not in the current directory.",
        btn("Back to directory", `ops:back:${page}`),
      );
    return pages[page] ? pages[page]() : null;
  }

  function commentCommand(id, action, mode = "new") {
    const c = find(O.comments, id);
    O.commentCommands ||= {};
    const request = O.commentCommands[id];
    if (mode === "status" || mode === "replay") {
      if (!request) {
        ctx.toast("There is no retained publication request to inspect.");
        return;
      }
      const unresolved = request.state === "unknown";
      request.message =
        mode === "status"
          ? `Current status loaded. Saved request ${request.id} ${unresolved ? "remains unconfirmed; no new acknowledgement was observed" : "retains its recorded acknowledgement"}. Delivery remains ${c.status}. This lookup did not submit a publication.`
          : `The same request ${request.id} was retried with its retained payload. ${unresolved ? "Its acknowledgement is still unconfirmed." : "Its recorded acknowledgement is unchanged."} Delivery remains ${c.status}; no new request identity was created.`;
      addHistory(
        "comments",
        id,
        mode === "status" ? "Saved request status checked" : "Same request retried",
        unresolved ? "Acknowledgement unknown" : c.status,
        request.message,
        request.id,
      );
    } else if (action === "check") {
      O.commentReadNotice ||= {};
      O.commentReadNotice[id] =
        `Delivery checked: ${c.status}. No publication was submitted; the saved request and its payload are unchanged.`;
      addHistory(
        "comments",
        id,
        "Delivery status checked",
        c.status,
        "Read-only snapshot; no new publication request.",
        request?.id || `fixture-initial-${id}`,
      );
    } else {
      O.requestCounter = (O.requestCounter || 0) + 1;
      const unknown = state.scenario === "unknown";
      O.commentCommands[id] = {
        id: `fixture-request-${id}-${O.requestCounter}`,
        action: "sync",
        state: unknown ? "unknown" : "complete",
        version: c.version,
        body: c.body,
        message: unknown
          ? "Publication request retained; acknowledgement is unknown. Resolve this request before creating another."
          : "Publication request accepted. Delivery is Pending; acceptance does not mean it was delivered.",
      };
      c.status = "Pending";
      c.updated = "Just now";
      if (O.commentReadNotice) delete O.commentReadNotice[id];
      addHistory(
        "comments",
        id,
        "Publication sync submitted",
        unknown ? "Acknowledgement unknown" : "Pending",
        O.commentCommands[id].message,
        O.commentCommands[id].id,
        {
          repository: repoName,
          target: `${c.kind} #${c.number}`,
          version: c.version,
          body: c.body,
        },
      );
    }
    refresh();
  }
  function webhookCommand(id, mode = "new") {
    const w = find(O.webhooks, id);
    O.webhookCommands ||= {};
    if (mode === "status" || mode === "replay") {
      const request = O.webhookCommands[id];
      if (!request) {
        ctx.toast("There is no retained recovery request to inspect.");
        return;
      }
      const unresolved = request.state === "unknown";
      request.message =
        mode === "status"
          ? `Current event status loaded. Saved request ${request.id} ${unresolved ? "remains unconfirmed; no new acknowledgement was observed" : "retains its recorded acknowledgement"}. Handling remains ${w.state}. No retry was scheduled by this status check.`
          : `The same request ${request.id} was retried with its retained payload. ${unresolved ? "Its acknowledgement is still unconfirmed." : "Its recorded acknowledgement is unchanged."} Handling remains ${w.state}; no new recovery identity was created.`;
      addHistory(
        "webhooks",
        id,
        mode === "status" ? "Saved request status checked" : "Same request retried",
        unresolved ? "Acknowledgement unknown" : w.state,
        request.message,
        request.id,
      );
    } else {
      const unknown = state.scenario === "unknown";
      O.requestCounter = (O.requestCounter || 0) + 1;
      w.attempt = (w.attempt || 1) + 1;
      O.webhookCommands[id] = {
        id: `fixture-recovery-${id}-${O.requestCounter}`,
        state: unknown ? "unknown" : "complete",
        attempt: w.attempt,
        message: unknown
          ? "Saved recovery request awaiting acknowledgement. Resolve the same request before retrying again."
          : "Recovery accepted. Event handling is scheduled; no existing Task was restarted.",
      };
      w.state = "Retry scheduled";
      w.reason = "Awaiting the next handling attempt";
      addHistory(
        "webhooks",
        id,
        `Handling attempt ${w.attempt} scheduled`,
        unknown ? "Acknowledgement unknown" : w.state,
        "No existing Task restarted. A later handling result is required.",
        O.webhookCommands[id].id,
        { event: w.id, repository: repoName, target: w.target, mode: w.mode, attempt: w.attempt },
      );
    }
    refresh();
  }

  function acknowledgeRequest(type, id) {
    const request = (type === "comment" ? O.commentCommands : O.webhookCommands)?.[id];
    if (request?.state !== "unknown") {
      ctx.toast("There is no unconfirmed saved request to acknowledge.");
      return;
    }
    request.state = "complete";
    request.message = `Request ${request.id} acknowledged. Waiting for the ${type === "comment" ? "delivery" : "handling"} result.`;
    if (type === "comment") {
      const publication = find(O.comments, id);
      publication.status = "Pending";
      publication.updated = "Just now";
    } else {
      const event = find(O.webhooks, id);
      event.state = "Retry scheduled";
      event.attempt = request.attempt;
      event.reason = "Awaiting the handling result";
    }
    O.simulationOpen ||= {};
    O.simulationOpen[`${type}:${id}`] = true;
    addHistory(
      type === "comment" ? "comments" : "webhooks",
      id,
      "Prototype request acknowledgement received",
      "Acknowledged",
      request.message,
      request.id,
    );
    refresh();
  }

  function commentOutcome(id, outcome) {
    const c = find(O.comments, id),
      request = O.commentCommands?.[id];
    if (c.status !== "Pending" || request?.state === "unknown") {
      ctx.toast(
        "Only a pending publication with a resolved acknowledgement can receive a simulated result.",
      );
      return;
    }
    c.status = outcome === "success" ? "Delivered" : "Failed";
    c.updated = "Just now";
    const detail =
      outcome === "success"
        ? "Synthetic delivery completed. The retained exact body is marked Delivered; nothing was sent to GitHub."
        : "Synthetic delivery failed. The exact body and prior request remain available; review and submit a new sync when ready.";
    if (request) {
      request.result = c.status;
      request.message = detail;
    }
    if (O.commentReadNotice) delete O.commentReadNotice[id];
    addHistory(
      "comments",
      id,
      "Prototype delivery result received",
      c.status,
      detail,
      request?.id || `fixture-initial-${id}`,
    );
    refresh();
  }
  function webhookOutcome(id, outcome) {
    const w = find(O.webhooks, id),
      request = O.webhookCommands?.[id];
    if (w.state !== "Retry scheduled" || request?.state === "unknown") {
      ctx.toast(
        "Only a scheduled attempt with a resolved acknowledgement can receive a simulated result.",
      );
      return;
    }
    if (outcome === "success") {
      const routeId = String(w.number),
        taskExists = ctx.hasRecord?.("tasks", routeId) === true;
      if (!w.task && taskExists) {
        w.task = `task-${routeId}`;
        w.reusedTask = true;
      }
      const publication = O.comments.find((c) => c.task === w.task);
      if (!w.comment && publication) w.comment = publication.id;
      w.state = "Processed";
      w.phase = "Handling complete";
      w.reason = w.task
        ? "Handling completed; existing Task linked."
        : "Handling completed; no Task or publication linked.";
    } else {
      w.state = "Failed";
      w.phase = "Source import";
      w.reason = "Source import failed again.";
    }
    if (request) {
      request.result = w.state;
      request.message = w.reason;
    }
    addHistory(
      "webhooks",
      id,
      `Prototype result for attempt ${w.attempt || 1}`,
      w.state,
      w.reason,
      request?.id || `fixture-initial-${id}`,
    );
    refresh();
  }

  function handle(action, el) {
    if (!action.startsWith("ops:")) return false;
    const [_, key, id, arg] = action.split(":");
    const adminActions =
      /^(worker-(disable|confirm|enable|proof|reviewed)|global-save|account-(save|toggle|toggle-confirm|reset|reset-confirm|keep|use-latest))$/;
    const needsFresh =
      /^(comment-(sync|confirm|review|reviewed)|webhook-(retry|confirm|review|reviewed)|worker-(disable|confirm|enable|proof|review|reviewed)|repo-(save|latest|keep|use-latest)|global-save|account-(save|toggle|toggle-confirm|reset|reset-confirm|latest|keep|use-latest))$/;
    if (adminActions.test(key) && !allowAdmin()) {
      ctx.toast("This change requires account administration.");
      return true;
    }
    if (/^repo-(save|keep|use-latest)$/.test(key) && !allowRepo(id)) {
      ctx.toast("This change requires the exact repository grant and Manage repositories.");
      return true;
    }
    if (/^comment-(sync|confirm|replay|outcome|acknowledge)$/.test(key) && !allowSync()) {
      ctx.toast(
        "Publication requires this repository, Prepare actions, Execute actions and Comment capability.",
      );
      return true;
    }
    if (
      /^webhook-(retry|confirm|replay|status|outcome|acknowledge)$/.test(key) &&
      !allowRecovery(id)
    ) {
      ctx.toast(
        "Recovery requires this repository, Manage repositories and Create investigations; E2E also requires repository execution.",
      );
      return true;
    }
    if (["comment-check", "comment-status"].includes(key) && !allowPrepare()) {
      ctx.toast("Checking delivery requires Prepare actions for this repository.");
      return true;
    }
    if (needsFresh.test(key) && !fresh()) {
      ctx.toast(
        "Refresh successfully before submitting a new change. Your draft remains available.",
      );
      return true;
    }
    if (
      /^worker-(disable|confirm|enable)$/.test(key) &&
      state.scenario === "conflict" &&
      !O.workerReviewed?.[id]
    ) {
      ctx.toast("Review the current worker policy before changing admission.");
      return true;
    }
    if (
      [
        "account-toggle",
        "account-toggle-confirm",
        "account-reset",
        "account-reset-confirm",
      ].includes(key) &&
      state.scenario === "conflict" &&
      !O.accountReviewed?.[id]
    ) {
      ctx.toast("Compare the latest account access before making changes.");
      return true;
    }
    if (
      ["comment-sync", "comment-confirm", "comment-check"].includes(key) &&
      (O.commentCommands?.[id]?.state === "unknown" ||
        (state.scenario === "conflict" && !O.commentReviewed?.[id]))
    ) {
      ctx.toast("Resolve the retained request or review the current publication first.");
      return true;
    }
    if (
      ["comment-sync", "comment-confirm"].includes(key) &&
      find(O.comments, id).status === "Pending"
    ) {
      ctx.toast(
        "Wait for the pending delivery outcome before starting another publication request.",
      );
      return true;
    }
    if (
      ["webhook-retry", "webhook-confirm"].includes(key) &&
      (find(O.webhooks, id).state !== "Failed" ||
        O.webhookCommands?.[id]?.state === "unknown" ||
        (state.scenario === "conflict" && !O.webhookReviewed?.[id]))
    ) {
      ctx.toast("Only a reviewed failed event with no pending recovery can be retried.");
      return true;
    }
    switch (key) {
      case "dialog-close":
        ctx.closeDialog();
        break;
      case "focus-field":
        ctx.root.querySelector(`#${CSS.escape(String(id))}`)?.focus();
        break;
      case "all-repositories":
        (ctx.guardNavigation || ((fn) => fn()))(() => {
          state.repo = "all";
          viewChanged();
        });
        break;
      case "open":
      case "nav":
        ctx.nav(
          id,
          arg && ["tasks", "reports"].includes(id)
            ? arg.replace(/^(task|report)-/, "")
            : arg || null,
        );
        break;
      case "back":
        ctx.nav(id, null);
        break;
      case "refresh":
        if (state.scenario === "refresh-error") state.scenario = "normal";
        O.lastRefresh ||= {};
        O.lastRefresh[id] = new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        state.lastSuccess = O.lastRefresh[id];
        refresh();
        ctx.toast("Snapshot refreshed.");
        break;
      case "filter-remove":
        if (Object.hasOwn(viewKeys[state.page] || {}, id)) {
          O[id] = "";
          viewChanged();
        }
        break;
      case "password-show": {
        const input = ctx.root.querySelector(`#${CSS.escape(String(id))}`);
        if (!input) break;
        const show = input.type === "password",
          start = input.selectionStart,
          end = input.selectionEnd;
        input.type = show ? "text" : "password";
        el ||= ctx.root.querySelector(`[data-action="${action}"]`);
        if (el) {
          el.innerHTML = h.icon(show ? "eye-off" : "eye");
          el.setAttribute("aria-pressed", String(show));
          el.setAttribute(
            "aria-label",
            `${show ? "Hide" : "Show"} ${input.getAttribute("aria-label") || "password"}`,
          );
        }
        globalThis.ARMaterialAssets?.paintIcons(ctx.root);
        globalThis.ARMaterialControls?.sync();
        input.focus({ preventScroll: true });
        if (typeof start === "number") input.setSelectionRange(start, end);
        break;
      }
      case "comment-filters":
        O.commentMore = !O.commentMore;
        viewChanged();
        break;
      case "comment-clear":
        O.commentKind =
          O.commentStatus =
          O.commentNumber =
          O.commentType =
          O.commentTask =
          O.commentSearch =
            "";
        state.q = "";
        viewChanged();
        break;
      case "comment-remove":
        if (Object.hasOwn(viewKeys.comments, id)) {
          O[id] = "";
          if (id === "commentSearch") state.q = "";
          viewChanged();
        }
        break;
      case "comment-check":
        commentCommand(id, "check");
        break;
      case "comment-review": {
        const c = find(O.comments, id);
        dialog(
          "Review current publication",
          stack(
            `${kv("Publication", esc(`${id} · current version v${c.version + 1}`))}${kv("Current delivery", badge(c.status))}<h2 class="ar-title">Current retained body</h2><pre style="white-space:pre-wrap;font:inherit">${esc(c.body)}</pre>${note("No comment is sent by reviewing this version. The next publication request will use this version and exact body.")}`,
          ),
          "I reviewed this version",
          `ops:comment-reviewed:${id}`,
        );
        break;
      }
      case "comment-reviewed": {
        const c = find(O.comments, id);
        c.version++;
        O.commentReviewed ||= {};
        O.commentReviewed[id] = true;
        ctx.closeDialog();
        refresh();
        break;
      }
      case "comment-status":
      case "comment-replay": {
        commentCommand(id, "sync", key === "comment-status" ? "status" : "replay");
        break;
      }
      case "comment-outcome":
        if (["success", "failure"].includes(arg)) commentOutcome(id, arg);
        break;
      case "comment-acknowledge":
        acknowledgeRequest("comment", id);
        break;
      case "comment-sync": {
        const c = find(O.comments, id);
        dialog(
          "Confirm publication sync",
          stack(
            `${note("Creates or updates one GitHub comment.", "warning")}${kv("Repository", esc(repoName))}${kv("Target", esc(`${c.kind} #${c.number}`))}${kv("Publication", esc(`${id} · version ${c.version}`))}<h3 class="ar-title">Exact body to publish</h3><pre style="white-space:pre-wrap;font:inherit">${esc(c.body)}</pre>`,
          ),
          "Sync this publication",
          `ops:comment-confirm:${id}`,
        );
        break;
      }
      case "comment-confirm":
        ctx.closeDialog();
        commentCommand(id, "sync");
        break;
      case "webhook-clear":
        O.webhookState = O.webhookSearch = O.webhookKind = O.webhookMode = O.webhookNumber = "";
        viewChanged();
        break;
      case "webhook-review": {
        const w = find(O.webhooks, id);
        dialog(
          "Review current event",
          stack(
            `${kv("Event", esc(`${id} · ${w.target}`))}${kv("Current handling state", badge(w.state))}${kv("Failed phase", esc(w.phase))}<p>${esc(w.reason)}</p>${note("Reviewing does not retry handling. Confirm this current state before scheduling another attempt.")}`,
          ),
          "I reviewed this event",
          `ops:webhook-reviewed:${id}`,
        );
        break;
      }
      case "webhook-reviewed":
        O.webhookReviewed ||= {};
        O.webhookReviewed[id] = true;
        ctx.closeDialog();
        refresh();
        break;
      case "webhook-status":
      case "webhook-replay":
        webhookCommand(id, key === "webhook-status" ? "status" : "replay");
        break;
      case "webhook-outcome":
        if (["success", "failure"].includes(arg)) webhookOutcome(id, arg);
        break;
      case "webhook-acknowledge":
        acknowledgeRequest("webhook", id);
        break;
      case "webhook-retry": {
        const w = find(O.webhooks, id);
        dialog(
          "Retry event handling",
          stack(
            `${kv("Event", esc(`${id} · ${w.event}`))}${kv("Repository / target", esc(`${repoName} · ${w.target}`))}${kv("Failed phase", esc(w.phase))}${note("Retries this event and may create a Task and automated replies. Existing Tasks are not restarted.")}`,
          ),
          "Retry this event",
          `ops:webhook-confirm:${id}`,
        );
        break;
      }
      case "webhook-confirm":
        ctx.closeDialog();
        webhookCommand(id);
        break;
      case "worker-clear":
        O.workerSearch = O.workerContact = O.workerCleanup = "";
        viewChanged();
        break;
      case "worker-review": {
        const w = find(O.workers, id);
        dialog(
          "Review current admission policy",
          stack(
            `${kv("Worker", esc(id))}${kv("Current server policy", badge(w.admission, "neutral"))}${kv("Current cleanup", badge(w.cleanup))}${kv("Saved version", `v${(w.version || 3) + 1}`)}${note("No admission change will be applied. Review this current policy, then choose whether to change it.")}`,
          ),
          "I reviewed the current policy",
          `ops:worker-reviewed:${id}`,
        );
        break;
      }
      case "worker-reviewed": {
        const w = find(O.workers, id);
        w.version = (w.version || 3) + 1;
        O.workerReviewed ||= {};
        O.workerReviewed[id] = true;
        ctx.closeDialog();
        refresh();
        break;
      }
      case "worker-disable": {
        const w = find(O.workers, id);
        dialog(
          "Stop E2E work?",
          stack(
            `${kv("Worker", esc(id))}${kv("Active E2E ownership", w.owner ? `Task ${esc(w.owner)}` : "No owner")}${note("This stops new E2E work and requests cancellation of currently owned E2E work. Static tasks continue under their existing policy. E2E resources remain owned until the worker reports cleanup.", "warning")}`,
          ),
          "Stop E2E work",
          `ops:worker-confirm:${id}`,
          true,
        );
        break;
      }
      case "worker-confirm": {
        const w = find(O.workers, id);
        w.admission = "Disabled";
        w.version = (w.version || 3) + 1;
        w.cleanup = w.owner ? "Awaiting cleanup" : "No pending cleanup";
        w.effective = (w.advertised || []).filter((kind) => kind !== "PR E2E");
        if (w.owner)
          ctx.workerEvent?.({
            type: "admission-disabled",
            workerId: w.id,
            taskId: String(w.owner).replace(/^task-/, ""),
          });
        w.events ||= [];
        w.events.unshift([
          "Just now",
          "E2E admission disabled",
          w.owner
            ? "Owned E2E cancellation requested; awaiting cleanup report"
            : "No E2E ownership to release",
        ]);
        ctx.closeDialog();
        refresh();
        break;
      }
      case "worker-enable": {
        const w = find(O.workers, id);
        if (w.cleanup === "Awaiting cleanup" || !w.advertised?.includes("PR E2E")) {
          ctx.toast(
            "Wait for E2E capability and any pending cleanup report before enabling admission.",
          );
          break;
        }
        w.admission = "Enabled";
        w.version = (w.version || 3) + 1;
        w.effective = [...(w.advertised || [])];
        w.events ||= [];
        w.events.unshift([
          "Just now",
          "E2E task admission allowed",
          "Effective task types follow advertised capabilities",
        ]);
        refresh();
        break;
      }
      case "worker-cleanup": {
        const w = find(O.workers, id);
        ctx.openDialog(
          "Cleanup acknowledgement",
          stack(
            `${kv("Worker", esc(id))}${kv("State", badge(w.cleanup))}${kv("Last contact", esc(w.seen))}<p>The worker must report that its owned processes, desktop sessions and workspaces have been released.</p>${note("Refreshing the dashboard only updates the snapshot. It does not prove that cleanup completed.", "warning")}`,
          ),
          btn("Close", "ops:dialog-close"),
        );
        break;
      }
      case "worker-proof": {
        const w = find(O.workers, id);
        if (w.cleanup !== "Awaiting cleanup") {
          ctx.toast("This worker has no pending cleanup acknowledgement.");
          break;
        }
        if (w.owner)
          ctx.workerEvent?.({
            type: "cleanup-acknowledged",
            workerId: w.id,
            taskId: String(w.owner).replace(/^task-/, ""),
          });
        w.cleanup = "Complete";
        w.active = 0;
        w.owner = null;
        w.contact = "Recent contact";
        w.seen = "Just now";
        w.events ||= [];
        w.events.unshift([
          "Just now",
          "Synthetic E2E cleanup report received",
          `Owned E2E resources released; E2E admission remains ${w.admission === "Enabled" ? "allowed" : "off"}`,
        ]);
        refresh();
        break;
      }
      case "repo-tab":
        if (["overview", "intake", "replies", "scheduling"].includes(id)) setSection(id);
        break;
      case "repo-clear":
        O.repoSearch = "";
        viewChanged();
        break;
      case "repo-activity":
        (ctx.guardNavigation || ((fn) => fn()))(() => {
          state.repo = id;
          ctx.nav(arg, null);
        });
        break;
      case "repo-save": {
        const r = find(O.repositories, id),
          d = repoDraft(id);
        if (!repoChangeCount(id)) {
          clean();
          ctx.toast("No changes to save. The repository version is unchanged.");
          return true;
        }
        if ((d.static || d.e2e) && (!/^[1-9]\d*$/.test(d.reviewer.trim()) || !d.actors.trim())) {
          setSection("intake");
          focusError(
            "Enabled intake requires a numeric assignment recipient and at least one trusted actor.",
            !/^[1-9]\d*$/.test(d.reviewer.trim())
              ? `ops-repo-${id}-reviewer`
              : `ops-repo-${id}-actors`,
          );
          break;
        }
        if (
          d.actors.trim() &&
          d.actors
            .trim()
            .split(/[\s,]+/)
            .some((v) => !/^[1-9]\d*$/.test(v))
        ) {
          setSection("intake");
          focusError(
            "Trusted actor IDs must be positive numeric GitHub user IDs.",
            `ops-repo-${id}-actors`,
          );
          break;
        }
        if (d.progressEnabled && !d.autoRepliesEnabled) {
          setSection("replies");
          focusError(
            "Assignment progress comments require automatic replies to be enabled.",
            `ops-repo-${id}-autoRepliesEnabled`,
          );
          break;
        }
        let invalidTemplate = null;
        for (const [key, tokens] of Object.entries(replyTokens)) {
          const value =
            key === "pullRequest"
              ? d.pullRequestTemplate
              : key === "issue"
                ? d.issueTemplate
                : d.progressTemplates[key];
          const actual = [...value.matchAll(/\{\{([a-z_]+)\}\}/g)].map((match) => match[1]);
          const isProgress = !["pullRequest", "issue"].includes(key);
          const required = isProgress ? actual.filter((token) => token !== "status") : actual;
          if (
            JSON.stringify(required) !== JSON.stringify(tokens) ||
            actual.filter((token) => token === "status").length > (isProgress ? 1 : 0) ||
            /\{\{|\}\}/.test(value.replace(/\{\{[a-z_]+\}\}/g, ""))
          ) {
            invalidTemplate = key;
            break;
          }
        }
        if (invalidTemplate) {
          O.replyTemplate = invalidTemplate;
          setSection("replies");
          const guide = Array.from(ctx.root.querySelectorAll("details")).find(
            (node) => node.querySelector("summary")?.textContent === "Template placeholders",
          );
          if (guide) guide.open = true;
          const prop =
            invalidTemplate === "pullRequest"
              ? "pullRequestTemplate"
              : invalidTemplate === "issue"
                ? "issueTemplate"
                : `progressTemplates-${invalidTemplate}`;
          focusError(
            "Use each required placeholder once, in the listed order. Remove unknown or incomplete placeholders.",
            `ops-repo-${id}-${prop}`,
          );
          break;
        }
        if (state.scenario === "conflict" && !O.repoReviewed?.[id]) {
          O.repoConflict = id;
          refresh();
          break;
        }
        O.repoSaved[id] = clone(d);
        r.version++;
        r.mode = intakeMode(d);
        clean();
        refresh();
        ctx.toast("Repository settings saved.");
        break;
      }
      case "repo-discard":
        dialog(
          "Discard settings draft",
          "<p>Your local edits will be replaced by the last saved settings for this repository.</p>",
          "Discard draft",
          `ops:repo-discard-confirm:${id}`,
          true,
        );
        break;
      case "repo-discard-confirm":
        O.repoDrafts[id] = clone(O.repoSaved[id]);
        clean();
        ctx.closeDialog();
        refresh();
        break;
      case "repo-latest":
        O.repoLatest = id;
        refresh();
        break;
      case "repo-keep":
      case "repo-use-latest": {
        const r = find(O.repositories, id);
        r.version++;
        O.repoSaved[id] = { ...O.repoSaved[id], e2e: false, actors: "10041" };
        r.mode = intakeMode(O.repoSaved[id]);
        if (key === "repo-use-latest") {
          O.repoDrafts[id] = clone(O.repoSaved[id]);
          clean();
        } else mark();
        O.repoReviewed ||= {};
        O.repoReviewed[id] = true;
        O.repoConflict = null;
        O.repoLatest = null;
        refresh();
        break;
      }
      case "repo-export":
        ctx.download(
          `repository-${id}-draft.json`,
          JSON.stringify(repoDraft(id), null, 2),
          "application/json",
        );
        break;
      case "reply-preview": {
        const d = repoDraft(id),
          key = O.replyTemplate || "pullRequest";
        const template =
          key === "pullRequest"
            ? d.pullRequestTemplate
            : key === "issue"
              ? d.issueTemplate
              : d.progressTemplates[key];
        const values = {
          identity:
            key === "issue"
              ? "Issue #3101 · Settings does not open after an update"
              : "PR #2101 · Preserve settings when a migration is cancelled",
          conclusion: "Needs review",
          summary: "Static investigation completed. Runtime validation has not run.",
          findings: "2 findings retained for review.",
          next_steps: "Run the proposed verification plan; reproduction is not yet confirmed.",
          details: "Synthetic saved report and evidence details.",
          status: "Investigation progress",
          trigger: "Assignment received from trusted fixture actor.",
          updated_at: "21 Sep 2026, 12:42",
          failure: "Synthetic source import failure; review handling status.",
          result: "Investigation completed; review the retained result.",
        };
        const body = template.replace(/\{\{([a-z_]+)\}\}/g, (full, token) => values[token] || full);
        ctx.openDialog(
          "Automated reply preview",
          `<div class="ar-panel" style="white-space:pre-wrap">${esc(body)}</div>`,
          btn("Close preview", "ops:dialog-close"),
        );
        break;
      }
      case "global-save": {
        const v = Number(read("ops-globalConcurrencyDraft"));
        if (!Number.isInteger(v) || v < 1 || v > 16) {
          focusError("Enter a whole number from 1 to 16.", "ops-globalConcurrencyDraft");
          break;
        }
        if (v === O.globalConcurrency) {
          delete O.globalConcurrencyDraft;
          clean();
          ctx.toast("No concurrency change to save.");
          break;
        }
        O.globalConcurrency = v;
        delete O.globalConcurrencyDraft;
        O.globalSaveNotice = `Global static concurrency saved as ${v}. This applies to every repository.`;
        clean();
        refresh();
        break;
      }
      case "global-discard":
        delete O.globalConcurrencyDraft;
        O.globalSaveNotice = "";
        clean();
        refresh();
        break;
      case "account-clear":
        O.accountState = O.accountSearch = "";
        viewChanged();
        break;
      case "account-save": {
        const d = accountDraft(id),
          isNew = id === "new";
        if (isNew) {
          d.username = d.username.trim().toLowerCase();
          const usernameInput = ctx.root.querySelector("#ops-acct-new-username");
          if (usernameInput) usernameInput.value = d.username;
        }
        if (!isNew && !accountChangeCount(id)) {
          clean();
          ctx.toast("No access changes to save. The account version is unchanged.");
          return true;
        }
        if (isNew && !/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(d.username)) {
          focusError(
            "Use a 3–64 character username with letters, numbers, periods, underscores or hyphens.",
            `ops-acct-${id}-username`,
          );
          break;
        }
        if (
          isNew &&
          O.accounts.some((a) => a.username.toLowerCase() === d.username.toLowerCase())
        ) {
          focusError("An account with that username already exists.", `ops-acct-${id}-username`);
          break;
        }
        if (!d.displayName.trim() || d.displayName.length > 120) {
          focusError(
            "Enter a display name between 1 and 120 characters.",
            `ops-acct-${id}-displayName`,
          );
          break;
        }
        if (isNew && !validPassword(read("ops-new-account-password"))) {
          focusError(
            "Use a made-up password between 15 and 128 characters.",
            "ops-new-account-password",
          );
          break;
        }
        if (d.repositories.includes("*")) {
          focusError(
            "Use exact repository IDs. Wildcards are not supported.",
            `ops-acct-${id}-repositories`,
          );
          break;
        }
        if (!isNew && state.scenario === "conflict" && !O.accountReviewed?.[id]) {
          O.accountConflict = id;
          refresh();
          break;
        }
        if (isNew) {
          const saved = {
            ...d,
            username: d.username.trim(),
            displayName: d.displayName.trim(),
            id: `acct-${O.accounts.length + 1}`,
            version: 1,
          };
          O.accounts.push(saved);
          delete O.accountDrafts.new;
          O.passwordDirty = false;
          clean();
          ctx.nav("accounts", saved.id);
        } else {
          const index = O.accounts.findIndex((a) => a.id === id),
            saved = O.accounts[index];
          const ownAccessChanged =
            id === currentAccountId() &&
            ["isAdmin", "repositories", "permissions", "capabilities", "execution"].some(
              (key) => JSON.stringify(canonical(d[key])) !== JSON.stringify(canonical(saved[key])),
            );
          O.accounts[index] = {
            ...d,
            displayName: d.displayName.trim(),
            permissions: [...d.permissions],
            capabilities: [...d.capabilities],
            version: d.version + 1,
          };
          delete O.accountDrafts[id];
          clean();
          if (ownAccessChanged) {
            discardDirty();
            ctx.clearPrivateSession?.();
            O.sessionAccountId = id;
            O.signedOut = false;
            state.role = d.isAdmin ? "admin" : d.permissions.length ? "preparer" : "reader";
          }
          refresh();
        }
        ctx.toast("Account access saved.");
        break;
      }
      case "account-discard":
        dialog(
          "Discard access draft",
          "<p>Your local access edits will be replaced by the saved account.</p>",
          "Discard draft",
          `ops:account-discard-confirm:${id}`,
          true,
        );
        break;
      case "account-discard-confirm":
        delete O.accountDrafts[id];
        if (id === "new") {
          O.passwordDirty = false;
          const input = ctx.root.querySelector("#ops-new-account-password");
          if (input) input.value = "";
        }
        clean();
        ctx.closeDialog();
        refresh();
        break;
      case "account-latest": {
        const d = accountDraft(id);
        ctx.openDialog(
          "Compare account access",
          `${note("Latest access removed repository execution. Your draft is preserved.")}${table(
            ["Permission", "Your draft", "Latest saved"],
            [
              ["Repository execution", d.execution ? "Allowed" : "Not allowed", "Not allowed"],
              ["Account version", `v${d.version}`, `v${d.version + 1}`],
            ],
          )}`,
          `${btn("Cancel", "ops:dialog-close", "quiet")}${btn("Use latest access", `ops:account-use-latest:${id}`, "", !allowAdmin() ? "disabled" : "")}${btn("Keep my draft", `ops:account-keep:${id}`, "primary", !allowAdmin() ? "disabled" : "")}`,
        );
        break;
      }
      case "account-keep":
      case "account-use-latest": {
        const d = accountDraft(id),
          saved = O.accounts.find((a) => a.id === id);
        if (saved) {
          saved.execution = false;
          saved.version++;
          d.version = saved.version;
        }
        if (key === "account-use-latest") delete O.accountDrafts[id];
        O.accountReviewed ||= {};
        O.accountReviewed[id] = true;
        O.accountConflict = null;
        ctx.closeDialog();
        clean();
        refresh();
        break;
      }
      case "account-toggle": {
        const a = find(O.accounts, id);
        if (a.enabled)
          dialog(
            "Disable account",
            `${kv("Account", esc(`${a.displayName} · ${a.username}`))}${note("The account will be prevented from signing in and existing sessions will be invalidated.", "warning")}${id === currentAccountId() ? "<p>This is your current account. You will be signed out, and any unsaved access draft will be discarded.</p>" : ""}`,
            id === currentAccountId() ? "Disable my account and sign out" : "Disable account",
            `ops:account-toggle-confirm:${id}`,
            true,
          );
        else {
          a.enabled = true;
          a.version++;
          if (O.accountDrafts[id]) {
            O.accountDrafts[id].enabled = true;
            O.accountDrafts[id].version = a.version;
          }
          refresh();
        }
        break;
      }
      case "account-toggle-confirm": {
        const a = find(O.accounts, id);
        a.enabled = false;
        a.version++;
        if (O.accountDrafts[id]) {
          O.accountDrafts[id].enabled = false;
          O.accountDrafts[id].version = a.version;
        }
        ctx.closeDialog();
        if (id === currentAccountId())
          endSession(
            "Your sample account was disabled. This session has ended. Use another enabled demo account to continue.",
          );
        else refresh();
        break;
      }
      case "account-reset": {
        const a = find(O.accounts, id);
        ctx.openDialog(
          "Reset account password",
          `<form id="ops-reset-form" data-ops-submit="ops:account-reset-confirm:${id}" autocomplete="off" novalidate>${stack(`${kv("Account", esc(`${a.displayName} · ${a.username}`))}${errorSlot}${passwordField("New password · 15–128 characters", "ops-reset-password")}${passwordField("Confirm password", "ops-reset-confirm")}<label class="ar-row ar-small"><input id="ops-reset-ack" aria-label="I understand this invalidates every session for this account." type="checkbox" data-ops="ephemeral.reset-ack"> <span>I understand this invalidates every session for this account.</span></label>${id === currentAccountId() ? "<p>This is your current account. Resetting its password signs you out and discards any unsaved access draft.</p>" : ""}<p class="ar-small ar-muted">Use a made-up value. No password is saved or sent.</p>`)}</form>`,
          `${btn("Cancel", "dialog-close", "quiet")}${submitButton(id === currentAccountId() ? "Reset password and sign out" : "Reset password", `ops:account-reset-confirm:${id}`, "danger", 'form="ops-reset-form"')}`,
        );
        break;
      }
      case "account-reset-confirm": {
        if (!validPassword(read("ops-reset-password"))) {
          focusError("Use a password between 15 and 128 characters.", "ops-reset-password");
          break;
        }
        if (read("ops-reset-password") !== read("ops-reset-confirm")) {
          focusError("The passwords do not match.", "ops-reset-confirm");
          break;
        }
        if (!checked("ops-reset-ack")) {
          focusError("Acknowledge the session consequence to continue.", "ops-reset-ack");
          break;
        }
        const a = find(O.accounts, id);
        a.version++;
        if (O.accountDrafts[id]) O.accountDrafts[id].version = a.version;
        ctx.closeDialog();
        if (id === currentAccountId())
          endSession(
            "Your password reset was simulated. This session has ended; sign in again to continue.",
          );
        else {
          refresh();
          ctx.openDialog(
            "Password reset simulated",
            `<p>The password reset for <strong>${esc(a.username)}</strong> was accepted in this demo. Its simulated sessions have been invalidated. No password was stored.</p>`,
            btn("Done", "ops:dialog-close", "primary"),
          );
        }
        break;
      }
      case "own-password": {
        if (!read("ops-current-password")) {
          focusError("Enter a made-up current password to continue.", "ops-current-password");
          break;
        }
        if (!validPassword(read("ops-own-password"))) {
          focusError("Use a new password between 15 and 128 characters.", "ops-own-password");
          break;
        }
        if (read("ops-own-password") !== read("ops-own-confirm")) {
          focusError("The new passwords do not match.", "ops-own-confirm");
          break;
        }
        if (read("ops-own-password") === read("ops-current-password")) {
          focusError(
            "Choose a new password different from the current password.",
            "ops-own-password",
          );
          break;
        }
        dialog(
          "Change password and sign out",
          "<p>This ends your current session and invalidates every other session.</p>",
          "Change password and sign out",
          "ops:own-password-confirm",
        );
        break;
      }
      case "own-password-discard":
        dialog(
          "Discard password draft",
          "<p>The made-up values in this form will be cleared.</p>",
          "Discard password draft",
          "ops:own-password-discard-confirm",
          true,
        );
        break;
      case "own-password-discard-confirm":
        O.passwordDirty = false;
        ctx.closeDialog();
        ctx.root.querySelectorAll('[data-ops^="ephemeral."]').forEach((input) => {
          input.value = "";
        });
        clean();
        refresh();
        break;
      case "own-password-confirm":
        ctx.closeDialog();
        endSession("Password change simulated. Sign in again to continue.");
        break;
      case "login-fill": {
        const account = O.accounts.find((a) => a.id === id && a.enabled),
          input = ctx.root.querySelector("#ops-login-username");
        if (account && input) {
          input.value = account.username;
          change(input);
          ctx.root.querySelector("#ops-login-password")?.focus();
        }
        break;
      }
      case "login": {
        const username = read("ops-login-username").trim().toLowerCase(),
          password = read("ops-login-password");
        if (!username || !password) {
          focusError(
            "Enter a username and made-up password.",
            !username ? "ops-login-username" : "ops-login-password",
          );
          break;
        }
        const account = O.accounts.find((a) => a.username.toLowerCase() === username);
        if (!account) {
          focusError("Account not found. Choose an available account below.", "ops-login-username");
          break;
        }
        if (!account.enabled) {
          focusError("This account is disabled. Choose another account.", "ops-login-username");
          break;
        }
        ctx.clearPrivateSession?.();
        O.signedOut = false;
        O.sessionAccountId = account.id;
        state.role = account.isAdmin ? "admin" : account.permissions.length ? "preparer" : "reader";
        O.loginNotice = "";
        ctx.nav("pulls", null);
        ctx.toast(`Signed in as ${account.username}.`);
        break;
      }
      default:
        return false;
    }
    return true;
  }
  function validPassword(value) {
    return value.length >= 15 && value.length <= 128 && /\S/.test(value);
  }
  function change(el) {
    const key = el.dataset.ops;
    if (!key) return false;
    if (el.disabled || el.readOnly || locked(key)) return true;
    const inlineError = ctx.root.querySelector(`#${CSS.escape(el.id + "-error")}`);
    inlineError?.remove();
    el.removeAttribute("aria-invalid");
    el.removeAttribute("aria-describedby");
    const errorScope = el.closest("dialog") || ctx.root;
    const invalidSources = Array.from(errorScope.querySelectorAll('[aria-invalid="true"]')).some(
      (input) =>
        !input.dataset.materialSource &&
        !input.closest(".ar-material-form-control,.ar-material-choice-host"),
    );
    if (!invalidSources) {
      const summary = errorScope.querySelector("[data-ops-error]");
      if (summary) {
        summary.hidden = true;
        summary.textContent = "";
      }
    }
    if (key.startsWith("ephemeral.")) {
      if (state.page !== "login" && !el.closest("dialog")) {
        O.passwordDirty = Array.from(ctx.root.querySelectorAll('[data-ops^="ephemeral."]')).some(
          (input) => !input.closest("dialog") && Boolean(input.value),
        );
        mark();
      }
      return true;
    }
    const value = el.type === "checkbox" ? el.checked : el.value;
    if (key.startsWith("repo.")) {
      const [_, id, prop, nested] = key.split(".");
      if (prop === "progressTemplates") repoDraft(id).progressTemplates[nested] = value;
      else repoDraft(id)[prop] = value;
      mark();
      if (prop === "autoRepliesEnabled") {
        if (!value) repoDraft(id).progressEnabled = false;
        clean();
        refresh();
      }
      return true;
    }
    if (key.startsWith("acct.")) {
      const [_, id, prop, ...nameParts] = key.split(".");
      const name = nameParts.join(".");
      const d = accountDraft(id);
      if (prop === "permission" || prop === "capability") {
        const target = prop === "permission" ? "permissions" : "capabilities";
        d[target] = value
          ? [...new Set([...d[target], name])]
          : d[target].filter((v) => v !== name);
      } else d[prop] = value;
      mark();
      return true;
    }
    O[key] = value;
    if (key === "globalConcurrencyDraft") {
      O.globalSaveNotice = "";
      mark();
    } else viewChanged();
    return true;
  }
  function taskEvent(event) {
    if (event?.type !== "cancellation-requested") return false;
    const worker = O.workers.find(
      (w) =>
        w.id === event.workerId &&
        String(w.owner).replace(/^task-/, "") === String(event.taskId).replace(/^task-/, ""),
    );
    if (!worker) return false;
    if (worker.cleanup !== "Awaiting cleanup") {
      worker.cleanup = "Awaiting cleanup";
      worker.events ||= [];
      worker.events.unshift([
        "Just now",
        "Owned Task cancellation requested",
        "Awaiting the worker cleanup report; admission policy is unchanged",
      ]);
    }
    return true;
  }
  return { render, handle, change, discardDirty, getView, applyView, taskEvent };
}
