(function () {
  "use strict";
  const root = document.getElementById("ar-prototype");
  if (!root) return;
  const $ = (id) => root.querySelector("#" + id);
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const button = (text, action, variant = "", attrs = "") =>
    `<button type="button" class="ar-btn ${esc(variant)}" data-action="${esc(action)}" ${attrs}>${text}</button>`;
  const badge = (text, tone = "neutral") =>
    `<span class="ar-badge ${esc(tone)}">${esc(text)}</span>`;
  const notice = (text, tone = "info") =>
    `<div class="ar-notice ${esc(tone)}" ${tone === "error" ? 'role="alert"' : ""}>${text}</div>`;
  const field = (label, id, value = "", type = "text", extra = "") =>
    `<label class="ar-field" for="${esc(id)}">${esc(label)}<input id="${esc(id)}" type="${esc(type)}" value="${esc(value)}" ${extra}></label>`;
  const select = (label, id, choices, selected) =>
    `<label class="ar-field" for="${id}">${label}<select id="${id}">${choices
      .map((c) => {
        const [v, t] = Array.isArray(c) ? c : [c, c];
        return `<option value="${esc(v)}" ${v === selected ? "selected" : ""}>${esc(t)}</option>`;
      })
      .join("")}</select></label>`;
  const heading = (title, subtitle, actions = "") =>
    `<div class="ar-heading"><div><h1>${esc(title)}</h1><p>${subtitle}</p></div>${actions ? `<div class="ar-row">${actions}</div>` : ""}</div>`;
  const tabs = (items, active, prefix) =>
    `<nav class="ar-tabs" aria-label="Detail sections">${items.map((i) => `<button type="button" data-action="${esc(prefix + i.id)}" aria-pressed="${i.id === active}">${esc(i.label)}</button>`).join("")}</nav>`;
  const empty = (title, description, actionHtml = "") =>
    `<div class="ar-empty"><span class="ar-empty-icon" aria-hidden="true">◎</span><h2>${esc(title)}</h2><p>${description}</p>${actionHtml}</div>`;
  const h = { esc, button, badge, notice, field, heading, tabs, empty };
  const names = {
    pulls: "Pull requests",
    issues: "Issues",
    tasks: "Tasks",
    reports: "Reports",
    comments: "Comments",
    webhooks: "Webhook events",
    repositories: "Repositories",
    workers: "Workers",
    accounts: "Accounts",
    account: "My account",
    login: "Sign in",
  };
  const groups = [
    { id: "review", label: "Review", symbol: "↗", pages: ["pulls", "issues", "reports"] },
    { id: "tasks", label: "Tasks", symbol: "▷", pages: ["tasks"] },
    { id: "activity", label: "Activity", symbol: "≡", pages: ["comments", "webhooks"] },
    {
      id: "workspace",
      label: "Workspace",
      symbol: "⊞",
      pages: ["repositories", "workers", "accounts"],
    },
  ];
  const fixtures = [
    {
      id: "2101",
      type: "pulls",
      title: "Preserve settings when a migration is cancelled",
      status: "Completed",
      conclusion: "2 findings",
      validation: "Not run",
      priority: "P1",
      mode: "Static",
      tokens: 18300,
    },
    {
      id: "2102",
      type: "pulls",
      title: "Improve keyboard navigation in Command Palette",
      status: "Completed",
      conclusion: "26 findings",
      validation: "Not run",
      priority: "P0",
      mode: "Static",
      tokens: 28400,
    },
    {
      id: "2203",
      type: "pulls",
      title: "Inspect an in-progress synthetic E2E capture",
      status: "Running",
      conclusion: "In progress",
      validation: "In progress",
      mode: "E2E",
      tokens: null,
    },
    {
      id: "2202",
      type: "pulls",
      title: "E2E preflight requires a build prerequisite",
      status: "Blocked",
      conclusion: "Partial report",
      validation: "Blocked",
      mode: "E2E",
      tokens: 0,
    },
    {
      id: "2103",
      type: "pulls",
      title: "Keep command search history across updates",
      status: "Interrupted",
      conclusion: "Checkpoint",
      validation: "Not run",
      mode: "Static",
      tokens: 20000,
    },
    {
      id: "2201",
      type: "pulls",
      title: "Verify the synthetic settings interaction",
      status: "Needs review",
      conclusion: "No report",
      validation: "Not run",
      mode: "E2E",
      tokens: 0,
    },
    {
      id: "3101",
      type: "issues",
      title: "Settings does not open after an update",
      status: "Completed",
      conclusion: "Needs verification",
      validation: "Not reproduced",
      kind: "Bug",
      mode: "Static",
      tokens: 14200,
    },
    {
      id: "3102",
      type: "issues",
      title: "Export a selected subset of Settings",
      status: "Completed",
      conclusion: "Plan ready",
      validation: "Not applicable",
      kind: "Feature",
      mode: "Static",
      tokens: 9800,
    },
  ];
  // A saved report keeps its own execution result even when its task resumes.
  const reportSnapshots = Object.freeze(
    Object.fromEntries(
      fixtures
        .filter((x) => x.conclusion !== "No report")
        .map((x) => [
          x.id,
          Object.freeze({
            ...x,
            status: x.status === "Running" ? "Interrupted" : x.status,
            conclusion: x.status === "Running" ? "Saved checkpoint" : x.conclusion,
            validation: x.status === "Running" ? "Not run" : x.validation,
            completeness: x.status === "Completed" ? "Complete" : "Partial",
            delivery: x.status === "Completed" ? "Final" : "Checkpoint",
          }),
        ]),
    ),
  );
  const state = {
    page: "pulls",
    id: null,
    tab: "overview",
    role: "admin",
    scenario: "normal",
    repo: "all",
    q: "",
    ops: {},
    lists: {},
    dirty: false,
    selected: {},
    drafts: {},
    savedDrafts: {},
    actionDrafts: {},
    actionIntents: {},
    startDrafts: {},
    startRequests: {},
    resumeDrafts: {},
    taskBudgets: {},
    finding: 1,
    findingPage: 1,
    severity: "all",
    findingQuery: "",
    findingStatus: "all",
    indexExpanded: false,
    taskOutputQuery: "",
    eventType: "all",
    attempt: "1",
    follow: true,
    preview: null,
    nextIntent: 1,
    history: [],
    theme: "auto",
    toast: "",
  };
  const design = { compact: false, expanded: false, validation: true };
  let pendingNavigation = null;
  let pendingDialog = null;
  let dialogDirty = false;
  let coreForm = null;
  let routePosition = 0;
  let ignoreNextPopstate = false;
  let lastFocus = null;
  const item = () => fixtures.find((x) => x.id === state.id) || fixtures[0];
  const sourceKey = (x = item()) => x.type + ":" + x.id;
  const pendingIntent = (x = item()) =>
    state.actionIntents[sourceKey(x)]?.status === "unknown"
      ? state.actionIntents[sourceKey(x)]
      : null;
  const taskBudget = (x = item()) =>
    (state.taskBudgets[sourceKey(x)] ||= {
      tokens: Math.max(20000, x.tokens || 0),
      rounds: 8,
      minutes: 30,
      report: 2,
    });
  const taskConsumption = (x = item()) => ({
    tokens: x.id === "2103" ? 20000 : x.tokens || 0,
    rounds: x.id === "2103" ? 5 : x.status === "Blocked" ? 0 : 2,
    minutes: x.id === "2103" ? 18 : x.status === "Blocked" ? 1 : 10,
    report: x.id === "2103" ? 0.7 : 0.2,
  });
  const tone = (s) =>
    /Failed|Blocked|Interrupted|Not run|Needs verification|Partial|Not reproduced/.test(s)
      ? "warning"
      : /Running|Queued|In progress/.test(s)
        ? "info"
        : /Completed|Synced|Passed/.test(s)
          ? "success"
          : "neutral";
  const permitted = (p) => !["workers", "accounts"].includes(p) || state.role === "admin";
  function currentList() {
    state.lists[state.page] ||= {
      q: "",
      status: "all",
      source: "all",
      page: 1,
      scroll: 0,
    };
    return state.lists[state.page];
  }
  function restoreScroll(top = 0) {
    requestAnimationFrame(() => window.scrollTo(0, top));
  }
  function listPage(found) {
    const f = currentList();
    f.page = Math.max(1, Math.min(f.page, Math.ceil(found.length / 4) || 1));
    return found.slice((f.page - 1) * 4, f.page * 4);
  }
  function listPager(count) {
    const f = currentList(),
      pages = Math.ceil(count / 4) || 1;
    return `<div class="ar-pager"><span>Page ${f.page} of ${pages} · ${count} records · 4 per sample page</span><div class="ar-row">${button("Previous page", "list-prev", "small", f.page === 1 ? "disabled" : "")}${button("Next page", "list-next", "small", f.page === pages ? "disabled" : "")}</div></div>`;
  }
  function toast(message) {
    state.toast = message;
    $("ar-toast").hidden = false;
    $("ar-toast").textContent = message;
  }
  function clearToast() {
    state.toast = "";
    $("ar-toast").hidden = true;
  }
  function markDirty(value = true) {
    state.dirty = Boolean(value);
  }
  function download(name, contents) {
    const blob = new Blob(
      [typeof contents === "string" ? contents : JSON.stringify(contents, null, 2)],
      { type: name.endsWith(".json") ? "application/json" : "text/plain;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Downloaded synthetic " + name);
  }
  function openDialog(title, body, footer = button("Close", "dialog-close")) {
    if (!$("ar-dialog").open) lastFocus = document.activeElement;
    dialogDirty = false;
    coreForm = null;
    $("ar-dialog-title").textContent = title;
    $("ar-dialog-body").innerHTML = body;
    $("ar-dialog-foot").innerHTML = footer;
    if (!$("ar-dialog").open) $("ar-dialog").showModal();
  }
  function closeDialog() {
    $("ar-dialog").close();
    dialogDirty = false;
    coreForm = null;
    if (lastFocus?.isConnected) lastFocus.focus();
  }
  function discardCoreForm(form) {
    if (!form) return;
    const stores = {
      prepare: state.actionDrafts,
      start: state.startDrafts,
      resume: state.resumeDrafts,
      followup: state.actionDrafts,
    };
    if (stores[form.kind]) stores[form.kind][form.key] = { ...form.initial };
  }
  function guardNavigation(callback) {
    if (state.dirty || dialogDirty) {
      pendingNavigation = callback;
      if ($("ar-dialog").open && $("ar-dialog-title").textContent !== "Leave unsaved changes?") {
        const clone = $("ar-dialog-body").cloneNode(true);
        const inputs = $("ar-dialog-body").querySelectorAll("input,textarea,select");
        clone.querySelectorAll("input,textarea,select").forEach((node, i) => {
          const source = inputs[i];
          if (node.tagName === "TEXTAREA") node.textContent = source.value;
          else if (node.tagName === "SELECT")
            Array.from(node.options).forEach((o) => {
              if (o.value === source.value) o.setAttribute("selected", "");
              else o.removeAttribute("selected");
            });
          else {
            node.setAttribute("value", source.value);
            if (source.checked) node.setAttribute("checked", "");
            else node.removeAttribute("checked");
          }
        });
        pendingDialog = {
          title: $("ar-dialog-title").textContent,
          body: clone.innerHTML,
          footer: $("ar-dialog-foot").innerHTML,
          dirty: dialogDirty,
          form: coreForm,
        };
      }
      openDialog(
        "Leave unsaved changes?",
        notice(
          "Your private changes have not been saved. Keep editing or discard them before leaving.",
          "warning",
        ),
        button("Keep editing", "guard-stay") +
          button("Discard and leave", "guard-discard", "danger"),
      );
    } else callback();
  }
  function routeSnapshot() {
    return { page: state.page, id: state.id, tab: state.tab, repo: state.repo };
  }
  function syncRoute(replace = false) {
    const params = new URLSearchParams({ page: state.page });
    if (state.id) params.set("id", state.id);
    if (state.tab !== "overview") params.set("tab", state.tab);
    if (state.repo !== "all") params.set("repo", state.repo);
    if (!replace) routePosition++;
    try {
      history[replace ? "replaceState" : "pushState"](
        { ar: routeSnapshot(), arPosition: routePosition },
        "",
        "#" + params.toString(),
      );
    } catch {}
  }
  function nav(page, id = null) {
    guardNavigation(() => {
      const previousPage = state.page,
        previousId = state.id;
      if (!previousId) currentList().scroll = window.scrollY;
      const scroll =
        !id && page === previousPage && previousId ? state.lists[page]?.scroll || 0 : 0;
      state.history.push(routeSnapshot());
      state.page = names[page] ? page : "pulls";
      state.id = id ? String(id) : null;
      state.tab = "overview";
      state.q = "";
      state.finding = 1;
      state.findingPage = 1;
      state.severity = "all";
      state.findingQuery = "";
      state.findingStatus = "all";
      state.preview = state.id ? state.actionIntents[sourceKey()] || null : null;
      if ($("ar-dialog").open) closeDialog();
      clearToast();
      syncRoute();
      render();
      restoreScroll(scroll);
    });
  }
  const ops = createOperations({
    root,
    state,
    h,
    render,
    nav,
    openDialog,
    closeDialog,
    toast,
    markDirty,
    download,
  });
  function back() {
    nav(state.page);
  }
  function sourceFilters() {
    const f = currentList();
    return `<div class="ar-toolbar"><div class="ar-search">${field("Search " + names[state.page].toLowerCase(), "ar-list-search", f.q, "search", 'placeholder="Title or source number"')}</div>${select(
      "Source state",
      "ar-source-state",
      [
        ["all", "All source states"],
        ["open", "Open"],
        ["closed", "Closed"],
      ],
      f.source,
    )}${button("More filters", "filters", "small")}${button("↻ Refresh", "refresh", "ghost small")}</div><div class="ar-pills">${["all", "Needs review", "Running", "Blocked", "Interrupted", "Completed"].map((s) => `<button type="button" data-action="filter:${s}" aria-pressed="${f.status === s}">${s === "all" ? "All investigations" : s}</button>`).join("")}</div>`;
  }
  function sourceRow(x, page = state.page) {
    return `<div class="ar-source-row"><div><button type="button" class="ar-source-title" data-action="open:${page}:${x.id}">${esc(x.title)}</button><div class="ar-source-meta">${x.type === "issues" ? "Issue" : "PR"} #${x.id} · ${x.kind || x.mode + " review"} · Updated 21 Sep</div></div><div class="ar-state">${badge(x.status, tone(x.status))}<span class="ar-small ar-muted">${esc(x.conclusion)}</span></div>${design.validation ? `<div class="ar-validation ar-state"><span class="ar-small ar-muted">Validation</span>${badge(x.validation, tone(x.validation))}</div>` : '<div class="ar-validation"></div>'}<button type="button" class="ar-btn ghost small ar-chevron" aria-label="Open ${esc(x.title)}" data-action="open:${page}:${x.id}">›</button></div>`;
  }
  function sourceList() {
    const f = currentList(),
      all = fixtures.filter((x) => x.type === state.page),
      found = all.filter(
        (x) =>
          (x.title + " " + x.id).toLowerCase().includes(f.q.toLowerCase()) &&
          (f.status === "all" || x.status === f.status) &&
          f.source !== "closed",
      ),
      visible = listPage(found);
    return (
      heading(
        names[state.page],
        state.page === "pulls"
          ? "Review source changes and decide what happens next."
          : "Investigate bugs and shape feature plans.",
        button(
          "+ Import from GitHub",
          "import",
          "primary",
          state.role === "reader" ? "disabled" : "",
        ),
      ) +
      sourceFilters() +
      (!found.length
        ? empty(
            "No matching sources",
            "Try a different source number or clear the filters.",
            button("Clear filters", "clear-filters"),
          )
        : `<div class="ar-list"><div class="ar-list-label"><span>${found.length} ${names[state.page].toLowerCase()}</span><span>Investigation · Validation</span></div>${visible.map((x) => sourceRow(x)).join("")}${listPager(found.length)}</div>`)
    );
  }
  const facts = (values) =>
    `<div class="ar-facts">${values.map(([l, v]) => `<div><span>${l}</span><strong>${v}</strong></div>`).join("")}</div>`;
  const dt = (values) =>
    `<dl class="ar-definition">${values.map(([l, v]) => `<dt>${l}</dt><dd>${v}</dd>`).join("")}</dl>`;
  function sourceDetail() {
    const x = item(),
      isIssue = x.type === "issues",
      active = ["overview", "investigations", "discussion"].includes(state.tab)
        ? state.tab
        : "overview";
    let content = "";
    if (active === "overview")
      content = `<div class="ar-split"><div class="ar-stack"><section class="ar-panel"><h2>${isIssue ? "About this issue" : "About this change"}</h2><p>${isIssue ? (x.kind === "Bug" ? "After an update, opening Settings exits before the window becomes usable. The imported report includes reproduction steps; runtime reproduction is still pending." : "Allow users to export a selected subset of Settings. Preserve existing defaults and describe the acceptance criteria before implementation.") : "Preserve the last saved configuration when the user cancels a migration. This synthetic source exercises investigation, findings, feedback and follow-up validation."}</p><details><summary>Recorded source snapshot</summary>${dt(
        [
          ["Repository", "example/dashboard-ui-fixture"],
          ["Source", `${isIssue ? "Issue" : "PR"} #${x.id}`],
          ["Revision", "fixture-revision-01"],
          ["Imported discussion", "2 retained comments"],
        ],
      )}${button("Inspect exact snapshot", "snapshot", "ghost small")}</details></section><section class="ar-panel"><div class="ar-row"><h2>Current investigation</h2><span class="ar-spacer"></span>${badge(x.status, tone(x.status))}</div><p class="ar-muted" style="margin-top:12px">${esc(x.conclusion)} · ${isIssue ? "Imported issue snapshot" : "Exact original PR revision"}</p><div class="ar-row" style="margin-top:16px">${button("Open task", "open:tasks:" + x.id)}${reportSnapshots[x.id] ? button("Review saved report →", "open:reports:" + x.id, "primary") : ""}</div></section></div><aside class="ar-panel"><h2>Source context</h2>${dt(
        [
          ["Repository", "example/dashboard-ui-fixture"],
          ["Source state", badge("Open", "success")],
          ["Classification", isIssue ? x.kind : "Pull request"],
          ["Saved source", isIssue ? "Imported Issue snapshot" : "a4d71e2 · exact commit"],
        ],
      )}<hr>${button("View recorded discussion", "source-tab:discussion", "ghost small")}${button("Open source snapshot", "snapshot", "ghost small")}</aside></div>`;
    if (active === "investigations")
      content = `<div class="ar-list"><div class="ar-list-label">Investigations for this source</div>${sourceRow(x, "tasks")}${x.id === "2103" ? sourceRow({ ...x, id: "2101", title: "Previous completed attempt", status: "Completed" }, "tasks") : ""}</div>`;
    if (active === "discussion")
      content = `${notice("Imported discussion is a frozen snapshot. New GitHub comments are not included until another import.")}<div class="ar-stack"><section class="ar-panel"><div class="ar-row"><h3>Fixture maintainer</h3><span class="ar-muted ar-small">21 Sep, 09:12 · Imported</span></div><p>Please verify the cancellation path and check that the previous configuration is preserved.</p></section><section class="ar-panel"><h3>Fixture author</h3><p>The update includes a cancellation guard. Runtime validation has not been recorded.</p></section></div>`;
    return (
      `<div class="ar-back">${button("← Back to filtered " + names[x.type].toLowerCase(), "back", "ghost small")}</div><div class="ar-kicker">${isIssue ? "Issue" : "Pull request"} #${x.id} · example/dashboard-ui-fixture</div>` +
      heading(
        x.title,
        "Open · Snapshot imported 21 Sep, 09:10",
        button(
          isIssue ? "Investigate issue" : "Start review",
          "start",
          "primary",
          state.role === "reader" ? "disabled" : "",
        ),
      ) +
      (state.scenario === "stale"
        ? notice(
            "A newer source revision is available. This saved report still describes revision 01. Re-import and review the current source before an external action.",
            "warning",
          )
        : "") +
      facts([
        ["Source", isIssue ? "Issue snapshot" : "Original PR"],
        ["Investigation", badge(x.status, tone(x.status))],
        ["Saved report", x.conclusion],
        ["Validation", x.validation],
      ]) +
      tabs(
        [
          { id: "overview", label: "Overview" },
          { id: "investigations", label: "Investigations" },
          { id: "discussion", label: "Discussion" },
        ],
        active,
        "source-tab:",
      ) +
      content
    );
  }
  function taskList() {
    const f = currentList(),
      found = fixtures.filter(
        (x) =>
          x.status !== "Needs review" &&
          (x.title + " " + x.id).toLowerCase().includes(f.q.toLowerCase()) &&
          (f.status === "all" ||
            (f.status === "active" && ["Running", "Queued"].includes(x.status)) ||
            (f.status === "attention" && ["Blocked", "Interrupted", "Failed"].includes(x.status))),
      ),
      visible = listPage(found);
    return (
      heading(
        "Tasks",
        "Follow execution, saved progress and recovery.",
        button("Choose a source", "page:pulls", "primary"),
      ) +
      `<div class="ar-toolbar"><div class="ar-search">${field("Search tasks", "ar-list-search", f.q, "search", 'placeholder="Title or source number"')}</div>${button("↻ Refresh", "refresh", "ghost")}</div><div class="ar-pills">${[
        ["all", "All tasks"],
        ["active", "Active"],
        ["attention", "Needs attention"],
      ]
        .map(
          ([v, l]) =>
            `<button data-action="filter:${v}" type="button" aria-pressed="${f.status === v}">${l}</button>`,
        )
        .join("")}</div>` +
      (!found.length
        ? empty(
            "No matching tasks",
            "Change the filters to see more tasks.",
            button("Clear filters", "clear-filters"),
          )
        : `<div class="ar-list"><div class="ar-list-label">${found.length} tasks · Execution and comment delivery are separate</div>${visible.map((x) => sourceRow(x, "tasks")).join("")}${listPager(found.length)}</div>`)
    );
  }
  function evidence() {
    if (item().type === "issues")
      return `<section class="ar-panel"><h2>${item().kind === "Feature" ? "Acceptance criteria" : "Reproduction evidence"}</h2>${notice(item().kind === "Feature" ? "The saved request describes desired behavior. Maintainer acceptance, implementation and runtime checks are not recorded." : "The imported reporter statement describes the startup failure. No accepted runtime observation confirms reproduction.", "warning")}${dt(
        [
          ["Subject", "Imported Issue snapshot"],
          ["Evidence", "Retained description and discussion"],
          ["Runtime result", "Not recorded"],
        ],
      )}</section>`;
    return `<div class="ar-grid"><section class="ar-panel"><h2>Validation checks</h2><div class="ar-row">${badge("Required E2E", "warning")}${badge("Not run", "neutral")}</div><p class="ar-muted" style="margin-top:12px">Source review is available. No accepted runtime check proves the cancellation scenario passed.</p><details><summary>Required check and subject</summary>${dt(
      [
        ["Check", "Cancel settings migration"],
        ["Expected", "Prior settings remain unchanged"],
        ["Subject", "Original PR revision a4d71e2"],
        ["Recorded result", "No check result"],
      ],
    )}</details></section><section class="ar-panel"><h2>Registered evidence</h2><div class="ar-media"><span class="ar-muted">settings-cancellation.png</span>${badge("Unavailable", "warning")}<span class="ar-small ar-muted">Content is not retained in this prototype.</span>${button("View provenance", "artifact", "small")}</div><p class="ar-small ar-muted" style="margin-top:12px">Only registered, available content receives preview and download actions.</p></section></div>`;
  }
  function taskDetail() {
    const x = item(),
      active = ["progress", "evidence", "details"].includes(state.tab) ? state.tab : "progress";
    let content = "";
    if (active === "progress") {
      const entries = [
        {
          time: "09:10:01",
          type: "event",
          title: "Task started",
          text: "Pinned the imported source revision and restored the saved task context.",
        },
        {
          time: "09:10:04",
          type: "agent",
          title: "Agent",
          text: "Inspecting the cancellation path and matching it to the retained source snapshot.",
        },
        {
          time: "09:11:12",
          type: "tool",
          title: "Tool result",
          text: "Read SettingsMigration.cs. Located the configuration write after cancellation.",
        },
        {
          time: "09:12:09",
          type: "agent",
          title: "Agent",
          text: "The candidate is reproducible by source reasoning. Required E2E validation is not recorded.",
        },
        {
          time: "09:14:20",
          type: "event",
          title: "Checkpoint saved",
          text: "Candidate recheck and evidence references preserved. No hidden reasoning is displayed.",
        },
      ].filter(
        (e) =>
          (state.eventType === "all" || state.eventType === e.type) &&
          (e.text + " " + e.title).toLowerCase().includes(state.taskOutputQuery.toLowerCase()),
      );
      content =
        (x.status === "Blocked"
          ? notice(
              "<strong>Build prerequisite unavailable.</strong> Install the pinned toolchain on the assigned Worker before attempting the saved E2E plan. " +
                button("Read diagnostics", "task-tab:details", "small"),
              "warning",
            )
          : x.status === "Interrupted"
            ? notice(
                "<strong>Token budget exhausted.</strong> A checkpoint is saved. Raise the limit to continue from the same source.",
                "warning",
              )
            : x.status === "Cancelling"
              ? notice(
                  "Cancellation requested. The Worker still owns execution until cleanup is confirmed.",
                  "warning",
                )
              : "") +
        `<section class="ar-panel"><div class="ar-row"><h2>Agent output</h2>${badge(state.follow ? "Following output" : "Follow paused")}<span class="ar-spacer"></span>${button(state.follow ? "Pause follow" : "Follow output", "follow", "small")}${button("Export loaded output", "output-export", "small")}</div><p class="ar-small ar-muted" style="margin:8px 0 18px">Synthetic visible output · Pausing follow does not pause the task.</p>${facts(
          [
            ["Reported tokens", x.tokens === null ? "Not reported" : x.tokens.toLocaleString()],
            ["Requested model", "synthetic-codex-model"],
            ["Reasoning effort", "Not recorded"],
            ["Usage completeness", x.tokens === null ? "Not available" : "Reported counters"],
          ],
        )}<div class="ar-toolbar">${select(
          "Attempt",
          "ar-attempt",
          [
            ["1", "Attempt 1 · saved"],
            ["2", "Attempt 2 · resumed"],
          ],
          state.attempt,
        )}<div class="ar-search">${field("Search loaded output", "ar-output-search", state.taskOutputQuery, "search")}</div>${select(
          "Event type",
          "ar-event-type",
          [
            ["all", "All events"],
            ["agent", "Agent"],
            ["tool", "Tool results"],
            ["event", "Task events"],
          ],
          state.eventType,
        )}</div>${state.attempt === "2" ? notice("Attempt 2 is retained independently. Earlier output may be outside retention.", "warning") : ""}${entries.length ? entries.map((e) => `<div class="ar-log"><span class="ar-small ar-muted">${e.time}</span><div><h3>${e.title}</h3><p>${e.text}</p></div></div>`).join("") : empty("No matching loaded output", "Try another term or event type.")}</section>`;
    }
    if (active === "evidence") content = evidence();
    if (active === "details")
      content = `<div class="ar-grid"><section class="ar-panel"><h2>Frozen inputs</h2>${dt([
        ["Task", "task-" + x.id],
        ["Mode", x.mode],
        ["Source", "fixture-revision-01"],
        ["Profile", "Source review"],
        ["Prompt", "Saved investigation prompt"],
        [
          "Budget",
          taskBudget(x).rounds +
            " rounds · " +
            taskBudget(x).minutes +
            " minutes · " +
            taskBudget(x).tokens.toLocaleString() +
            " tokens · " +
            taskBudget(x).report +
            " MiB",
        ],
      ])}</section><section class="ar-panel"><h2>Ownership & recovery</h2>${dt([
        ["Worker", "fixture-desktop-worker"],
        ["Checkpoint", x.status === "Interrupted" ? "v4 · token limit reached" : "v2 · retained"],
        [
          "Cleanup",
          x.status === "Cancelling"
            ? "Awaiting original-owner confirmation"
            : x.status === "Running"
              ? "Execution owned"
              : "Confirmed / no active execution",
        ],
        ["Linked work", "Saved validation plan"],
      ])}<hr>${button("Open source", "open:" + x.type + ":" + x.id, "ghost small")}${reportSnapshots[x.id] ? button("Open report", "open:reports:" + x.id, "ghost small") : ""}</section></div>`;
    return (
      `<div class="ar-back">${button("← Back to filtered tasks", "back", "ghost small")}</div><div class="ar-kicker">${x.mode} investigation · ${x.type === "issues" ? "Issue" : "PR"} #${x.id}</div>` +
      heading(
        x.title,
        "task-" + x.id + " · Exact saved source",
        (reportSnapshots[x.id] ? button("Open report", "open:reports:" + x.id, "primary") : "") +
          (["Running", "Queued"].includes(x.status)
            ? button("Cancel task", "cancel-task", "", state.role === "reader" ? "disabled" : "")
            : ["Interrupted", "Blocked", "Failed", "Cancelled"].includes(x.status)
              ? button("Resume checkpoint", "resume", "", state.role === "reader" ? "disabled" : "")
              : ""),
      ) +
      facts([
        ["Execution", badge(x.status, tone(x.status))],
        ["Saved result", x.conclusion],
        ["Validation", x.validation],
        ["Delivery", x.status === "Interrupted" ? "Checkpoint" : "Saved independently"],
      ]) +
      tabs(
        [
          { id: "progress", label: "Progress" },
          { id: "evidence", label: "Evidence" },
          { id: "details", label: "Details" },
        ],
        active,
        "task-tab:",
      ) +
      content
    );
  }
  function findingsFor(x) {
    if (x.type === "issues")
      return [
        {
          id: 1,
          priority: "P1",
          status: "Needs verification",
          title:
            x.kind === "Feature"
              ? "Selective export needs an explicit compatibility decision"
              : "Settings startup exits after updating",
          path:
            x.kind === "Feature"
              ? "Imported feature request · acceptance criteria"
              : "Imported issue description · steps 1–3",
          subject: "Issue snapshot",
          trigger:
            x.kind === "Feature"
              ? "Selecting only some settings for export needs rules for dependencies, default values and import compatibility. Maintainer decisions remain pending."
              : "The reporter describes Settings exiting before its window becomes usable after an update. This is a retained report; runtime reproduction is still pending.",
          excerpt:
            x.kind === "Feature"
              ? "Request: export selected Settings sections while preserving existing defaults."
              : "Reported steps: update the application, open Settings, observe the window exiting.",
          recheck:
            x.kind === "Feature"
              ? "Requirements were reviewed against the imported request. Maintainer acceptance and implementation have not been recorded."
              : "The reporter statement is retained. Runtime reproduction and root cause have not been confirmed.",
          feedback:
            x.kind === "Feature"
              ? "Please confirm compatibility and dependency rules before implementing selective export."
              : "Please verify the reported startup failure against an exact source commit and retain the observed result.",
        },
      ];
    const count = x.id === "2102" ? 26 : x.type === "issues" ? 1 : 2;
    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      priority: x.id === "2102" && i === 25 ? "P0" : "P1",
      status: i === 3 ? "Needs verification" : "Confirmed",
      title:
        i === 25
          ? "Unconditional deletion can remove the persisted configuration"
          : count > 2
            ? `Cancellation path ${i + 1} can persist stale settings`
            : i === 0
              ? "Cancellation can persist stale settings"
              : "Cancelled migration can leave an incomplete configuration",
      path: i === 25 ? "ConfigurationStore.cs:126" : `SettingsMigration.cs:${42 + i * 3}`,
      subject: "original PR revision",
      trigger:
        i === 25
          ? "Deleting the store before validating the destination can remove all saved settings when the destination is inaccessible."
          : "Cancel a settings migration after processing begins. The final write may still overwrite the last saved configuration.",
      excerpt: "if (cancellationRequested) return;\nawait configuration.SaveAsync(nextSettings);",
      recheck:
        i === 3
          ? "The candidate still needs verification. Neither a final confirmation nor runtime validation is recorded."
          : "Confirmed against the retained source. No accepted runtime validation is recorded.",
      feedback:
        "Please preserve the previously saved settings when cancellation is requested. The write must be guarded before persistence.",
    }));
  }
  function reportList() {
    const f = currentList(),
      found = Object.values(reportSnapshots).filter(
        (x) =>
          (x.title + " " + x.id).toLowerCase().includes(f.q.toLowerCase()) &&
          (f.status === "all" ||
            (f.status === "partial" && x.completeness === "Partial") ||
            (f.status === "complete" && x.completeness === "Complete")),
      );
    return (
      heading("Reports", "Saved findings, independent validation and precise next actions.") +
      `<div class="ar-toolbar"><div class="ar-search">${field("Search reports", "ar-list-search", f.q, "search")}</div>${select(
        "Completeness",
        "ar-report-completeness",
        [
          ["all", "All reports"],
          ["complete", "Complete"],
          ["partial", "Partial / checkpoint"],
        ],
        f.status,
      )}${button("↻ Refresh", "refresh", "ghost")}</div><div class="ar-list"><div class="ar-list-label">${found.length} immutable reports</div>${found.length ? found.map((x) => sourceRow(x, "reports")).join("") : empty("No matching reports", "Clear filters to see saved reports.", button("Clear filters", "clear-filters"))}</div>`
    );
  }
  function reportDetail() {
    const x = reportSnapshots[state.id];
    if (!x)
      return (
        heading(
          "No saved report",
          "This source has no retained report. Task progress does not establish a saved result.",
        ) +
        empty(
          "No saved report",
          "Open the source or task to follow its current investigation.",
          button("Open source", "open:" + item().type + ":" + item().id) +
            button("Back to reports", "back", "primary"),
        )
      );
    const all = findingsFor(x),
      active = ["findings", "evidence", "details"].includes(state.tab) ? state.tab : "findings",
      partial = x.completeness === "Partial";
    state.selected[x.id] ||= [];
    const selected = state.selected[x.id],
      hasP0 = all.some((f) => f.priority === "P0"),
      readOnly = state.role === "reader" ? "disabled" : "";
    let content = "";
    if (active === "findings") {
      const matched = all.filter(
        (f) =>
          (state.severity === "all" || f.priority === state.severity) &&
          (state.findingStatus === "all" || f.status === state.findingStatus) &&
          (f.title + " " + f.path).toLowerCase().includes(state.findingQuery.toLowerCase()),
      );
      const pageCount = Math.max(1, Math.ceil(matched.length / 25));
      state.findingPage = Math.min(state.findingPage, pageCount);
      const page = matched.slice((state.findingPage - 1) * 25, state.findingPage * 25);
      const chosen = page.find((f) => f.id === state.finding) || page[0];
      if (chosen) state.finding = chosen.id;
      const shown = state.indexExpanded ? page : page.slice(0, 5);
      const draft = state.drafts[x.id + ":" + state.finding] ?? chosen?.feedback ?? "";
      content = `<div class="ar-toolbar"><div class="ar-search">${field("Search all " + all.length + " findings", "ar-finding-search", state.findingQuery, "search", 'placeholder="Title or file path"')}</div>${select(
        "Priority",
        "ar-priority",
        [
          ["all", "All priorities"],
          ["P0", "P0 · " + all.filter((f) => f.priority === "P0").length],
          ["P1", "P1 · " + all.filter((f) => f.priority === "P1").length],
        ],
        state.severity,
      )}${select(
        "Assessment",
        "ar-finding-status",
        [
          ["all", "All assessments"],
          ["Confirmed", "Confirmed"],
          ["Needs verification", "Needs verification"],
        ],
        state.findingStatus,
      )}</div><div class="ar-draft-bar ar-row"><strong>${selected.length} selected across all pages</strong><span class="ar-spacer"></span>${button("Select current page", "select-page", "small", readOnly)}${button("Clear selection", "clear-selection", "ghost small", readOnly)}${button("Save private drafts", "save-drafts", "small", readOnly)}</div>`;
      if (!matched.length)
        content += empty(
          "No matching findings",
          "Search covers the complete saved collection.",
          button("Clear finding filters", "clear-finding-filters"),
        );
      else
        content += `<div class="ar-mobile-findings">${select(
          "Current finding · " + matched.length + " matches",
          "ar-finding-picker",
          matched.map((f) => [String(f.id), f.priority + " · " + f.id + ". " + f.title]),
          String(state.finding),
        )}</div><div class="ar-findings"><aside class="ar-finding-index" aria-label="Findings directory"><div class="ar-small ar-muted">${(state.findingPage - 1) * 25 + 1}–${Math.min(state.findingPage * 25, matched.length)} of ${matched.length} findings</div>${shown.map((f) => `<button type="button" class="ar-finding-choice" data-action="finding:${f.id}" aria-current="${f.id === chosen.id}"><span>${badge(f.priority, f.priority === "P0" ? "error" : "warning")} <span class="ar-small">${f.status}</span></span><strong>${f.id}. ${esc(f.title)}</strong><small>${f.path}</small></button>`).join("")}${page.length > 5 ? button(state.indexExpanded ? "Collapse directory" : "Show all " + page.length + " on this page", "expand-index", "ghost small") : ""}</aside><article class="ar-panel ar-finding-body"><div><div class="ar-row"><label class="ar-row"><input type="checkbox" id="ar-selected-finding" ${readOnly} ${selected.includes(chosen.id) ? "checked" : ""}>Include in feedback</label><span class="ar-spacer"></span>${badge(chosen.priority, chosen.priority === "P0" ? "error" : "warning")}</div><h2 style="margin-top:12px">${esc(chosen.title)}</h2><p class="ar-small ar-muted">${chosen.status} · Finding ${chosen.id} / ${all.length} · ${esc(chosen.subject)}</p></div><div><h3>Trigger & impact</h3><p>${esc(chosen.trigger)}</p></div><div><h3>Source evidence</h3><code>${chosen.path}</code><pre>${esc(chosen.excerpt)}</pre><p class="ar-small ar-muted">Illustrative source excerpt · Synthetic fixture</p></div><div><h3>Final recheck</h3><p>${esc(chosen.recheck)}</p></div><div><label class="ar-field" for="ar-feedback">Independent feedback draft<textarea id="ar-feedback" ${readOnly}>${esc(draft)}</textarea></label><p class="ar-small ar-muted" style="margin-top:8px">${state.role === "reader" ? "Read-only account · feedback editing requires preparation permission." : "Private until prepared and separately confirmed."}</p></div></article></div><div class="ar-pager"><span>Page ${state.findingPage} of ${pageCount} · 25 findings per data page</span><div class="ar-row">${button("Previous page", "finding-prev", "small", state.findingPage === 1 ? "disabled" : "")}${button("Next page", "finding-next", "small", state.findingPage === pageCount ? "disabled" : "")}</div></div>`;
    }
    if (active === "evidence") content = evidence();
    if (active === "details")
      content = `<div class="ar-grid"><section class="ar-panel"><h2>Report identity</h2>${dt([
        ["Report", "report-" + x.id],
        ["Version", "1 · immutable"],
        ["Delivery", partial ? "Checkpoint" : "Final"],
        ["Completeness", partial ? "Partial" : "Complete"],
        ["Original subject", "fixture-revision-01"],
        ["Digest", "synthetic-report-digest-01"],
      ])}</section><section class="ar-panel"><h2>${x.type === "issues" ? "Saved follow-up plan" : "Coverage & remaining work"}</h2><p>${x.type === "issues" ? (x.kind === "Feature" ? "Implement selective export, retain default behavior and add acceptance coverage. Maintainer acceptance is still separate." : "Verify the startup failure against a chosen exact source commit and record the observed result.") : "Changed-path coverage retained. Candidate rechecks completed; required E2E remains outstanding."}</p><hr>${button("Review saved plan", "followup-plan", "primary")}</section></div>`;
    return (
      `<div class="ar-back">${button("← Back to filtered reports", "back", "ghost small")}</div><div class="ar-kicker">${x.type === "issues" ? x.kind + " investigation" : "PR review"} · #${x.id} · Report v1</div>` +
      heading(
        x.title,
        "Saved source · a4d71e2 · 21 Sep, 09:20",
        button("Prepare action", "prepare", "primary", state.role === "reader" ? "disabled" : "") +
          button("Open task", "open:tasks:" + x.id, "small"),
      ) +
      facts([
        ["Execution", badge(x.status, tone(x.status))],
        ["Report", partial ? "Partial" : "Complete"],
        ["Delivery", partial ? "Checkpoint" : "Final"],
        ["Validation", badge(x.validation, tone(x.validation))],
      ]) +
      (hasP0
        ? notice(
            "<strong>1 unresolved P0 on the original revision.</strong> Approve is unavailable regardless of page or selection. " +
              button("Locate P0", "locate-p0", "small"),
            "error",
          )
        : notice(
            partial
              ? "Partial investigation retained. Remaining work and validation are recorded in Details."
              : x.type === "issues"
                ? x.kind === "Bug"
                  ? "Assessment: needs verification. Reproduction is not confirmed."
                  : "Implementation plan ready. Maintainer acceptance has not been recorded."
                : "Source review is complete. Required E2E validation remains outstanding.",
            "warning",
          )) +
      (state.scenario === "stale"
        ? notice(
            "The source changed after this report. Existing findings stay attached to their saved revision; refresh the action context.",
            "warning",
          )
        : "") +
      `<div class="ar-row" style="justify-content:space-between">${tabs(
        [
          { id: "findings", label: "Findings (" + all.length + ")" },
          { id: "evidence", label: "Evidence" },
          { id: "details", label: "Details" },
        ],
        active,
        "report-tab:",
      )}${button("Export JSON", "report-export", "ghost small")}</div>` +
      content
    );
  }
  function specialState() {
    if (state.scenario === "loading")
      return (
        heading(names[state.page] || "Workspace", "Loading the current repository scope…") +
        `<div class="ar-panel" role="status" aria-label="Loading"><div class="ar-skeleton" style="width:55%"></div><div class="ar-skeleton"></div><div class="ar-skeleton" style="width:80%"></div><div class="ar-skeleton"></div>${button("Complete sample load", "state-normal")}</div>`
      );
    if (state.scenario === "error")
      return (
        heading(names[state.page] || "Workspace", "Current repository scope") +
        notice(
          "Could not load " +
            (names[state.page] || "workspace").toLowerCase() +
            ". Check your connection and try again.",
          "error",
        ) +
        empty(
          "Connection interrupted",
          "The request did not return usable data. Retry with the same scope.",
          button("Retry", "state-normal", "primary"),
        )
      );
    if (state.scenario === "empty")
      return (
        heading(names[state.page] || "Workspace", "Current repository scope") +
        empty(
          "No " + (names[state.page] || "records").toLowerCase() + " yet",
          "There are no records in this authorized scope.",
          button("Return to sample data", "state-normal", "primary"),
        )
      );
    if (state.scenario === "noaccess" || !permitted(state.page))
      return empty(
        "Access required",
        "This account does not have permission to open this area.",
        button("My account", "page:account", "primary"),
      );
    return null;
  }
  function render() {
    root.dataset.page = state.page;
    root.dataset.nav = design.expanded ? "expanded" : "compact";
    root.style.setProperty("--ar-row-pad", design.compact ? "12px" : "18px");
    $("ar-role").value = state.role;
    $("ar-scenario").value = state.scenario;
    $("ar-repo").value = state.repo;
    const group = groups.find((g) => g.pages.includes(state.page));
    $("ar-nav").innerHTML = groups
      .map(
        (g) =>
          `<button type="button" data-action="page:${g.pages[0]}" ${g === group ? 'aria-current="page"' : ""}><span class="ar-icon" aria-hidden="true">${g.symbol}</span><span>${g.label}</span></button>`,
      )
      .join("");
    const groupNav =
      !state.id && group && group.pages.length > 1
        ? `<nav class="ar-group" aria-label="${group.label} pages">${group.pages
            .filter(permitted)
            .map(
              (p) =>
                `<button type="button" data-action="page:${p}" ${state.page === p ? 'aria-current="page"' : ""}>${names[p]}</button>`,
            )
            .join("")}</nav>`
        : "";
    let content = state.page === "login" ? null : specialState();
    if (!content)
      content =
        state.page === "pulls" || state.page === "issues"
          ? state.id
            ? sourceDetail()
            : sourceList()
          : state.page === "tasks"
            ? state.id
              ? taskDetail()
              : taskList()
            : state.page === "reports"
              ? state.id
                ? reportDetail()
                : reportList()
              : ops.render(state.page);
    const pending =
      state.id && ["pulls", "issues", "tasks", "reports"].includes(state.page)
        ? pendingIntent()
        : null;
    $("ar-main").innerHTML =
      groupNav +
      (pending
        ? notice(
            "An action for this source has an unconfirmed result. Its original payload is retained. " +
              button("Check saved submission", "check-intent", "small"),
            "warning",
          )
        : "") +
      (content || empty("Page unavailable", "Choose a destination from the navigation."));
    $("ar-context").textContent =
      (state.repo === "all" ? "All accessible repositories" : "example/dashboard-ui-fixture") +
      " · Synthetic data · No external actions";
  }
  function retainInputRender(el, callback) {
    const id = el.id,
      position = el.selectionStart;
    callback();
    const target = $(id);
    if (target) {
      target.focus();
      if (typeof position === "number" && target.type !== "number")
        try {
          target.setSelectionRange(position, position);
        } catch {}
    }
  }
  function inputValue(id) {
    return $(id)?.value ?? "";
  }
  function trackCoreInput(el) {
    if (el.id === "ar-import-url") {
      dialogDirty = true;
      return true;
    }
    if (!coreForm || !el.closest("#ar-dialog-body")) return false;
    if (coreForm.kind === "prepare") captureActionDraft();
    else if (coreForm.kind === "start") captureStartDraft();
    else if (coreForm.kind === "resume" && el.id.startsWith("ar-resume-"))
      state.resumeDrafts[coreForm.key][el.id.slice(10)] = el.value;
    else if (coreForm.kind === "followup" && el.id === "ar-plan-sha") actionDraft().sha = el.value;
    else return false;
    dialogDirty = true;
    return true;
  }
  function dialogError(text, id) {
    const old = $("ar-form-error");
    if (old) old.remove();
    $("ar-dialog-body").insertAdjacentHTML(
      "afterbegin",
      `<div id="ar-form-error">${notice(esc(text), "error")}</div>`,
    );
    if (id) {
      $(id)?.setAttribute("aria-invalid", "true");
      $(id)?.focus();
    }
  }
  function importDialog() {
    openDialog(
      "Import source snapshot",
      notice("Prototype import creates a local synthetic source. No request is sent to GitHub.") +
        field(
          "GitHub pull request or issue URL",
          "ar-import-url",
          "https://github.com/example/dashboard-ui-fixture/pull/2106",
          "url",
        ) +
        `<p class="ar-muted">The production operation reads the source and discussion into a saved snapshot.</p>`,
      button("Cancel", "dialog-close") + button("Import snapshot", "import-submit", "primary"),
    );
  }
  function startDialog() {
    const x = item(),
      key = sourceKey(x);
    if (state.startRequests[key]?.status === "unknown") {
      startRecoveryDialog();
      return;
    }
    state.startDrafts[key] ||= {
      mode: x.type === "issues" ? "snapshot" : "source",
      sha: x.type === "issues" ? "" : "a".repeat(40),
      rounds: "8",
      minutes: "30",
      tokens: "20000",
      report: "2",
    };
    const d = state.startDrafts[key];
    openDialog(
      x.type === "issues" ? "Investigate issue" : "Start pull request review",
      `<div class="ar-panel"><strong>${esc(x.title)}</strong><p class="ar-small ar-muted">#${x.id} · fixture-revision-01</p></div>` +
        (x.type === "issues"
          ? select(
              "Investigation mode",
              "ar-start-mode",
              [
                ["snapshot", "Imported snapshot only"],
                ["source", "Read exact source"],
              ],
              d.mode,
            ) +
            `<div id="ar-start-sha-wrap" ${d.mode !== "source" ? "hidden" : ""}>${field("Full source commit SHA", "ar-start-sha", d.sha, "text", 'placeholder="40–64 hexadecimal characters"')}</div>`
          : notice(
              "Read exact original PR source · a4d71e2. Static investigation does not start repository execution.",
            )) +
        `<details><summary>Budget limits</summary><div class="ar-grid">${field("Rounds", "ar-budget-rounds", d.rounds, "number", 'min="1"')}${field("Duration (minutes)", "ar-budget-minutes", d.minutes, "number", 'min="1"')}${field("Tokens", "ar-budget-tokens", d.tokens, "number", 'min="1"')}${field("Report limit (MiB) · configured", "ar-budget-report", d.report, "number", "readonly")}</div></details>`,
      button("Cancel", "dialog-close") +
        button(
          "Create investigation",
          "start-submit",
          "primary",
          state.role === "reader" ? "disabled" : "",
        ),
    );
    coreForm = { kind: "start", key, initial: { ...d } };
  }
  function captureStartDraft() {
    const d = state.startDrafts[sourceKey()];
    if (!d) return null;
    for (const [key, id] of Object.entries({
      mode: "ar-start-mode",
      sha: "ar-start-sha",
      rounds: "ar-budget-rounds",
      minutes: "ar-budget-minutes",
      tokens: "ar-budget-tokens",
      report: "ar-budget-report",
    }))
      if ($(id)) d[key] = inputValue(id);
    return d;
  }
  function startRecoveryDialog() {
    const request = state.startRequests[sourceKey()];
    if (!request) return;
    openDialog(
      "Creation result unconfirmed",
      notice(
        "The response was lost. Keep request " +
          esc(request.id) +
          "; recovery uses the exact saved inputs and cannot create a second task.",
        "warning",
      ) + `<pre>${esc(JSON.stringify(request.inputs, null, 2))}</pre>`,
      button("Close", "dialog-close") +
        button(
          "Recover original request",
          "start-recover",
          "primary",
          state.role === "reader" ? "disabled" : "",
        ),
    );
  }
  function queueCreatedTask(d) {
    const x = item();
    x.status = "Queued";
    x.mode = "Static";
    state.taskBudgets[sourceKey(x)] = {
      tokens: Number(d.tokens),
      rounds: Number(d.rounds),
      minutes: Number(d.minutes),
      report: Number(d.report),
    };
    dialogDirty = false;
    closeDialog();
    nav("tasks", x.id);
  }
  function resumeDialog() {
    const x = item(),
      key = sourceKey(x),
      saved = taskBudget(x),
      consumed = taskConsumption(x);
    state.resumeDrafts[key] ||= { ...saved };
    const d = state.resumeDrafts[key];
    openDialog(
      "Resume from saved checkpoint",
      notice(
        "Source, scope, profile and prompt remain frozen. Saved limits cannot decrease; increase only the limits already exhausted.",
      ) +
        (x.status === "Blocked"
          ? notice(
              "Resolve the recorded prerequisite before restarting. A new attempt does not repair the dependency.",
              "warning",
            )
          : "") +
        `<p><strong>Consumed:</strong> ${consumed.tokens.toLocaleString()} tokens · ${consumed.rounds} rounds · ${consumed.minutes} minutes · ${consumed.report} MiB</p><div class="ar-grid">${field("Token limit (saved: " + saved.tokens.toLocaleString() + ")", "ar-resume-tokens", d.tokens, "number", `min="${saved.tokens}" step="1"`)}${field("Rounds (saved: " + saved.rounds + ")", "ar-resume-rounds", d.rounds, "number", `min="${saved.rounds}" step="1"`)}${field("Duration minutes (saved: " + saved.minutes + ")", "ar-resume-minutes", d.minutes, "number", `min="${saved.minutes}"`)}${field("Report MiB (saved: " + saved.report + ")", "ar-resume-report", d.report, "number", `min="${saved.report}"`)}</div>`,
      button("Cancel", "dialog-close") +
        button(
          "Resume task",
          "resume-submit",
          "primary",
          state.role === "reader" ? "disabled" : "",
        ),
    );
    coreForm = { kind: "resume", key, initial: { ...d } };
  }
  function actionDraft(x = item()) {
    const key = sourceKey(x);
    state.actionDrafts[key] ||= {
      operation: "comment",
      body: (state.selected[x.id] || [])
        .map(
          (id) =>
            state.drafts[x.id + ":" + id] ??
            findingsFor(x).find((f) => f.id === id)?.feedback ??
            "",
        )
        .join("\n\n"),
      method: "Squash",
      workflow: "validation.yml",
      sha: x.type === "issues" ? "" : "a".repeat(40),
      path: "src/settings/SettingsMigration.cs",
      line: "42",
    };
    return state.actionDrafts[key];
  }
  function captureActionDraft() {
    const d = actionDraft();
    for (const [key, id] of Object.entries({
      operation: "ar-operation",
      body: "ar-action-body",
      method: "ar-merge-method",
      workflow: "ar-workflow",
      sha: "ar-action-sha",
      path: "ar-suggestion-path",
      line: "ar-suggestion-line",
    }))
      if ($(id)) d[key] = inputValue(id);
    return d;
  }
  function prepareDialog() {
    if (pendingIntent()) {
      unknownActionDialog(pendingIntent());
      return;
    }
    const x = item(),
      p0 = findingsFor(x).some((f) => f.priority === "P0"),
      options =
        x.type === "issues"
          ? [
              ["comment", "Comment"],
              ["close", "Close issue"],
              ["followup", "Start saved follow-up plan"],
            ]
          : [
              ["comment", "Comment"],
              ["approve", "Approve" + (p0 ? " · unavailable: unresolved P0" : "")],
              ["request-changes", "Request changes"],
              ["suggestion", "Code suggestion comment"],
              ["merge", "Merge"],
              ["close", "Close PR"],
              ["ci", "Trigger CI"],
              ["followup", "Verify saved plan"],
            ];
    const d = actionDraft(x);
    openDialog(
      "Prepare action",
      notice(
        "Recommendation: " +
          (p0
            ? "resolve the P0 before approval."
            : x.type === "issues"
              ? "review the saved plan and evidence."
              : "request changes or validate the outstanding checks.") +
          " Availability is checked independently.",
      ) +
        select("Operation", "ar-operation", options, d.operation) +
        `<div id="ar-operation-options"></div><label class="ar-field" for="ar-action-body">Feedback to include<textarea id="ar-action-body">${esc(d.body)}</textarea></label><p class="ar-small ar-muted">${(state.selected[x.id] || []).length} selected findings · private preparation draft</p>`,
      button("Cancel", "dialog-close") +
        button(
          "Prepare exact preview",
          "prepare-submit",
          "primary",
          state.role === "reader" ? "disabled" : "",
        ),
    );
    coreForm = { kind: "prepare", key: sourceKey(x), initial: { ...d } };
    operationOptions();
  }
  function operationOptions() {
    const d = actionDraft(),
      op = d.operation,
      p0 = findingsFor(item()).some((f) => f.priority === "P0");
    $("ar-operation-options").innerHTML =
      op === "approve" && p0
        ? notice(
            "Approve is blocked by a confirmed, unresolved P0 on the original revision. Selection and pagination do not change this rule.",
            "error",
          )
        : op === "merge"
          ? select(
              "Merge method",
              "ar-merge-method",
              ["Squash", "Merge commit", "Rebase"],
              d.method,
            ) +
            notice(
              "Merge has independent target and permission guards. A P0 is not used as its automatic content prohibition.",
              "warning",
            )
          : op === "ci"
            ? field("Workflow file", "ar-workflow", d.workflow)
            : op === "followup"
              ? notice("Uses a persisted saved plan and its exact prerequisites.") +
                field("Full source commit SHA", "ar-action-sha", d.sha)
              : op === "close"
                ? notice(
                    "This closes the selected source on GitHub after a separate confirmation.",
                    "warning",
                  )
                : op === "suggestion"
                  ? notice("Code suggestions do not implicitly choose Request changes.") +
                    field("File path", "ar-suggestion-path", d.path) +
                    field("Line", "ar-suggestion-line", d.line, "number", 'min="1" step="1"')
                  : " ";
  }
  function unknownActionDialog(p) {
    if (!p) return;
    state.preview = p;
    openDialog(
      "Submission result unknown",
      notice(
        "Do not resubmit. Check the existing intent " +
          esc(p.id) +
          " and its receipt. This source cannot prepare another operation until it is resolved.",
        "warning",
      ) +
        dt([
          ["Target", p.sourceType + " #" + p.itemId],
          ["Operation", esc(p.operation)],
        ]) +
        `<p>Operation and payload stay bound to the original intent.</p><pre>${esc(JSON.stringify(p.payload, null, 2))}</pre>`,
      button("Close", "dialog-close") + button("Check existing submission", "reconcile", "primary"),
    );
  }
  function previewDialog() {
    const p = state.preview;
    openDialog(
      "Review exact action preview",
      notice("Prepared only · No operation has been executed.") +
        dt([
          ["Target", `${p.sourceType} #${p.itemId} · example/dashboard-ui-fixture`],
          ["Operation", esc(p.operation)],
          ["Expected source", "a4d71e2 · fixture-revision-01"],
          ["Report", "report-" + p.itemId + " · v1"],
          ["Intent", p.id + " · version 1"],
          ["Payload digest", "synthetic-payload-digest-01"],
        ]) +
        `<section class="ar-panel"><h3>Exact payload</h3><pre>${esc(JSON.stringify(p.payload, null, 2))}</pre></section>` +
        (state.role === "preparer"
          ? notice(
              "You can prepare this action, but this account has no execution permission.",
              "warning",
            )
          : "") +
        (state.scenario === "stale"
          ? notice(
              "Expected source is no longer current. Refresh the action context and prepare again.",
              "error",
            )
          : ""),
      button("Back to preparation", "prepare") +
        button(
          "Confirm " + p.operation,
          "confirm-action",
          /close|merge/.test(p.operation) ? "danger" : "primary",
          state.role !== "admin" || state.scenario === "stale" ? "disabled" : "",
        ),
    );
  }
  function showJourneys() {
    openDialog(
      "Prototype flow map",
      `<div class="ar-map">${[
        ["Review → findings → exact action", "journey:review"],
        ["26 findings → off-page P0", "journey:p0"],
        ["Interrupted → raise budget → resume", "journey:resume"],
        ["Bug → exact-source follow-up", "journey:issue"],
        ["Live task → output → cancellation", "journey:task"],
        ["Comments → delivery recovery", "journey:comments"],
        ["Webhook → handling recovery", "journey:webhooks"],
        ["Worker → disable → cleanup pending", "journey:workers"],
        ["Repository → settings", "journey:repositories"],
        ["Accounts → permissions", "journey:accounts"],
        ["Sign-in → workspace", "journey:login"],
      ]
        .map(([t, a]) => button(t, a))
        .join("")}</div>`,
      button("Close", "dialog-close"),
    );
  }
  function searchDialog() {
    openDialog(
      "Search workspace",
      field(
        "Search source titles, numbers, tasks and reports",
        "ar-global-search",
        "",
        "search",
        'placeholder="At least two characters"',
      ) +
        `<div id="ar-global-results" aria-live="polite"><p class="ar-muted">Results are limited to repositories this account can access.</p></div>`,
      button("Close", "dialog-close"),
    );
    $("ar-global-search").focus();
  }
  function handle(action, el) {
    if (action.startsWith("ops:")) {
      ops.handle(action, el);
      return;
    }
    const [verb, a, b] = action.split(":");
    if (verb === "page") {
      nav(a);
      return;
    }
    if (verb === "open") {
      nav(a, b);
      return;
    }
    if (verb === "journey") {
      const targets = {
        review: ["reports", "2101"],
        p0: ["reports", "2102"],
        resume: ["tasks", "2103"],
        issue: ["issues", "3101"],
        task: ["tasks", "2203"],
        comments: ["comments"],
        webhooks: ["webhooks"],
        workers: ["workers"],
        repositories: ["repositories"],
        accounts: ["accounts"],
        login: ["login"],
      };
      guardNavigation(() => {
        state.scenario = "normal";
        nav(...targets[a]);
      });
      return;
    }
    if (verb === "source-tab" || verb === "task-tab" || verb === "report-tab") {
      guardNavigation(() => {
        state.tab = a;
        syncRoute();
        render();
      });
      return;
    }
    if (verb === "filter") {
      currentList().status = a;
      currentList().page = 1;
      render();
      return;
    }
    if (verb === "finding") {
      state.finding = Number(a);
      render();
      return;
    }
    switch (action) {
      case "back":
        back();
        break;
      case "dialog-close":
        if (dialogDirty) {
          guardNavigation(closeDialog);
        } else closeDialog();
        break;
      case "guard-stay":
        pendingNavigation = null;
        if (pendingDialog) {
          const previous = pendingDialog;
          pendingDialog = null;
          openDialog(previous.title, previous.body, previous.footer);
          dialogDirty = previous.dirty;
          coreForm = previous.form;
        } else closeDialog();
        break;
      case "guard-discard":
        discardCoreForm(pendingDialog?.form);
        state.drafts = { ...state.savedDrafts };
        state.dirty = false;
        state.ops.dirty = false;
        state.ops.repoDrafts = {};
        state.ops.accountDrafts = {};
        delete state.ops.globalConcurrencyDraft;
        dialogDirty = false;
        pendingDialog = null;
        closeDialog();
        {
          const fn = pendingNavigation;
          pendingNavigation = null;
          fn?.();
        }
        break;
      case "theme":
        state.theme = state.theme === "dark" ? "light" : "dark";
        root.style.colorScheme = state.theme;
        break;
      case "account-menu":
        openDialog(
          "My workspace account",
          `<div class="ar-row"><span class="ar-mark">SF</span><div><strong>Synthetic fixture ${state.role}</strong><p class="ar-muted">Independent repository and action grants</p></div></div>`,
          button("Switch appearance", "theme") +
            button("My account", "page:account") +
            button("Sign out", "sign-out"),
        );
        break;
      case "sign-out":
        guardNavigation(() => {
          state.selected = {};
          state.drafts = {};
          state.savedDrafts = {};
          state.ops.repoDrafts = {};
          state.ops.accountDrafts = {};
          state.ops.dirty = false;
          state.scenario = "normal";
          nav("login");
        });
        break;
      case "state-normal":
        state.scenario = "normal";
        render();
        break;
      case "refresh":
        toast("Sample data refreshed for the current scope.");
        break;
      case "list-prev":
        currentList().page = Math.max(1, currentList().page - 1);
        render();
        restoreScroll();
        break;
      case "list-next":
        currentList().page++;
        render();
        restoreScroll();
        break;
      case "clear-filters":
        state.lists[state.page] = { q: "", status: "all", source: "all", page: 1 };
        if ($("ar-dialog-status")) $("ar-dialog-status").value = "all";
        if ($("ar-dialog-source")) $("ar-dialog-source").value = "all";
        render();
        break;
      case "filters":
        openDialog(
          "Source filters",
          select(
            "Investigation state",
            "ar-dialog-status",
            ["all", "Needs review", "Running", "Blocked", "Interrupted", "Completed"],
            currentList().status,
          ) +
            select(
              "Source state",
              "ar-dialog-source",
              [
                ["all", "All states"],
                ["open", "Open"],
                ["closed", "Closed"],
              ],
              currentList().source,
            ),
          button("Clear", "clear-filters") + button("Apply filters", "filters-apply", "primary"),
        );
        break;
      case "filters-apply":
        currentList().status = inputValue("ar-dialog-status");
        currentList().source = inputValue("ar-dialog-source");
        currentList().page = 1;
        closeDialog();
        render();
        break;
      case "import":
        importDialog();
        break;
      case "import-submit": {
        const value = inputValue("ar-import-url"),
          match = value.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)\/?$/);
        if (!match) {
          dialogError("Enter a complete GitHub pull request or issue URL.", "ar-import-url");
          break;
        }
        const id = match[2];
        if (!fixtures.some((x) => x.id === id))
          fixtures.unshift({
            id,
            type: match[1] === "pull" ? "pulls" : "issues",
            title: "Imported synthetic source #" + id,
            status: "Needs review",
            conclusion: "No report",
            validation: "Not run",
            mode: "Static",
            tokens: 0,
          });
        closeDialog();
        nav(match[1] === "pull" ? "pulls" : "issues", id);
        toast("Synthetic snapshot imported. No GitHub request was made.");
        break;
      }
      case "snapshot":
        openDialog(
          "Recorded source snapshot",
          dt([
            ["Repository", "example/dashboard-ui-fixture"],
            ["Source", "#" + item().id],
            ["Revision", "fixture-revision-01"],
            [
              "Commit",
              item().type === "issues" ? "Not chosen for this Issue snapshot" : "a".repeat(40),
            ],
            ["Discussion", "2 retained comments"],
            ["Imported", "21 Sep 2026, 09:10"],
          ]),
          button("Close", "dialog-close"),
        );
        break;
      case "start":
        startDialog();
        break;
      case "start-submit": {
        if (state.role === "reader") break;
        if (state.startRequests[sourceKey()]?.status === "unknown") {
          startRecoveryDialog();
          break;
        }
        const d = captureStartDraft();
        if (!d) break;
        if (d.mode === "source" && !/^[a-f0-9]{40,64}$/i.test(d.sha.trim())) {
          dialogError("Enter a full 40–64 character hexadecimal commit SHA.", "ar-start-sha");
          break;
        }
        if (
          ["rounds", "minutes", "tokens"].some(
            (key) => !Number.isInteger(Number(d[key])) || Number(d[key]) < 1,
          )
        ) {
          dialogError("Budget limits must be positive whole numbers.");
          break;
        }
        if (state.scenario === "conflict") {
          openDialog(
            "Source changed",
            notice(
              "The saved source revision no longer matches. Your source choice and budget are retained. Review the latest snapshot before creating a task.",
              "warning",
            ),
            button("Close", "dialog-close") +
              button("Review updated source", "source-refresh", "primary"),
          );
          break;
        }
        if (state.scenario === "unknown") {
          state.startRequests[sourceKey()] = {
            id: "create-" + item().id,
            inputs: { ...d },
            status: "unknown",
          };
          startRecoveryDialog();
          break;
        }
        queueCreatedTask(d);
        toast("Synthetic investigation queued. No Worker started.");
        break;
      }
      case "source-refresh":
        state.scenario = "normal";
        closeDialog();
        startDialog();
        break;
      case "start-recover": {
        const request = state.startRequests[sourceKey()];
        if (state.role === "reader" || request?.status !== "unknown") break;
        request.status = "accepted";
        state.scenario = "normal";
        queueCreatedTask(request.inputs);
        toast("Existing synthetic task recovered using the retained request.");
        break;
      }
      case "resume":
        resumeDialog();
        break;
      case "resume-submit": {
        if (state.role === "reader") break;
        const saved = taskBudget(),
          consumed = taskConsumption(),
          values = Object.fromEntries(
            ["tokens", "rounds", "minutes", "report"].map((key) => [
              key,
              Number(inputValue("ar-resume-" + key)),
            ]),
          );
        const invalid = Object.keys(values).find(
          (key) =>
            !Number.isFinite(values[key]) ||
            values[key] < saved[key] ||
            (["tokens", "rounds"].includes(key) && !Number.isInteger(values[key])) ||
            values[key] <= consumed[key],
        );
        if (invalid) {
          dialogError(
            "Limits cannot decrease; tokens and rounds must be whole numbers. " +
              (saved[invalid] <= consumed[invalid]
                ? "Increase " + invalid + " above the " + consumed[invalid] + " already consumed."
                : "Review the " + invalid + " limit."),
            "ar-resume-" + invalid,
          );
          break;
        }
        state.taskBudgets[sourceKey()] = { ...values };
        state.resumeDrafts[sourceKey()] = { ...values };
        item().status = "Queued";
        closeDialog();
        render();
        toast("Resume queued with the same frozen inputs and reviewed budget.");
        break;
      }
      case "cancel-task":
        openDialog(
          "Cancel this task?",
          notice(
            "Cancellation stops further execution. Active E2E ownership remains until its Worker confirms cleanup.",
            "warning",
          ),
          button("Keep running", "dialog-close") +
            button("Request cancellation", "cancel-confirm", "danger"),
        );
        break;
      case "cancel-confirm":
        item().status = item().mode === "E2E" ? "Cancelling" : "Cancelled";
        closeDialog();
        render();
        break;
      case "follow":
        state.follow = !state.follow;
        render();
        break;
      case "output-export":
        download(
          "synthetic-loaded-output.txt",
          "Synthetic visible output for task-" +
            item().id +
            "\nAttempt " +
            state.attempt +
            "\nSource pinned; cancellation path inspected; checkpoint retained.\nExport scope: loaded output only.",
        );
        break;
      case "artifact":
        openDialog(
          "Evidence provenance",
          notice(
            "Content unavailable. A provenance record does not prove a runtime check passed.",
            "warning",
          ) +
            dt([
              ["Artifact", "artifact-fixture-01"],
              ["Task", "task-" + item().id],
              ["Attempt", "attempt-fixture-01"],
              ["Producer", "fixture-desktop-worker"],
              ["Subject", "Original PR revision a4d71e2"],
              ["Availability", "Not retained in the prototype"],
            ]),
          button("Close", "dialog-close"),
        );
        break;
      case "select-page": {
        if (state.role === "reader") break;
        const all = findingsFor(item())
          .filter(
            (f) =>
              (state.severity === "all" || f.priority === state.severity) &&
              (state.findingStatus === "all" || state.findingStatus === f.status) &&
              (f.title + " " + f.path).toLowerCase().includes(state.findingQuery.toLowerCase()),
          )
          .slice((state.findingPage - 1) * 25, state.findingPage * 25);
        state.selected[item().id] = [
          ...new Set([...(state.selected[item().id] || []), ...all.map((f) => f.id)]),
        ];
        render();
        break;
      }
      case "clear-selection":
        if (state.role === "reader") break;
        state.selected[item().id] = [];
        render();
        break;
      case "save-drafts":
        if (state.role === "reader") break;
        state.savedDrafts = { ...state.drafts };
        state.dirty = false;
        toast("Private feedback saved in this prototype session. Nothing was published.");
        break;
      case "expand-index":
        state.indexExpanded = !state.indexExpanded;
        render();
        break;
      case "finding-next":
        state.findingPage++;
        state.finding = 26;
        render();
        break;
      case "finding-prev":
        state.findingPage = Math.max(1, state.findingPage - 1);
        state.finding = 1;
        render();
        break;
      case "locate-p0":
        state.tab = "findings";
        state.severity = "P0";
        state.findingPage = 1;
        state.finding = 26;
        render();
        break;
      case "clear-finding-filters":
        state.severity = "all";
        state.findingQuery = "";
        state.findingStatus = "all";
        state.findingPage = 1;
        render();
        break;
      case "report-export": {
        const report = reportSnapshots[item().id];
        if (report)
          download("synthetic-report-" + report.id + ".json", {
            synthetic: true,
            id: "report-" + report.id,
            version: 1,
            source: "fixture-revision-01",
            outcome: report.status,
            completeness: report.completeness,
            delivery: report.delivery,
            findings: findingsFor(report),
            validation: report.validation,
            evidence: [{ availability: "not_retained" }],
            plans: ["saved-validation-plan"],
          });
        break;
      }
      case "prepare":
        prepareDialog();
        break;
      case "prepare-submit": {
        if (state.role === "reader") break;
        if (pendingIntent()) {
          unknownActionDialog(pendingIntent());
          break;
        }
        const d = captureActionDraft(),
          op = d.operation,
          body = d.body;
        if (op === "approve" && findingsFor(item()).some((f) => f.priority === "P0")) {
          dialogError(
            "Approve is unavailable while the original PR has a confirmed unresolved P0.",
          );
          break;
        }
        if (["comment", "request-changes", "suggestion"].includes(op) && !body.trim()) {
          dialogError("Enter feedback or select findings before preparation.", "ar-action-body");
          break;
        }
        if (op === "followup" && !/^[a-f0-9]{40,64}$/i.test(d.sha.trim())) {
          dialogError(
            "Choose the exact source commit required by the saved plan.",
            "ar-action-sha",
          );
          break;
        }
        if (op === "ci" && !d.workflow.trim()) {
          dialogError("Enter a workflow file.", "ar-workflow");
          break;
        }
        if (
          op === "suggestion" &&
          (!d.path.trim() ||
            /^(?:[\\/]|[A-Za-z]:)/.test(d.path) ||
            d.path.split(/[\\/]/).includes(".."))
        ) {
          dialogError("Enter a repository-relative file path.", "ar-suggestion-path");
          break;
        }
        if (op === "suggestion" && (!Number.isInteger(Number(d.line)) || Number(d.line) < 1)) {
          dialogError("The suggestion line must be a positive whole number.", "ar-suggestion-line");
          break;
        }
        const key = sourceKey();
        state.preview = {
          id: "intent-fixture-" + item().id + "-" + state.nextIntent++,
          itemId: item().id,
          sourceType: item().type === "issues" ? "Issue" : "PR",
          operation: op,
          status: "prepared",
          payload: {
            operation: op,
            body,
            selectedFindings: [...(state.selected[item().id] || [])],
            ...(op === "merge" ? { method: d.method } : {}),
            ...(op === "ci" ? { workflow: d.workflow } : {}),
            ...(op === "followup" ? { plan: "saved-validation-plan", commit: d.sha.trim() } : {}),
            ...(op === "suggestion" ? { path: d.path.trim(), line: Number(d.line) } : {}),
          },
        };
        state.actionIntents[key] = state.preview;
        dialogDirty = false;
        previewDialog();
        break;
      }
      case "confirm-action": {
        const p = state.preview;
        if (state.role !== "admin" || !p || p.status !== "prepared" || state.scenario === "stale")
          break;
        if (state.scenario === "unknown") {
          p.status = "unknown";
          unknownActionDialog(p);
          render();
        } else if (state.scenario === "conflict") {
          p.status = "conflict";
          openDialog(
            "Action context changed",
            notice(
              "The prepared version is no longer current. Review updated guards before preparing another intent. Your preparation inputs are retained.",
              "warning",
            ),
            button("Refresh action context", "action-refresh", "primary"),
          );
        } else {
          state.dirty = false;
          p.status = "simulated";
          openDialog(
            "Simulation receipt",
            notice(
              "Confirmed in the prototype. No GitHub operation or Worker execution was dispatched.",
              "success",
            ) +
              dt([
                ["Intent", p.id],
                ["Operation", p.operation],
                ["Target", "#" + p.itemId],
                ["Result", "Local simulation recorded"],
              ]),
            button("Done", "dialog-close", "primary"),
          );
        }
        break;
      }
      case "check-intent":
        unknownActionDialog(pendingIntent());
        break;
      case "action-refresh":
        state.scenario = "normal";
        prepareDialog();
        break;
      case "reconcile": {
        const p = pendingIntent();
        if (!p) break;
        p.status = "simulated";
        state.preview = p;
        state.scenario = "normal";
        render();
        openDialog(
          "Existing submission checked",
          notice(
            "The retained synthetic receipt is now resolved. No operation was resent.",
            "success",
          ) +
            dt([
              ["Intent", p.id],
              ["Result", "Recorded simulation receipt"],
              ["New submissions", "0"],
            ]),
          button("Done", "dialog-close", "primary"),
        );
        break;
      }
      case "followup-plan": {
        const d = actionDraft();
        openDialog(
          "Saved follow-up plan",
          `<h3>${item().kind === "Feature" ? "Implement selective Settings export" : item().type === "issues" ? "Verify the reported Settings startup failure" : "Verify cancellation and saved configuration"}</h3><ol><li>Prepare the exact saved source.</li><li>Exercise the documented trigger.</li><li>Record actual checks and evidence.</li><li>Confirm application cleanup.</li></ol>` +
            notice(
              "The plan is saved, but execution still needs source, permissions and Worker capacity.",
            ) +
            field("Chosen full commit SHA", "ar-plan-sha", d.sha, "text"),
          button("Close", "dialog-close") +
            button(
              "Review prerequisites",
              "plan-prerequisites",
              "primary",
              state.role === "reader" ? "disabled" : "",
            ),
        );
        coreForm = { kind: "followup", key: sourceKey(), initial: { ...d } };
        break;
      }
      case "plan-prerequisites": {
        const sha = inputValue("ar-plan-sha").trim();
        if (!/^[a-f0-9]{40,64}$/i.test(sha)) {
          dialogError("Enter the full source commit SHA.", "ar-plan-sha");
          break;
        }
        Object.assign(actionDraft(), { sha, operation: "followup" });
        openDialog(
          "Follow-up prerequisites",
          notice("Source chosen. A saved plan does not by itself authorize execution.") +
            dt([
              ["Saved plan", "Available"],
              ["Exact source", sha],
              [
                "Execution permission",
                state.role === "admin" ? "Granted in sample role" : "Not granted",
              ],
              ["Worker admission", "Needs fresh server check"],
              ["Current guards", "Pending authoritative preparation"],
            ]),
          button("Close", "dialog-close") +
            button(
              "Open preparation",
              "prepare",
              "primary",
              state.role === "reader" ? "disabled" : "",
            ),
        );
        break;
      }
      case "journeys":
        showJourneys();
        break;
      case "search":
        guardNavigation(searchDialog);
        break;
    }
  }
  root.addEventListener("click", (e) => {
    const target = e.target.closest("[data-action]");
    if (target && root.contains(target) && !target.disabled) handle(target.dataset.action, target);
  });
  root.addEventListener("input", (e) => {
    const el = e.target;
    if (el.id === "ar-list-search") {
      currentList().q = el.value;
      currentList().page = 1;
      retainInputRender(el, render);
    } else if (el.id === "ar-finding-search") {
      state.findingQuery = el.value;
      state.findingPage = 1;
      retainInputRender(el, render);
    } else if (el.id === "ar-feedback") {
      if (state.role !== "reader") {
        state.drafts[item().id + ":" + state.finding] = el.value;
        state.dirty = true;
      }
    } else if (el.id === "ar-output-search") {
      state.taskOutputQuery = el.value;
      retainInputRender(el, render);
    } else if (trackCoreInput(el)) {
    } else if (el.id === "ar-global-search") {
      const q = el.value.toLowerCase().trim();
      $("ar-global-results").innerHTML =
        q.length < 2
          ? '<p class="ar-muted">Enter at least two characters.</p>'
          : fixtures
              .filter((x) => (x.title + " " + x.id).toLowerCase().includes(q))
              .map(
                (x) =>
                  `<div class="ar-row" style="margin-bottom:10px">${button("#" + x.id + " · " + esc(x.title), "open:" + x.type + ":" + x.id, "ghost")}${button("Task", "open:tasks:" + x.id, "small")}${reportSnapshots[x.id] ? button("Report", "open:reports:" + x.id, "small") : ""}</div>`,
              )
              .join("") || empty("No matching results", "Try a source number or title.");
    } else ops.change(el);
  });
  root.addEventListener("change", (e) => {
    const el = e.target;
    if (el.id === "ar-role") {
      guardNavigation(() => {
        state.role = el.value;
        state.selected = {};
        state.drafts = {};
        state.dirty = false;
        render();
      });
    } else if (el.id === "ar-scenario") {
      state.scenario = el.value;
      render();
    } else if (el.id === "ar-repo") {
      guardNavigation(() => {
        state.repo = el.value;
        state.id = null;
        syncRoute();
        render();
      });
    } else if (el.id === "ar-source-state") {
      currentList().source = el.value;
      currentList().page = 1;
      render();
    } else if (el.id === "ar-report-completeness") {
      currentList().status = el.value;
      render();
    } else if (el.id === "ar-start-mode") {
      trackCoreInput(el);
      $("ar-start-sha-wrap").hidden = el.value !== "source";
    } else if (el.id === "ar-priority") {
      state.severity = el.value;
      state.findingPage = 1;
      render();
    } else if (el.id === "ar-finding-status") {
      state.findingStatus = el.value;
      state.findingPage = 1;
      render();
    } else if (el.id === "ar-finding-picker") {
      state.finding = Number(el.value);
      state.findingPage = Math.ceil(state.finding / 25);
      render();
    } else if (el.id === "ar-selected-finding") {
      if (state.role === "reader") return;
      const id = item().id;
      state.selected[id] = el.checked
        ? [...new Set([...(state.selected[id] || []), state.finding])]
        : (state.selected[id] || []).filter((f) => f !== state.finding);
      render();
    } else if (el.id === "ar-event-type") {
      state.eventType = el.value;
      render();
    } else if (el.id === "ar-attempt") {
      state.attempt = el.value;
      render();
    } else if (el.id === "ar-operation") {
      captureActionDraft();
      dialogDirty = true;
      operationOptions();
    } else if (trackCoreInput(el)) {
    } else ops.change(el);
  });
  $("ar-dialog").addEventListener("cancel", (e) => {
    if (dialogDirty) {
      e.preventDefault();
      guardNavigation(closeDialog);
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if ($("ar-dialog-title").textContent !== "Leave unsaved changes?" || !$("ar-dialog").open)
        guardNavigation(searchDialog);
    }
  });
  window.addEventListener("popstate", (e) => {
    if (ignoreNextPopstate) {
      ignoreNextPopstate = false;
      return;
    }
    if (!e.state?.ar) return;
    const next = { ...e.state.ar },
      position = Number.isInteger(e.state.arPosition) ? e.state.arPosition : routePosition,
      delta = routePosition - position;
    const apply = () => {
      Object.assign(state, next);
      routePosition = position;
      state.preview = state.id ? state.actionIntents[sourceKey()] || null : null;
      if ($("ar-dialog").open) closeDialog();
      render();
      restoreScroll(!state.id ? currentList().scroll || 0 : 0);
    };
    if (state.dirty || dialogDirty) {
      // Put the browser back on the visible route while the user decides.
      if (delta) {
        ignoreNextPopstate = true;
        history.go(delta);
      } else syncRoute(true);
      guardNavigation(() => {
        if (delta) {
          ignoreNextPopstate = true;
          history.go(-delta);
        }
        apply();
        if (!delta) syncRoute(true);
      });
    } else apply();
  });
  try {
    const p = new URLSearchParams(location.hash.slice(1));
    if (names[p.get("page")]) state.page = p.get("page");
    if (p.get("id")) state.id = p.get("id");
    if (p.get("tab")) state.tab = p.get("tab");
    if (p.get("repo") === "fork") state.repo = "fork";
  } catch {}
  render();
  syncRoute(true);
  if (globalThis.Tweak) {
    const tweak = new Tweak({ container: root, onChange: render });
    tweak.addToggle(design, "compact", { label: "Compact source rows" });
    tweak.addToggle(design, "expanded", { label: "Expanded navigation labels" });
    tweak.addToggle(design, "validation", { label: "Validation column in lists" });
  }
})();
