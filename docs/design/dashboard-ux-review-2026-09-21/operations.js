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
  const read = (id) => ctx.root.querySelector(`#${id}`)?.value || "";
  const checked = (id) => !!ctx.root.querySelector(`#${id}`)?.checked;
  const check = (label, key, value, disabled = false) =>
    `<label class="ar-row ar-small"><input id="ops-${esc(key.replaceAll(".", "-"))}" type="checkbox" data-ops="${esc(key)}" ${value ? "checked" : ""} ${disabled ? "disabled" : ""}> <span>${esc(label)}</span></label>`;
  const field = (label, key, value, type = "text", extra = "") =>
    h.field(
      label,
      `ops-${key.replaceAll(".", "-")}`,
      value,
      type,
      `data-ops="${esc(key)}" ${extra}`,
    );
  const select = (label, key, value, items) =>
    `<label class="ar-field"><span>${esc(label)}</span><select data-ops="${esc(key)}">${items.map(([v, l]) => `<option value="${esc(v)}" ${value === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  const textarea = (label, key, value, rows = 5) =>
    `<label class="ar-field"><span>${esc(label)}</span><textarea id="ops-${esc(key.replaceAll(".", "-"))}" rows="${rows}" data-ops="${esc(key)}">${esc(value)}</textarea></label>`;
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
            : ["Pending", "Unknown", "Awaiting cleanup", "Retry scheduled"].includes(text)
              ? "warning"
              : "neutral"),
    );
  const table = (heads, rows) =>
    `<div class="ar-table-wrap"><table class="ar-table"><thead><tr>${heads.map((s) => `<th scope="col">${s}</th>`).join("")}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const back = (page, label) => btn(`← ${label}`, `ops:back:${page}`, "quiet");
  const allowPrepare = () => state.role !== "reader";
  const allowAdmin = () => state.role === "admin";
  const find = (items, id) => items.find((x) => x.id === id) || items[0];
  const filterText = (items, query = state.q || "") =>
    items.filter((x) => JSON.stringify(x).toLowerCase().includes(query.toLowerCase()));
  const focusError = (message, fieldId) => {
    const scope = ctx.root.querySelector("dialog[open]") || ctx.root;
    const error = scope.querySelector("[data-ops-error]");
    scope.querySelectorAll?.('[aria-invalid="true"]').forEach((input) => {
      input.removeAttribute("aria-invalid");
    });
    if (error) {
      error.textContent = message;
      error.hidden = false;
      error.id = "ops-active-form-error";
    } else ctx.toast(message);
    const invalid = fieldId
      ? scope.querySelector(`#${fieldId}`)
      : scope.querySelector("input:invalid, textarea:invalid, select:invalid");
    if (invalid) {
      invalid.setAttribute("aria-invalid", "true");
      if (error) invalid.setAttribute("aria-describedby", error.id);
      invalid.focus();
    }
  };
  const errorSlot = '<div data-ops-error role="alert" hidden class="ar-notice danger"></div>';
  const mark = () => {
    O.dirty = true;
    ctx.markDirty(true);
    ctx.root.querySelectorAll?.("[data-ops-dirty]").forEach((node) => {
      node.textContent = "Unsaved draft preserved in this browser session.";
    });
  };
  const clean = () => {
    const repositoryDraftRemains =
      state.page === "repositories" &&
      state.id &&
      O.repoDrafts?.[state.id] &&
      JSON.stringify(O.repoDrafts[state.id]) !== JSON.stringify(O.repoSaved?.[state.id]);
    const globalDraftRemains =
      O.globalConcurrencyDraft !== undefined &&
      Number(O.globalConcurrencyDraft) !== O.globalConcurrency;
    O.dirty = Boolean(repositoryDraftRemains || globalDraftRemains);
    ctx.markDirty(O.dirty);
  };
  const refresh = () => {
    const active = ctx.root.querySelector(":focus");
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
      body: "## Investigation summary\n\nSettings does not open after an update. The imported report contains reproduction steps; runtime verification is still pending.\n\n- Result: needs verification\n- Validation: not reproduced\n- Next step: review the proposed verification plan\n\nThis is synthetic prototype content.",
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
      body: "## Review summary\n\nImprove keyboard navigation in Command Palette. The static review has 26 findings, including a P0 requiring review. Runtime validation has not run.\n\nThis is a synthetic fixture. Nothing has been sent to GitHub.",
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
      event: "pull_request · synchronize",
      state: "Ignored",
      phase: "Authorization",
      reason: "Actor is not in the trusted user allowlist",
      task: null,
      comment: null,
      time: "52 min ago",
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
      capabilities: ["comment", "approve", "request-changes", "merge"],
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
      enabled: false,
      isAdmin: false,
      repositories: "repo-fixture",
      permissions: [],
      capabilities: [],
      execution: false,
      version: 2,
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
    const command = O.commentCommands?.[c.id];
    const unknown =
      command?.state === "unknown" ||
      (state.scenario === "unknown" && command?.state !== "complete");
    const conflict = state.scenario === "conflict" && !O.commentReviewed?.[c.id];
    const latest = c.status === "Delivered";
    return stack(`${back("comments", "Comments")}${h.heading(c.title, `${repoName} · ${c.kind} #${c.number} · ${c.id}`, badge(unknown ? "Unknown" : c.status))}
      ${unknown ? note("The response was not confirmed. The saved request is retained. Check status or retry this same request before starting another publication.", "warning") + row(`${btn("Check saved request", `ops:comment-status:${c.id}`, "primary")}${btn("Retry same request", `ops:comment-replay:${c.id}`)}`) : ""}
      ${conflict ? note("The publication changed while you were reviewing it. Refresh its status and review the current version before making a new request.", "warning") + btn("Refresh and review latest", `ops:comment-review:${c.id}`) : ""}
      <div class="ar-grid">${panel(`<h2 class="ar-title">Publication</h2><div class="ar-grid">${kv("Target", esc(`${repoName} · ${c.kind} #${c.number}`))}${kv("Delivery", badge(c.status))}${kv("Source report", btn(c.report, `ops:nav:reports:${c.report}`, "quiet"))}${kv("Task", btn(c.task, `ops:nav:tasks:${c.task}`, "quiet"))}${kv("Content version", `v${c.version} · reviewed body`)}${kv("Last update", esc(c.updated))}</div>`)}${panel(`<h2 class="ar-title">Delivery controls</h2><p class="ar-muted">Checking delivery reads the current publication status. Syncing publication can create or update a GitHub comment.</p>${row(`${btn("Check delivery", `ops:comment-check:${c.id}`, "", !allowPrepare() || unknown || conflict ? "disabled" : "")}${btn(latest ? "Sync publication" : "Review sync publication", `ops:comment-sync:${c.id}`, "primary", !allowAdmin() || unknown || conflict ? "disabled" : "")}`)}${!allowAdmin() ? '<p class="ar-small ar-muted">Sync publication requires Prepare actions, Execute actions and the Comment capability for this repository.</p>' : ""}${command ? `<p class="ar-small" role="status">${esc(command.message)}</p>` : ""}`)}
      </div>${panel(`<h2 class="ar-title">Comment body</h2><p class="ar-small ar-muted">The complete proposed body stays visible, including when delivery fails.</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.7">${esc(c.body)}</pre>`)}
      ${panel(
        `<h2 class="ar-title">Delivery history</h2>${table(
          ["Attempt", "Operation", "Result", "When"],
          [
            [
              `v${c.version}`,
              latest ? "Create / update comment" : "Prepare publication",
              badge(c.status),
              esc(c.updated),
            ],
            ["v1", "Prepare publication", "Body retained", "1 hour ago"],
          ],
        )}`,
      )}`);
  }

  function comments() {
    if (state.id) return commentDetail(find(O.comments, state.id));
    const rows = filterText(O.comments, O.commentSearch || state.q || "").filter(
      (c) =>
        (!O.commentKind || c.kind === O.commentKind) &&
        (!O.commentStatus || c.status === O.commentStatus),
    );
    const chips = [
      ["commentSearch", "Search", O.commentSearch || state.q],
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
    return stack(`${h.heading("Comments", "Review publication bodies and delivery independently from investigation results.", btn("Refresh", "ops:refresh:comments"))}
      ${panel(
        `<div class="ar-toolbar">${field("Search publications", "commentSearch", O.commentSearch || state.q || "", "search", 'placeholder="Title, body or source number"')}${select(
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
            ? `<div class="ar-grid">${field("Work item number", "commentNumber", O.commentNumber || "", "number", 'min="1"')}${field("Exact Task ID", "commentTask", O.commentTask || "", "text", 'placeholder="For example: 2101"')}${select(
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
              "Try a different delivery state or work item number.",
              btn("Clear filters", "ops:comment-clear"),
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
      const rows = filterText(O.webhooks).filter(
        (w) => !O.webhookState || w.state === O.webhookState,
      );
      return stack(
        `${h.heading("Webhooks", "Track inbound event handling, linked Tasks and comment publication separately.", btn("Refresh", "ops:refresh:webhooks"))}${panel(
          `<div class="ar-toolbar">${select(
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
          )}${btn("Clear filters", "ops:webhook-clear", "quiet")}</div>`,
        )}${
          rows.length
            ? panel(
                table(
                  ["Event", "Work item", "Handling", "Linked Task", "Received", ""],
                  rows.map((w) => [
                    `<strong>${esc(w.event)}</strong><div class="ar-small ar-muted">${w.id}</div>`,
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
                "Clear filters to see all fixture events.",
                btn("Clear filters", "ops:webhook-clear"),
              )
        }`,
      );
    }
    const w = find(O.webhooks, state.id);
    const request = O.webhookCommands?.[w.id];
    const unknown =
      request?.state === "unknown" ||
      (state.scenario === "unknown" && request?.state !== "complete");
    const conflict = state.scenario === "conflict" && !O.webhookReviewed?.[w.id];
    return stack(`${back("webhooks", "Webhooks")}${h.heading(`${w.target} · ${w.event}`, `${repoName} · ${w.id} · received ${w.time}`, badge(w.state))}
      ${unknown ? note("Recovery acknowledgement is unknown. The original request is retained; avoid submitting a new recovery.", "warning") + row(`${btn("Check saved request", `ops:webhook-status:${w.id}`, "primary")}${btn("Retry same request", `ops:webhook-replay:${w.id}`)}`) : ""}
      ${conflict ? note("This event changed. Refresh its status and review the latest event before retrying handling.", "warning") + btn("Refresh and review latest", `ops:webhook-review:${w.id}`) : ""}
      <div class="ar-grid">${panel(`<h2 class="ar-title">1 · Event handling</h2>${row(`${badge(w.state)}<span>${esc(w.phase)}</span>`)}<p>${esc(w.reason)}</p><p class="ar-small ar-muted">Attempt ${w.state === "Retry scheduled" ? "2 scheduled" : "1"} · Static investigation</p>${btn("Review retry event handling", `ops:webhook-retry:${w.id}`, "primary", !allowAdmin() || w.state !== "Failed" || unknown || conflict ? "disabled" : "")}${w.state !== "Failed" ? '<p class="ar-small ar-muted">Only a failed canonical event with no pending retry can be retried.</p>' : ""}${request ? `<p class="ar-small" role="status">${esc(request.message)}</p>` : ""}`)}${panel(`<h2 class="ar-title">2 · Investigation Task</h2>${w.task ? `${badge("Complete", "success")}<p>${btn(w.task, `ops:nav:tasks:${w.task}`, "quiet")}</p>` : "<p>No Task has been created.</p>"}<p class="ar-muted ar-small">Retrying event handling does not restart or rerun an existing Task.</p><h2 class="ar-title">3 · Comment publication</h2>${w.comment ? `${badge("Delivered")} ${btn("View publication", `ops:nav:comments:${w.comment}`, "quiet")}` : "<p>No publication linked to this event.</p>"}`)}</div>
      ${panel(
        `<h2 class="ar-title">Handling timeline</h2>${table(
          ["Phase", "Outcome", "Detail"],
          [
            [
              "Authorization",
              badge(
                w.state === "Ignored" ? "Ignored" : "Passed",
                w.state === "Ignored" ? "neutral" : "success",
              ),
              w.state === "Ignored"
                ? esc(w.reason)
                : "Assignment recipient and trusted actor matched",
            ],
            [
              "Source import",
              badge(
                w.state === "Failed" || w.state === "Retry scheduled"
                  ? "Failed"
                  : w.state === "Ignored"
                    ? "Not started"
                    : "Ready",
              ),
              w.state === "Failed"
                ? "Snapshot unavailable; retry is available"
                : w.state === "Retry scheduled"
                  ? "Last attempt failed; next attempt is scheduled"
                  : "No action required",
            ],
            [
              "Task creation",
              badge(w.task ? "Created" : "Not started"),
              w.task ? esc(w.task) : "No Task created by this delivery",
            ],
          ],
        )}`,
      )}`);
  }

  function workers() {
    const worker = state.id ? find(O.workers, state.id) : null;
    const cards = (worker ? [worker] : O.workers)
      .map((w) =>
        panel(
          `<div class="ar-toolbar"><div><h2 class="ar-title">${esc(w.id)}</h2><p class="ar-muted ar-small">${esc(w.platform)}</p></div>${badge(w.contact, "neutral")}</div><div class="ar-grid">${kv("Last contact", esc(w.seen))}${kv("E2E admission policy", badge(w.admission === "Enabled" ? "Allowed by server" : "Off · static policy", "neutral"))}${kv("Cleanup", badge(w.cleanup))}${kv("Active E2E ownership", w.owner ? btn(`Task ${w.owner}`, `ops:nav:tasks:${w.owner}`, "quiet") : "No owner")}${kv("Advertised task types", w.advertised ? esc(w.advertised.join(" · ")) : "Waiting for worker capabilities")}${kv("Effective task types", w.effective.length ? esc(w.effective.join(" · ")) : "None confirmed")}</div><p class="ar-small ar-muted">${w.cleanup === "Awaiting cleanup" ? "E2E cleanup acknowledgement is pending. A page refresh cannot verify cleanup." : "Contact is an observation. Eligibility combines advertised task types and server policy; free capacity is separate."}</p>${row(`${!worker ? btn("View worker", `ops:open:workers:${w.id}`, "quiet") : ""}${btn(w.admission === "Enabled" ? "Disable E2E admission" : "Allow E2E task admission", `ops:worker-${w.admission === "Enabled" ? "disable" : "enable"}:${w.id}`, w.admission === "Enabled" ? "" : "primary", !allowAdmin() || (w.admission !== "Enabled" && (w.cleanup === "Awaiting cleanup" || !w.advertised?.includes("PR E2E"))) ? "disabled" : "")}`)}${w.cleanup === "Awaiting cleanup" ? row(`${btn("View cleanup details", `ops:worker-cleanup:${w.id}`, "quiet")}${btn("Simulate cleanup report", `ops:worker-proof:${w.id}`, "quiet", !allowAdmin() ? "disabled" : "")}`) : ""}`,
        ),
      )
      .join("");
    return stack(
      `${worker ? back("workers", "Workers") : ""}${h.heading(worker ? worker.id : "Workers", "Contact, E2E admission and cleanup are independent operational states.", btn("Refresh status", "ops:refresh:workers"))}${O.lastRefresh?.workers ? note(`Snapshot refreshed ${O.lastRefresh.workers}. No cleanup report was inferred from this refresh.`) : ""}<div class="${worker ? "ar-stack" : "ar-grid"}">${cards}</div>${
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
          : panel(
              '<h2 class="ar-title">E2E admission policy</h2><p>Turning off E2E admission prevents new E2E work and requests cancellation of currently owned E2E work. Static admission is unaffected. Cleanup remains pending until the worker confirms its owned resources have been released.</p>',
            )
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
      `<h2 class="ar-title">Global task concurrency</h2>${badge("Global setting", "info")}<p>Workspace-wide scheduling shared by every repository. Current static occupancy: 3 / ${O.globalConcurrency}.</p>${errorSlot}<div class="ar-toolbar">${field("Maximum concurrent static investigations", "globalConcurrencyDraft", O.globalConcurrencyDraft ?? O.globalConcurrency, "number", 'min="1" max="16"')}${btn("Save concurrency", "ops:global-save", "primary", !allowAdmin() ? "disabled" : "")}${btn("Discard concurrency draft", "ops:global-discard", "quiet")}</div><p class="ar-small ar-muted">Use a whole number from 1 to 16. Lowering this limit lets running work finish; it does not cancel existing investigations. Worker capacity may reduce actual concurrency.</p>${O.globalSaveNotice ? note(O.globalSaveNotice, "success") : ""}`,
    );
  }
  function repositories() {
    if (!state.id) {
      const rows = filterText(O.repositories).filter(
        (r) => state.repo !== "fork" || r.id === "fixture",
      );
      return stack(
        `${h.heading("Repositories", "Manage repository intake and replies, with shared global scheduling.")}${panel(
          table(
            ["Repository", "Intake", "Active Tasks", "Settings version", ""],
            rows.map((r) => [
              `<strong>${esc(r.name)}</strong>`,
              badge(r.mode, "info"),
              r.jobs,
              `v${r.version}`,
              btn("Manage repository", `ops:open:repositories:${r.id}`, "quiet"),
            ]),
          ),
        )}${globalConcurrencyPanel()}`,
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
        ? note(
            "The saved settings changed. Your draft is preserved. Load the latest version and compare before saving again.",
            "warning",
          ) +
          row(
            `${btn("Load latest for comparison", `ops:repo-latest:${r.id}`, "primary")}${btn("Download my draft", `ops:repo-export:${r.id}`)}`,
          ) +
          (O.repoLatest === r.id
            ? panel(
                `<h3 class="ar-title">Compare versions</h3>${table(
                  ["Setting", "Your draft", "Latest saved · v" + (r.version + 1)],
                  [
                    ["E2E intake", d.e2e ? "Enabled" : "Disabled", "Disabled"],
                    ["Trusted actors", esc(d.actors.replaceAll("\n", ", ")), "10041"],
                  ],
                )}<p class="ar-small">Your draft remains in the editor. Review both versions before choosing how to continue.</p>${row(`${btn("Keep my draft on latest version", `ops:repo-keep:${r.id}`, "primary")}${btn("Use latest saved settings", `ops:repo-use-latest:${r.id}`)}`)}`,
              )
            : "")
        : "";
    let body = "";
    if (tab === "overview")
      body = `<div class="ar-grid">${panel(`<h2 class="ar-title">Repository scope</h2>${kv("Repository", esc(r.name))}${kv("Exact repository ID", esc(r.repositoryId))}<p>${badge(r.mode, "info")}</p>${kv("Saved settings version", `v${r.version}`)}<p class="ar-muted">Repository access is granted by exact ID on each account.</p>`)}${panel(`<h2 class="ar-title">Current activity</h2>${kv("Active Tasks", String(r.jobs))}<p>Inbound events, investigations and outgoing comments have separate lifecycles.</p>${row(`${btn("View webhook events", "ops:nav:webhooks:", "quiet")}${btn("View publications", "ops:nav:comments:", "quiet")}`)}`)}</div>`;
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
        `<h2 class="ar-title">Automated replies</h2>${check("Enable automatic investigation replies", prefix + "autoRepliesEnabled", d.autoRepliesEnabled)}${check("Enable assignment progress comments", prefix + "progressEnabled", d.progressEnabled)}<p class="ar-small ar-muted">Progress comments require automatic replies. Templates define future comment content.</p>${select(
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
        )}${textarea("Reply template content", prefix + prop, value, 9)}<p class="ar-muted ar-small">Required placeholders, once each and in this order: ${replyTokens[key].map((token) => esc("{{" + token + "}}")).join(", ")}.${["received", "started", "failed", "completed"].includes(key) ? " Optional: {{status}} once." : ""}</p>${btn("Preview reply", `ops:reply-preview:${r.id}`)}`,
      );
    }
    if (tab === "scheduling") body = globalConcurrencyPanel();
    return stack(
      `${back("repositories", "Repositories")}${h.heading(r.name, `Repository settings · v${r.version}`, O.dirty ? badge("Unsaved draft", "warning") : badge("Saved", "success"))}${h.tabs(
        [
          { id: "overview", label: "Overview" },
          { id: "intake", label: "Intake" },
          { id: "replies", label: "Replies" },
          { id: "scheduling", label: "Scheduling · global" },
        ],
        tab,
        "ops:repo-tab:",
      )}${conflictUi}${tab === "scheduling" ? "" : errorSlot}${body}${["intake", "replies"].includes(tab) ? panel(`<div class="ar-toolbar"><span data-ops-dirty class="ar-small ar-muted">${O.dirty ? "Draft preserved in this browser session." : "No unsaved changes."}</span>${row(`${btn("Discard draft", `ops:repo-discard:${r.id}`)}${btn("Save settings", `ops:repo-save:${r.id}`, "primary", !allowAdmin() || conflict ? "disabled" : "")}`)}</div>`) : ""}`,
    );
  }

  function accountDraft(id) {
    const saved = O.accounts.find((a) => a.id === id);
    O.accountDrafts[id] ||= saved
      ? { ...saved, permissions: [...saved.permissions], capabilities: [...saved.capabilities] }
      : {
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
        };
    return O.accountDrafts[id];
  }
  function accounts() {
    if (!state.id) {
      const rows = filterText(O.accounts).filter(
        (a) => !O.accountState || (O.accountState === "enabled" ? a.enabled : !a.enabled),
      );
      return stack(
        `${h.heading("Accounts", "Grant repository scope, operational permissions and administration independently.", btn("Create account", "ops:open:accounts:new", "primary", !allowAdmin() ? "disabled" : ""))}${panel(
          `<div class="ar-toolbar">${select("Account state", "accountState", O.accountState || "", [
            ["", "All accounts"],
            ["enabled", "Enabled"],
            ["disabled", "Disabled"],
          ])}${btn("Clear filters", "ops:account-clear", "quiet")}</div>`,
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
                    btn("Manage access", `ops:open:accounts:${a.id}`, "quiet"),
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
      O.accountConflict === id || (state.scenario === "conflict" && !O.accountReviewed?.[id]);
    return stack(`${back("accounts", "Accounts")}${h.heading(isNew ? "Create account" : d.displayName, isNew ? "New account · no access is implied by the display name." : `${d.username} · access version v${d.version}`, badge(d.enabled ? "Enabled" : "Disabled"))}${conflict ? note("This account changed. Your draft is preserved. Compare current access before saving.", "warning") + btn("Compare current access", `ops:account-latest:${id}`, "primary") : ""}${errorSlot}
      <div class="ar-grid">${panel(`<h2 class="ar-title">Identity</h2>${field("Username", prefix + "username", d.username, "text", isNew ? 'autocomplete="off"' : "readonly")}${field("Display name", prefix + "displayName", d.displayName)}${isNew ? h.field("Initial password · 15–128 characters", "ops-new-account-password", "", "password", 'autocomplete="new-password"') + '<p class="ar-small ar-muted">Prototype only. Use a made-up password. It is never persisted.</p>' : `<p class="ar-small ar-muted">Password reset is separate from access changes.</p>${btn("Reset password…", `ops:account-reset:${id}`, "", !allowAdmin() ? "disabled" : "")}`}`)}${panel(`<h2 class="ar-title">Administration</h2>${check("Manage dashboard accounts", prefix + "isAdmin", d.isAdmin)}<p class="ar-small ar-muted">Administration does not automatically grant repository execution or action permissions.</p><h3 class="ar-title">Repository scope</h3>${textarea("Exact repository IDs · one per line", prefix + "repositories", d.repositories, 3)}<p class="ar-small ar-muted">${esc(repoName)} uses ID <strong>repo-fixture</strong>. Use exact IDs; wildcards are not supported.</p>`)}</div>
      <div class="ar-grid">${panel(`<h2 class="ar-title">Operational permissions</h2>${permissions.map(([p, label]) => check(label, prefix + "permission." + p, d.permissions.includes(p))).join("")}<p class="ar-muted ar-small">Prepare actions and Execute actions are separate grants.</p><h3 class="ar-title">Repository execution</h3>${check("Allow E2E / repository execution", prefix + "execution", d.execution)}<p class="ar-small ar-muted">Execution requires repository access and a compatible investigation permission.</p>`)}${panel(`<h2 class="ar-title">Action capabilities</h2>${capabilities.map(([name, label]) => check(label, prefix + "capability." + name, d.capabilities.includes(name))).join("")}<p class="ar-muted ar-small">These action kinds are independent of repository scope and operational permissions.</p>`)}</div>
      ${panel(`<div class="ar-toolbar">${!isNew ? btn(d.enabled ? "Disable account…" : "Enable account", `ops:account-toggle:${id}`, d.enabled ? "danger" : "", !allowAdmin() ? "disabled" : "") : "<span></span>"}${row(`${btn("Discard draft", `ops:account-discard:${id}`)}${btn(isNew ? "Create account" : "Save access", `ops:account-save:${id}`, "primary", !allowAdmin() || conflict ? "disabled" : "")}`)}</div><p data-ops-dirty class="ar-small ar-muted">${O.dirty ? "Unsaved access draft." : "No unsaved changes."}</p>`)}`);
  }

  function myAccount() {
    const username =
      { admin: "demo.admin", preparer: "demo.reviewer", reader: "demo.reader" }[state.role] ||
      "demo.reader";
    const account = O.accounts.find((a) => a.username === username);
    return stack(
      `${h.heading("My account", `${esc(account?.displayName || username)} · ${esc(username)}`)}${panel(`<h2 class="ar-title">Session and access</h2><div class="ar-grid">${kv("Repository scope", repositoryAccess(account?.repositories || ""))}${kv("Current access preset", badge(state.role, "info"))}</div><p class="ar-muted ar-small">Changing your password signs out this session and invalidates your other sessions.</p>`)}${panel(`<h2 class="ar-title">Change password</h2>${errorSlot}<form data-ops-form="password" autocomplete="off"><div class="ar-grid">${h.field("Current password", "ops-current-password", "", "password", 'autocomplete="current-password"')}${h.field("New password · 15–128 characters", "ops-own-password", "", "password", 'autocomplete="new-password"')}${h.field("Confirm new password", "ops-own-confirm", "", "password", 'autocomplete="new-password"')}</div><p class="ar-small ar-muted">Prototype only. Enter made-up values; no password is sent or saved.</p>${btn("Review password change", "ops:own-password", "primary")}</form>`)}`,
    );
  }
  function login() {
    return `<div style="max-width:500px;margin:48px auto">${h.heading("Sign in", "Agentic Review dashboard · interactive design prototype")}${O.loginNotice ? note(O.loginNotice, "success") : ""}${panel(`${errorSlot}<form data-ops-form="login" autocomplete="off">${h.field("Username", "ops-login-username", "", "text", 'autocomplete="off" placeholder="demo.admin"')}${h.field("Password", "ops-login-password", "", "password", 'autocomplete="off"')}${btn("Sign in to demo", "ops:login", "primary")}<p class="ar-small ar-muted">Use demo.admin, demo.reviewer or demo.reader with any made-up password. This demo has no server connection.</p></form>`)}</div>`;
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
    return pages[page] ? pages[page]() : null;
  }

  function commentCommand(id, action, replay = false) {
    const c = find(O.comments, id);
    O.commentCommands ||= {};
    const previous = O.commentCommands[id];
    const unknown = state.scenario === "unknown" && !replay;
    O.requestCounter = (O.requestCounter || 0) + (replay ? 0 : 1);
    O.commentCommands[id] = {
      id: replay
        ? previous?.id || `fixture-request-${id}-1`
        : `fixture-request-${id}-${O.requestCounter}`,
      action,
      state: unknown ? "unknown" : "complete",
      message: unknown
        ? "Saved request awaiting acknowledgement. Delivery outcome is unknown."
        : action === "check"
          ? `Delivery checked: ${c.status}. No GitHub write was made.`
          : "Publication request accepted. Delivery is Pending; acceptance does not mean it was delivered.",
    };
    if (action !== "check" && !unknown) {
      c.status = "Pending";
      c.updated = "Just now";
    }
    refresh();
  }
  function webhookCommand(id, replay = false) {
    const w = find(O.webhooks, id);
    O.webhookCommands ||= {};
    const unknown = state.scenario === "unknown" && !replay;
    O.webhookCommands[id] = {
      id: O.webhookCommands[id]?.id || `fixture-recovery-${id}-1`,
      state: unknown ? "unknown" : "complete",
      message: unknown
        ? "Saved recovery request awaiting acknowledgement."
        : "Recovery accepted. Event handling is scheduled; no existing Task was restarted.",
    };
    if (!unknown) {
      w.state = "Retry scheduled";
      w.reason = "Awaiting the next handling attempt";
    }
    refresh();
  }

  function handle(action, el) {
    if (!action.startsWith("ops:")) return false;
    const [_, key, id, arg] = action.split(":");
    switch (key) {
      case "dialog-close":
        ctx.closeDialog();
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
        O.lastRefresh ||= {};
        O.lastRefresh[id] = new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        refresh();
        ctx.toast("Fixture snapshot refreshed.");
        break;
      case "comment-filters":
        O.commentMore = !O.commentMore;
        refresh();
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
        refresh();
        break;
      case "comment-remove":
        O[id] = "";
        if (id === "commentSearch") state.q = "";
        refresh();
        break;
      case "comment-check":
        commentCommand(id, "check");
        break;
      case "comment-review":
        O.commentReviewed ||= {};
        O.commentReviewed[id] = true;
        refresh();
        break;
      case "comment-status":
      case "comment-replay": {
        commentCommand(id, O.commentCommands?.[id]?.action || "sync", true);
        const command = O.commentCommands[id];
        command.message =
          key === "comment-status"
            ? `Saved request ${command.id} confirmed. ${command.action === "check" ? "Delivery status was checked without a GitHub write." : "Publication acknowledgement received; delivery is Pending. This status check made no GitHub write."}`
            : `Same saved request ${command.id} retried. ${command.message}`;
        refresh();
        break;
      }
      case "comment-sync": {
        const c = find(O.comments, id);
        dialog(
          "Confirm publication sync",
          stack(
            `${note("This action can create or update one GitHub comment. In this prototype the action is simulated.", "warning")}${kv("Repository", esc(repoName))}${kv("Target", esc(`${c.kind} #${c.number}`))}${kv("Publication", esc(`${id} · version ${c.version}`))}<h3 class="ar-title">Exact body to publish</h3><pre style="white-space:pre-wrap;font:inherit">${esc(c.body)}</pre>`,
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
        O.webhookState = "";
        state.q = "";
        refresh();
        break;
      case "webhook-review":
        O.webhookReviewed ||= {};
        O.webhookReviewed[id] = true;
        refresh();
        break;
      case "webhook-status":
      case "webhook-replay":
        webhookCommand(id, true);
        break;
      case "webhook-retry": {
        const w = find(O.webhooks, id);
        dialog(
          "Retry event handling",
          stack(
            `${kv("Event", esc(`${id} · ${w.event}`))}${kv("Repository / target", esc(`${repoName} · ${w.target}`))}${kv("Failed phase", esc(w.phase))}${note("This schedules another handling attempt for this event. It does not restart an existing Task or publish a comment. A Task may be created if handling reaches Task creation.")}`,
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
      case "worker-disable": {
        const w = find(O.workers, id);
        dialog(
          "Disable E2E admission",
          stack(
            `${kv("Worker", esc(id))}${kv("Active E2E ownership", w.owner ? `Task ${esc(w.owner)}` : "No owner")}${note("This prevents new E2E work and requests cancellation of currently owned E2E work. Static task admission is unaffected. Existing E2E ownership requires a worker cleanup report before it is released.", "warning")}`,
          ),
          "Disable E2E admission",
          `ops:worker-confirm:${id}`,
          true,
        );
        break;
      }
      case "worker-confirm": {
        const w = find(O.workers, id);
        w.admission = "Disabled";
        w.cleanup = w.owner ? "Awaiting cleanup" : "No pending cleanup";
        w.effective = (w.advertised || []).filter((kind) => kind !== "PR E2E");
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
        w.admission = "Enabled";
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
        w.cleanup = "Complete";
        w.active = 0;
        w.owner = null;
        w.contact = "Recent contact";
        w.seen = "Just now";
        w.events ||= [];
        w.events.unshift([
          "Just now",
          "Synthetic E2E cleanup report received",
          "Owned E2E resources released; E2E admission remains off",
        ]);
        refresh();
        break;
      }
      case "repo-tab":
        state.tab = id;
        refresh();
        break;
      case "repo-save": {
        const r = find(O.repositories, id),
          d = repoDraft(id);
        if ((d.static || d.e2e) && (!/^[1-9]\d*$/.test(d.reviewer.trim()) || !d.actors.trim())) {
          state.tab = "intake";
          refresh();
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
          state.tab = "intake";
          refresh();
          focusError(
            "Trusted actor IDs must be positive numeric GitHub user IDs.",
            `ops-repo-${id}-actors`,
          );
          break;
        }
        if (d.progressEnabled && !d.autoRepliesEnabled) {
          state.tab = "replies";
          refresh();
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
          state.tab = "replies";
          refresh();
          const prop =
            invalidTemplate === "pullRequest"
              ? "pullRequestTemplate"
              : invalidTemplate === "issue"
                ? "issueTemplate"
                : `progressTemplates-${invalidTemplate}`;
          focusError(
            "Use each required placeholder exactly once and in the displayed order. Remove unknown or incomplete placeholders.",
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
        r.mode = d.e2e ? "Static + E2E" : d.static ? "Static only" : "Intake disabled";
        clean();
        refresh();
        ctx.toast("Repository settings saved in the prototype.");
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
          `<p class="ar-small ar-muted">Illustrative placeholders only · no comment will be published</p><div class="ar-panel" style="white-space:pre-wrap">${esc(body)}</div>`,
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
        O.accountState = "";
        state.q = "";
        refresh();
        break;
      case "account-save": {
        const d = accountDraft(id),
          isNew = id === "new";
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
        if (state.scenario === "conflict" && !O.accountReviewed?.[id]) {
          O.accountConflict = id;
          refresh();
          break;
        }
        if (isNew) {
          const saved = { ...d, id: `acct-${O.accounts.length + 1}`, version: 1 };
          O.accounts.push(saved);
          delete O.accountDrafts.new;
          clean();
          ctx.nav("accounts", saved.id);
        } else {
          const index = O.accounts.findIndex((a) => a.id === id);
          O.accounts[index] = {
            ...d,
            permissions: [...d.permissions],
            capabilities: [...d.capabilities],
            version: d.version + 1,
          };
          delete O.accountDrafts[id];
          clean();
          refresh();
        }
        ctx.toast("Account access saved in the prototype.");
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
        clean();
        ctx.closeDialog();
        refresh();
        break;
      case "account-latest": {
        const d = accountDraft(id);
        dialog(
          "Compare account access",
          `${note("Your draft remains in the editor. A newer saved version removed repository execution.")}${table(
            ["Permission", "Your draft", "Latest saved"],
            [
              ["Repository execution", d.execution ? "Allowed" : "Not allowed", "Not allowed"],
              ["Account version", `v${d.version}`, `v${d.version + 1}`],
            ],
          )}`,
          "Keep draft on latest version",
          `ops:account-keep:${id}`,
        );
        break;
      }
      case "account-keep": {
        const d = accountDraft(id);
        d.version++;
        O.accountReviewed ||= {};
        O.accountReviewed[id] = true;
        O.accountConflict = null;
        ctx.closeDialog();
        mark();
        refresh();
        break;
      }
      case "account-toggle": {
        const a = find(O.accounts, id);
        if (a.enabled)
          dialog(
            "Disable account",
            `${kv("Account", esc(`${a.displayName} · ${a.username}`))}${note("The account will be prevented from signing in and existing sessions will be invalidated.", "warning")}`,
            "Disable account",
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
        refresh();
        break;
      }
      case "account-reset": {
        const a = find(O.accounts, id);
        dialog(
          "Reset account password",
          stack(
            `${kv("Account", esc(`${a.displayName} · ${a.username}`))}${errorSlot}${h.field("New password · 15–128 characters", "ops-reset-password", "", "password", 'autocomplete="new-password"')}${h.field("Confirm password", "ops-reset-confirm", "", "password", 'autocomplete="new-password"')}<label class="ar-row ar-small"><input id="ops-reset-ack" type="checkbox"> I understand this invalidates every session for this account.</label><p class="ar-small ar-muted">Use a made-up value. No password is saved in this prototype.</p>`,
          ),
          "Reset password",
          `ops:account-reset-confirm:${id}`,
          true,
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
        refresh();
        ctx.openDialog(
          "Password reset simulated",
          `<p>The password reset for <strong>${esc(a.username)}</strong> was accepted in this demo. Its simulated sessions have been invalidated. No password was stored.</p>`,
          btn("Done", "ops:dialog-close", "primary"),
        );
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
          '<p>This ends your current session and invalidates your other sessions. You will return to the demo sign-in screen.</p><p class="ar-small ar-muted">No password is saved or sent in this prototype.</p>',
          "Change password and sign out",
          "ops:own-password-confirm",
        );
        break;
      }
      case "own-password-confirm":
        ctx.closeDialog();
        O.loginNotice = "Password change simulated. Sign in again to continue.";
        ctx.nav("login", null);
        break;
      case "login": {
        const username = read("ops-login-username").trim().toLowerCase(),
          password = read("ops-login-password");
        if (!username || !password) {
          focusError(
            "Enter a demo username and a made-up password.",
            !username ? "ops-login-username" : "ops-login-password",
          );
          break;
        }
        const roles = {
          "demo.admin": "admin",
          "demo.reviewer": "preparer",
          "demo.reader": "reader",
        };
        if (!roles[username]) {
          focusError("Use demo.admin, demo.reviewer or demo.reader.", "ops-login-username");
          break;
        }
        state.role = roles[username];
        O.loginNotice = "";
        ctx.nav("pulls", null);
        ctx.toast("Signed in to the local prototype.");
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
    const value = el.type === "checkbox" ? el.checked : el.value;
    if (key.startsWith("repo.")) {
      const [_, id, prop, nested] = key.split(".");
      if (prop === "progressTemplates") repoDraft(id).progressTemplates[nested] = value;
      else repoDraft(id)[prop] = value;
      mark();
      const badgeEl = ctx.root.querySelector(".ar-heading .ar-badge");
      if (badgeEl) {
        badgeEl.textContent = "Unsaved draft";
        badgeEl.className = "ar-badge warning";
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
    } else refresh();
    return true;
  }
  return { render, handle, change };
}
