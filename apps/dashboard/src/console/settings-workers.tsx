import {
  type InvestigationTaskV1,
  type InvestigationWorkerControl,
  isInvestigationStaticTaskKind,
} from "@agentic-review/contracts";
import { Dialog, DialogActions, DialogContent, DialogTitle } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { investigationApi } from "../investigation/api";
import { useUnsavedChanges } from "../investigation/navigation-guard";
import { schedulerQueryKey } from "../investigation/scheduler-panel";
import { useInvestigationSession } from "../investigation/session";
import { InvestigationHttpError } from "../investigation/transport";
import { workerAdmissionInput, workersQueryKey } from "../investigation/workers-page";
import { formatDuration, stageLabel } from "./model";
import { ConsoleIcon, useConsolePreferences } from "./preferences";
import "./settings-workers.css";

type Text = (zh: string, en: string) => string;
type ActivityStatus = NonNullable<InvestigationWorkerControl["activityStatus"]> | "unconfirmed";
type WorkerAdmissionState = {
  isAdmin: boolean;
  locked: boolean;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
};

export function workerAdmissionUpdateAllowed(
  worker: InvestigationWorkerControl | undefined,
  enabled: boolean,
  state: WorkerAdmissionState,
  reviewedVersion?: number,
): boolean {
  if (
    worker === undefined ||
    !state.isAdmin ||
    state.locked ||
    state.isPending ||
    state.isError ||
    state.isFetching ||
    (reviewedVersion !== undefined && reviewedVersion !== worker.version)
  )
    return false;
  if (enabled === worker.e2eEnabled) return false;
  return (
    !enabled ||
    (worker.cleanupPendingAttemptIds.length === 0 &&
      worker.status !== "awaiting_confirmation" &&
      worker.status !== "disabling")
  );
}

export function workerDisplayName(worker: InvestigationWorkerControl): string {
  return worker.displayName ?? worker.id;
}

export function workerActivityLabel(
  status: ActivityStatus,
  text: Text,
  contactStatus?: InvestigationWorkerControl["contactStatus"],
): string {
  switch (status) {
    case "online":
      return text("在线", "Online");
    case "busy":
      return contactStatus === "stale"
        ? text("仍占用 · 联系超时", "Ownership retained · Contact expired")
        : contactStatus === "never"
          ? text("仍占用 · 尚未联系", "Ownership retained · Never contacted")
          : text("忙碌", "Busy");
    case "cleaning":
      return contactStatus === "stale"
        ? text("待清理 · 联系超时", "Cleanup pending · Contact expired")
        : contactStatus === "never"
          ? text("待清理 · 尚未联系", "Cleanup pending · Never contacted")
          : text("待清理", "Cleanup pending");
    case "offline":
      return text("离线", "Offline");
    case "unconfirmed":
      return text("状态待确认", "Status unconfirmed");
  }
}

export function workerPrimaryTaskId(worker: InvestigationWorkerControl): string | undefined {
  const taskId = worker.activeTaskIds?.[0] ?? worker.activeE2eTaskIds[0];
  return worker.cleanupPendingAttemptIds.length > 0 && worker.activeE2eTaskIds.length === 1
    ? (worker.activeE2eTaskIds[0] ?? taskId)
    : taskId;
}

function relativeTime(value: string | null, text: Text): string {
  if (!value || !Number.isFinite(Date.parse(value))) return text("尚未联系", "Never contacted");
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (!minutes) return text("刚刚", "Just now");
  if (minutes < 60) return text(`${minutes} 分钟前`, `${minutes} min ago`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return text(`${hours} 小时前`, `${hours} hr ago`);
  return text(`${Math.floor(hours / 24)} 天前`, `${Math.floor(hours / 24)} days ago`);
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div
      className={`console-settings-notice${error ? " error" : ""}`}
      role={error ? "alert" : "status"}
    >
      <ConsoleIcon name={error ? "error" : "info"} size={18} />
      <span>{children}</span>
    </div>
  );
}

function WorkerTaskSummary({
  taskId,
  task,
  cleanup,
  contactStale,
}: {
  taskId: string;
  task?: InvestigationTaskV1;
  cleanup: boolean;
  contactStale: boolean;
}) {
  const { text } = useConsolePreferences();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const detail = useQuery({
    queryKey: ["console", "worker-task", taskId],
    queryFn: ({ signal }) => investigationApi.task(taskId, signal),
    enabled: !!task,
    refetchInterval: 5_000,
  });
  const attempt = detail.data?.attempts
    .filter((entry) => entry.taskId === taskId)
    .sort((left, right) => right.number - left.number)[0];
  const observedUntil = task?.state === "running" ? now : task ? Date.parse(task.updatedAt) : now;
  return (
    <div className="console-settings-worker-task">
      <ConsoleIcon name={cleanup ? "hourglass_empty" : "autorenew"} size={18} />
      <span>{task ? `#${task.workItem.number} ${task.workItem.title}` : taskId}</span>
      <span>
        {cleanup
          ? text("等待清理确认", "Awaiting cleanup")
          : !task
            ? text("任务所有权仍保留", "Task ownership retained")
            : detail.isError
              ? text("阶段信息读取失败", "Stage unavailable")
              : `${contactStale ? `${text("最近记录阶段", "Last reported stage")}: ` : ""}${stageLabel(detail.data?.progress?.stage ?? undefined, text)}${attempt?.startedAt ? ` · ${formatDuration(observedUntil - Date.parse(attempt.startedAt))}` : ""}`}
      </span>
    </div>
  );
}

export function ConsoleWorkerControlCard({
  worker,
  task,
  busy,
  locked,
  stateUnconfirmed = false,
  onEnable,
  onDisable,
}: {
  worker: InvestigationWorkerControl;
  task?: InvestigationTaskV1;
  busy: boolean;
  locked: boolean;
  stateUnconfirmed?: boolean;
  onEnable: () => void;
  onDisable: () => void;
}) {
  const { text } = useConsolePreferences();
  const name = workerDisplayName(worker);
  const recordedStatus = worker.activityStatus ?? "unconfirmed";
  const status =
    stateUnconfirmed && recordedStatus !== "busy" && recordedStatus !== "cleaning"
      ? "unconfirmed"
      : recordedStatus;
  const statusLabel = stateUnconfirmed
    ? status === "busy"
      ? text("已记录占用 · 状态读取失败", "Recorded ownership · State unavailable")
      : status === "cleaning"
        ? text("已记录待清理 · 状态读取失败", "Recorded cleanup pending · State unavailable")
        : workerActivityLabel("unconfirmed", text)
    : workerActivityLabel(status, text, worker.contactStatus);
  const taskIds = worker.activeTaskIds ?? worker.activeE2eTaskIds;
  const taskId = workerPrimaryTaskId(worker);
  const cleanupCount = worker.cleanupPendingAttemptIds.length;
  const cleanup = cleanupCount > 0;
  const cleanupTaskKnown = cleanup && worker.activeE2eTaskIds.length === 1;
  const awaiting = worker.status === "awaiting_confirmation" || worker.status === "disabling";
  const hasStatic = worker.effectiveKinds.some(isInvestigationStaticTaskKind);
  const hasExecution = worker.effectiveKinds.some((kind) => !isInvestigationStaticTaskKind(kind));
  return (
    <article className="console-settings-worker" aria-busy={busy}>
      <div className="console-settings-worker-top">
        <span className="console-settings-leading-icon">
          <ConsoleIcon name="computer" size={24} />
        </span>
        <div className="console-settings-grow">
          <div className="console-settings-worker-name">
            <strong>{name}</strong>
            <span
              className={`console-settings-worker-state ${status}`}
              role="status"
              aria-label={`${name}: ${statusLabel}`}
            >
              <span className="console-settings-dot" />
              {statusLabel}
            </span>
          </div>
          {name !== worker.id && <code className="console-settings-worker-id">{worker.id}</code>}
          <div className="console-settings-row-description">
            {text("最近联系", "Last contact")}: {relativeTime(worker.lastSeenAt, text)} ·{" "}
            {hasStatic && hasExecution
              ? text("静态 Review + E2E", "Static Review + E2E")
              : hasExecution
                ? "E2E"
                : hasStatic
                  ? text("静态 Review", "Static Review")
                  : text("执行能力未确认", "Capabilities unconfirmed")}
          </div>
        </div>
        <div className="console-settings-worker-switch">
          <span>{busy ? text("正在保存…", "Saving…") : text("允许 E2E", "Allow E2E")}</span>
          <button
            type="button"
            className={`console-settings-switch${worker.e2eEnabled ? " on" : ""}`}
            role="switch"
            aria-checked={worker.e2eEnabled}
            aria-label={text(`允许 ${name} 运行 E2E`, `Allow ${name} to run E2E`)}
            disabled={
              !workerAdmissionUpdateAllowed(worker, !worker.e2eEnabled, {
                isAdmin: true,
                locked,
                isPending: false,
                isError: stateUnconfirmed,
                isFetching: false,
              })
            }
            onClick={worker.e2eEnabled ? onDisable : onEnable}
          >
            <span>{worker.e2eEnabled && <ConsoleIcon name="check" size={16} />}</span>
          </button>
        </div>
      </div>
      {taskId && (
        <WorkerTaskSummary
          taskId={taskId}
          task={task}
          cleanup={cleanupTaskKnown}
          contactStale={
            stateUnconfirmed || worker.contactStatus === "stale" || worker.contactStatus === "never"
          }
        />
      )}
      {cleanup && !cleanupTaskKnown && (
        <div className="console-settings-worker-task">
          <ConsoleIcon name="hourglass_empty" size={18} />
          <span>
            {text(
              `${cleanupCount} 次执行等待 Worker 清理确认`,
              cleanupCount === 1
                ? "1 attempt awaits worker cleanup confirmation"
                : `${cleanupCount} attempts await worker cleanup confirmation`,
            )}
          </span>
        </div>
      )}
      {taskIds.length > 1 && (
        <div className="console-settings-worker-ownership">
          {text(`共占用 ${taskIds.length} 个任务`, `${taskIds.length} tasks remain owned`)}
        </div>
      )}
      {status === "offline" && (
        <div className="console-settings-worker-offline">
          {worker.lastSeenAt
            ? text(
                "服务端尚未收到新的认证联系。",
                "The service has not received recent authenticated contact.",
              )
            : text(
                "尚未收到 Worker 的认证联系。",
                "The service has never received authenticated contact from this worker.",
              )}
        </div>
      )}
      {awaiting && (
        <div className="console-settings-worker-pending">
          {text(
            "已保存准入设置，等待 Worker 确认；执行和清理所有权仍保留。",
            "Admission policy is saved and awaiting worker confirmation. Execution and cleanup ownership remain held.",
          )}
        </div>
      )}
    </article>
  );
}

export default function WorkerSettings({ onToast }: { onToast: (message: string) => void }) {
  const { text } = useConsolePreferences();
  const { session } = useInvestigationSession();
  const client = useQueryClient();
  const mounted = useRef(true);
  const lock = useRef(false);
  const [busyId, setBusyId] = useState<string>();
  const [disableWorker, setDisableWorker] = useState<InvestigationWorkerControl>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const query = useQuery({
    queryKey: workersQueryKey,
    queryFn: investigationApi.workers,
    enabled: session.user?.isAdmin === true,
    refetchInterval: busyId ? false : 10_000,
  });
  const tasks = useQuery({
    queryKey: ["console", "tasks"],
    queryFn: ({ signal }) => investigationApi.tasks(undefined, signal),
    enabled: session.user?.isAdmin === true,
    refetchInterval: 5_000,
  });
  useUnsavedChanges(false, { busy: !!busyId });
  const admissionState: WorkerAdmissionState = {
    isAdmin: session.user?.isAdmin === true,
    locked: !!busyId,
    isPending: query.isPending,
    isError: query.isError,
    isFetching: query.isFetching,
  };
  const currentDisableWorker = query.data?.items.find((worker) => worker.id === disableWorker?.id);
  const update = async (
    worker: InvestigationWorkerControl,
    enabled: boolean,
    confirmed = false,
  ) => {
    const currentQuery =
      client.getQueryState<Awaited<ReturnType<typeof investigationApi.workers>>>(workersQueryKey);
    const currentWorker = currentQuery?.data?.items.find((item) => item.id === worker.id);
    if (
      !workerAdmissionUpdateAllowed(
        currentWorker,
        enabled,
        {
          ...admissionState,
          locked: lock.current,
          isPending: query.isPending || currentQuery?.status !== "success",
          isError: query.isError || currentQuery?.status === "error",
          isFetching: query.isFetching || currentQuery?.fetchStatus !== "idle",
        },
        worker.version,
      ) ||
      currentWorker === undefined
    )
      return;
    lock.current = true;
    setBusyId(worker.id);
    setError(undefined);
    setDisableWorker(undefined);
    try {
      const input = workerAdmissionInput(currentWorker, enabled, worker.version, confirmed);
      await client.cancelQueries({ queryKey: workersQueryKey });
      const updated = await investigationApi.updateWorkerE2e(worker.id, input);
      await client.cancelQueries({ queryKey: workersQueryKey });
      if (!mounted.current) return;
      client.setQueryData<Awaited<ReturnType<typeof investigationApi.workers>>>(
        workersQueryKey,
        (current) => ({
          items: (current?.items ?? []).map((item) => (item.id === updated.id ? updated : item)),
        }),
      );
      void client.invalidateQueries({ queryKey: workersQueryKey });
      void client.invalidateQueries({ queryKey: schedulerQueryKey });
      const name = workerDisplayName(updated);
      onToast(
        updated.status === "awaiting_confirmation" || updated.status === "disabling"
          ? text(
              `已保存 ${name} 的准入设置，等待 Worker 确认`,
              `${name} admission settings saved; awaiting worker confirmation`,
            )
          : enabled
            ? text(`已允许 ${name} 接收 E2E`, `${name} may admit E2E work`)
            : text(`${name} 已关闭 E2E 准入`, `${name} E2E admission disabled`),
      );
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof InvestigationHttpError && cause.status === 409) void query.refetch();
      setError(
        cause instanceof Error
          ? cause.message
          : text("Worker 设置更新失败。", "Worker settings could not be updated."),
      );
    } finally {
      lock.current = false;
      if (mounted.current) setBusyId(undefined);
    }
  };
  if (!session.user?.isAdmin)
    return (
      <Notice>
        {text(
          "需要管理员权限才能查看和管理 Workers。",
          "Administrator access is required to view and manage Workers.",
        )}
      </Notice>
    );
  return (
    <div className="console-settings-workers">
      <div className="console-settings-worker-status-note">
        {text(
          "在线表示最近与服务联系；忙碌与待清理表示服务端仍保留任务所有权。",
          "Online means recent service contact. Busy and cleanup pending mean the service retains task ownership.",
        )}
      </div>
      {query.isPending && (
        <div className="console-settings-loading" role="status">
          <span className="console-settings-spinner" />
          {text("正在加载 Workers…", "Loading Workers…")}
        </div>
      )}
      {query.isError && (
        <Notice error>
          {query.error.message}{" "}
          <button
            type="button"
            className="console-settings-button"
            onClick={() => void query.refetch()}
          >
            {text("重试", "Retry")}
          </button>
        </Notice>
      )}
      {query.data?.items.length === 0 && (
        <div className="console-settings-empty">
          {text("尚未注册 Worker", "No workers registered")}
        </div>
      )}
      {query.data?.items.map((worker) => {
        const taskId = workerPrimaryTaskId(worker);
        return (
          <ConsoleWorkerControlCard
            key={worker.id}
            worker={worker}
            task={tasks.data?.items.find((item) => item.id === taskId)}
            busy={busyId === worker.id}
            locked={!!busyId || query.isPending || query.isFetching}
            stateUnconfirmed={query.isError}
            onEnable={() => void update(worker, true)}
            onDisable={() => {
              if (workerAdmissionUpdateAllowed(worker, false, admissionState))
                setDisableWorker(worker);
            }}
          />
        );
      })}
      {error && <Notice error>{error}</Notice>}
      <Dialog
        open={!!disableWorker}
        onClose={() => setDisableWorker(undefined)}
        className="console-settings-dialog"
        maxWidth="xs"
        fullWidth
        aria-labelledby="console-worker-disable-title"
      >
        <DialogTitle id="console-worker-disable-title">
          {text("关闭 E2E 并请求停止当前执行？", "Disable E2E and request execution to stop?")}
        </DialogTitle>
        <DialogContent>
          <p>
            {text(
              `${disableWorker ? workerDisplayName(disableWorker) : ""} 的 E2E 准入将关闭；服务会请求停止尚在执行的 E2E 任务。已结束执行的结果仍需发布，桌面和进程的清理所有权会保留至确认。`,
              `E2E admission for ${disableWorker ? workerDisplayName(disableWorker) : ""} will be disabled, and the service requests active E2E execution to stop. Completed execution results still require delivery. Desktop and process cleanup ownership remains held until confirmed.`,
            )}
          </p>
          {(query.isError || query.isPending || query.isFetching) && (
            <Notice error={query.isError}>
              {text(
                "Worker 状态尚未确认，请等待成功刷新后再关闭准入。",
                "Worker state is unconfirmed. Wait for a successful refresh before disabling admission.",
              )}
            </Notice>
          )}
          {disableWorker && currentDisableWorker?.version !== disableWorker.version && (
            <Notice>
              {text(
                "Worker 设置已变化，请关闭此确认框并重新查看设置。",
                "Worker settings changed. Close this confirmation and review the current settings.",
              )}
            </Notice>
          )}
        </DialogContent>
        <DialogActions>
          <button
            type="button"
            className="console-settings-button"
            onClick={() => setDisableWorker(undefined)}
          >
            {text("取消", "Cancel")}
          </button>
          <button
            type="button"
            className="console-settings-button filled"
            disabled={
              !disableWorker ||
              !workerAdmissionUpdateAllowed(
                currentDisableWorker,
                false,
                admissionState,
                disableWorker.version,
              )
            }
            onClick={() => disableWorker && void update(disableWorker, false, true)}
          >
            {text("关闭准入", "Disable admission")}
          </button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
