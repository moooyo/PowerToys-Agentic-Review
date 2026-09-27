/* Independent queued follow-up Tasks. No Worker or repository operation is started. */
function createFollowupTasks(ctx) {
  "use strict";
  const { state, h, source } = ctx;
  const { esc, icon, button, badge, notice, heading, dt, githubLink } = h;
  const taskLabels = {
    "pr-verify": "PR verification",
    "issue-verify": "Issue verification",
    "reproduction-setup": "Reproduction setup",
    "issue-fix": "Issue fix",
    "feature-implement": "Feature implementation",
  };
  state.followupTasks ||= {};

  function find(id) {
    return Object.hasOwn(state.followupTasks, String(id)) ? state.followupTasks[String(id)] : null;
  }
  function list() {
    return Object.values(state.followupTasks).sort((left, right) => right.sequence - left.sequence);
  }
  function forSource(sourceId) {
    return list().filter((task) => task.sourceId === String(sourceId));
  }
  function latestForSource(sourceId) {
    return forSource(sourceId)[0] || null;
  }
  function create(intent) {
    if (!intent || typeof intent.id !== "string" || !intent.id) return null;
    const existing = list().find((task) => task.originIntent === intent.id);
    if (existing) return existing;
    const parent = source(String(intent.itemId || "")),
      payload = intent.payload,
      plan = payload?.planRef;
    if (
      !parent ||
      !["pulls", "issues"].includes(parent.type) ||
      payload?.kind !== "task" ||
      !Object.hasOwn(taskLabels, payload.taskKind) ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(payload.sourceCommit || "") ||
      !plan ||
      typeof plan.id !== "string" ||
      !plan.id ||
      !Number.isInteger(plan.version) ||
      plan.version < 1 ||
      !/^[a-f0-9]{64}$/i.test(plan.digest || "")
    )
      return null;
    if ((payload.taskKind === "pr-verify") !== (parent.type === "pulls")) return null;
    const sourceId = String(parent.id),
      suffix = intent.id.split("-").at(-1),
      id = "followup-" + sourceId + "-" + suffix;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || find(id)) return null;
    if (forSource(sourceId).some((task) => ["Queued", "Running"].includes(task.status)))
      return null;
    const sequence = Math.max(0, ...list().map((task) => task.sequence)) + 1;
    const task = {
      id,
      sourceId,
      number: parent.number,
      repositoryFullName: parent.repositoryFullName,
      kind: parent.kind,
      type: parent.type,
      synthetic: parent.synthetic !== false,
      taskKind: payload.taskKind,
      title: taskLabels[payload.taskKind] + ": " + parent.title,
      sourceTitle: parent.title,
      status: "Queued",
      validation: "No accepted result yet",
      conclusion: "No saved report",
      latestReportRef: null,
      workerId: null,
      attempts: [],
      sourceCommit: payload.sourceCommit,
      expectedCommit: payload.sourceCommit,
      planRef: { id: plan.id, version: plan.version, digest: plan.digest },
      parentReportId: intent.reportRef?.id || "report-" + sourceId,
      parentTaskId: "task-" + sourceId,
      originIntent: intent.id,
      createdAt: new Date().toISOString(),
      sequence,
    };
    state.followupTasks[id] = task;
    return task;
  }
  function row(task) {
    const subject = (task.type === "issues" ? "Issue" : "PR") + " #" + task.number;
    return `<button type="button" id="ar-source-tasks-${esc(task.id)}" class="ar-source-row" data-action="open:tasks:${esc(task.id)}" aria-label="Open ${esc(taskLabels[task.taskKind] || "follow-up")} task for ${esc(subject)}"><span class="ar-source-main"><strong class="ar-source-title">${esc(task.title)}</strong><span class="ar-source-meta">${esc(subject)} · ${esc(task.repositoryFullName)} · ${esc(task.id)}</span></span><span class="ar-state">${badge(task.status, "info")}<span class="ar-small ar-muted">No saved report</span></span><span class="ar-validation ar-state" role="group" aria-label="Validation: No accepted result yet">${badge("No accepted result yet", "neutral")}</span><span class="ar-chevron">${icon("chevron-right")}</span></button>`;
  }
  function detail(task) {
    const subject = (task.type === "issues" ? "Issue" : "PR") + " #" + task.number;
    const links =
      button("Open " + subject, "open:" + task.type + ":" + task.sourceId, "ghost small") +
      button("Open parent report", "open:reports:" + task.sourceId, "ghost small");
    const frozen = dt([
      ["Task", esc(task.id)],
      ["Task kind", esc(taskLabels[task.taskKind] || task.taskKind)],
      ["Source", esc(subject + " · " + task.repositoryFullName)],
      ["Exact source commit", `<code>${esc(task.sourceCommit)}</code>`],
      ["Saved plan", esc(task.planRef.id + " · v" + task.planRef.version)],
      ["Plan digest", `<code>${esc(task.planRef.digest)}</code>`],
      ["Parent report", esc(task.parentReportId)],
      ["Parent task", esc(task.parentTaskId)],
      ["Origin intent", esc(task.originIntent)],
      ["Created", esc(task.createdAt)],
    ]);
    return (
      `<div class="ar-back">${button(icon("arrow-left") + " Back to tasks", "page:tasks", "ghost small")}</div><div class="ar-kicker">Linked follow-up · ${esc(subject)}</div>` +
      heading(task.title, esc(task.id + " · " + task.repositoryFullName), githubLink(task)) +
      `<div class="ar-stack"><section class="ar-task-progress ar-panel"><div class="ar-row"><h2>Waiting for Worker</h2>${badge(task.status, "info")}</div><p class="ar-small ar-muted">Offline sample · This task stays queued.</p>${dt(
        [
          ["Worker", "Not assigned"],
          ["Attempts", "0"],
          ["Validation", "Not started"],
        ],
      )}<div class="ar-row">${links}</div></section><details class="ar-panel"><summary>Source & saved plan</summary>${frozen}</details></div>`
    );
  }
  return { create, find, list, forSource, latestForSource, row, detail };
}
