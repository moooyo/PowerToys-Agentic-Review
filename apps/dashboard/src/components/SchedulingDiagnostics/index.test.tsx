import type { SchedulingDiagnostics as DiagnosticValue } from "@agentic-review/contracts";
import { QueryClient } from "@tanstack/react-query";
import type { DependencyList } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewControlHttpError } from "@/services/review-control/errors";
import {
  observation,
  platformObservation,
  platformScope,
  repositoryScope,
} from "../../services/scheduling/fixtures.testing";
import { SchedulingDiagnostics, SchedulingObservation } from "./index";
import { schedulingPollingInterval } from "./state";

interface QueryOptions {
  queryKey: readonly string[];
  queryFn: (context: { signal: AbortSignal }) => Promise<DiagnosticValue>;
  enabled: boolean;
  gcTime: number;
  retry: boolean;
  refetchIntervalInBackground: boolean;
  refetchInterval: (query: { state: { status: string; data?: DiagnosticValue } }) => number | false;
}
const state = vi.hoisted(() => ({
  mode: "connected",
  canRead: true,
  administrator: false,
  checking: false,
  epoch: 1,
  principal: { issuer: "https://identity.example", subject: "operator-one" },
  queries: [] as QueryOptions[],
  effects: [] as (() => undefined | (() => void))[],
  scopes: [] as (string | undefined)[],
  data: undefined as DiagnosticValue | undefined,
  error: null as Error | null,
  get: vi.fn(),
  client: null as QueryClient | null,
}));
vi.mock("@/state/session", () => ({
  useOperatorSession: () => ({ initialState: { authenticationEpoch: state.epoch } }),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => undefined | (() => void), dependencies?: DependencyList) => {
    if (state.client && dependencies?.includes(state.client)) state.effects.push(effect);
  },
}));
vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: (repositoryId?: string) => {
    state.scopes.push(repositoryId);
    return {
      pending: false,
      checking: state.checking,
      ready: true,
      error: null,
      principal: state.principal,
      identityKey: ["connected", state.principal.issuer, state.principal.subject],
      platformAdministrator: state.administrator,
      context: {
        platformAdministrator: state.administrator,
        repository: { repositoryId, permissions: state.canRead ? ["read"] : [] },
      },
      can: () => state.canRead,
      refresh: vi.fn(async () => undefined),
    };
  },
}));
vi.mock("@/services/scheduling", async (original) => ({
  ...(await original<typeof import("../../services/scheduling")>()),
  scheduling: {
    get mode() {
      return state.mode;
    },
    get: state.get,
  },
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => state.client,
  useQuery: (options: QueryOptions) => {
    state.queries.push(options);
    return {
      data: state.data,
      error: state.error,
      isError: state.error !== null,
      isSuccess: state.data !== undefined,
      isPending: state.data === undefined && state.error === null,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
}));
const render = (visible = true) =>
  renderToStaticMarkup(<SchedulingDiagnostics scope={repositoryScope} visible={visible} />);
const query = () => {
  const value = state.queries.at(-1);
  if (!value) throw new Error("No scheduling query was created.");
  return value;
};
beforeEach(() => {
  state.mode = "connected";
  state.canRead = true;
  state.administrator = false;
  state.checking = false;
  state.epoch = 1;
  state.principal = { issuer: "https://identity.example", subject: "operator-one" };
  state.queries = [];
  state.effects = [];
  state.scopes = [];
  state.data = structuredClone(observation);
  state.error = null;
  state.get.mockReset();
  state.get.mockResolvedValue(observation);
  state.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  state.client?.clear();
  vi.unstubAllGlobals();
});

describe("scoped scheduling access and cancellation", () => {
  it("renders a current observation separately from frozen plan readiness", () => {
    const html = render();
    expect(html).toContain("Current scheduling");
    expect(html).toContain("Queued");
    expect(html).toContain("frozen plan readiness");
    expect(html).toContain("Observed");
    expect(html).toContain(observation.observedAt);
    expect(html).toContain("Repository admitted queue");
    expect(html).toContain("Repository awaiting valid configuration");
    expect(html).toContain("Global usage details are restricted");
    expect(html).not.toContain("Platform active executions");
    expect(state.scopes).toEqual(["repository:one"]);
    expect(query()).toMatchObject({ retry: false, gcTime: 0, refetchIntervalInBackground: false });
  });
  it.each(["denied", "checking", "hidden", "sample"])(
    "clears live content while %s",
    (condition) => {
      state.canRead = condition !== "denied";
      state.checking = condition === "checking";
      state.mode = condition === "sample" ? "sample" : "connected";
      const html = render(condition !== "hidden");
      expect(html).not.toContain("concurrent execution limit");
      expect(state.queries).toHaveLength(0);
      if (condition === "sample")
        expect(html).toContain("does not contain real scheduling observations");
    },
  );
  it("requires platform administrator access even for an associated platform job response", () => {
    expect(renderToStaticMarkup(<SchedulingDiagnostics scope={platformScope} />)).toContain(
      "Platform administrator access",
    );
    expect(state.queries).toHaveLength(0);
    state.administrator = true;
    state.data = {
      ...observation,
      policy: { ...observation.policy, platform: platformObservation.policy.platform },
    };
    expect(renderToStaticMarkup(<SchedulingDiagnostics scope={platformScope} />)).toContain(
      "Queued",
    );
    expect(state.scopes).toEqual([undefined, undefined]);
  });
  it("separates repository, principal and authentication-epoch cache identities", () => {
    render();
    const first = query().queryKey;
    state.epoch = 2;
    render();
    expect(query().queryKey).not.toEqual(first);
    state.epoch = 1;
    state.principal = { ...state.principal, subject: "operator-two" };
    render();
    expect(query().queryKey).not.toEqual(first);
    renderToStaticMarkup(
      <SchedulingDiagnostics scope={{ ...repositoryScope, repositoryId: "repository:two" }} />,
    );
    expect(query().queryKey).not.toEqual(first);
  });
  it("passes the query signal into transport and rejects a late cancelled response", async () => {
    render();
    let finish!: (value: DiagnosticValue) => void;
    state.get.mockImplementation(
      () =>
        new Promise<DiagnosticValue>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = query().queryFn({ signal: controller.signal });
    expect(state.get).toHaveBeenCalledWith(repositoryScope, controller.signal);
    controller.abort();
    finish(observation);
    await expect(pending).rejects.toBe(controller.signal.reason);
  });
  it("cancels the actual cached query and removes only its exact scope on unmount", async () => {
    render();
    const options = query();
    const client = state.client;
    if (!client) throw new Error("The test requires its scoped query client.");
    let signal: AbortSignal | undefined;
    state.get.mockImplementation((_scope, received: AbortSignal) => {
      signal = received;
      return new Promise(() => undefined);
    });
    const pending = client.fetchQuery({
      queryKey: options.queryKey,
      queryFn: options.queryFn,
    });
    const observed = pending.catch((error: unknown) => error);
    const foreign = ["scheduling-diagnostics", "repository_job", "another-repository"];
    client.setQueryData(foreign, { retained: true });
    const cleanups = state.effects
      .map((effect) => effect())
      .filter((cleanup): cleanup is () => void => typeof cleanup === "function");
    for (const cleanup of cleanups) cleanup();
    await observed;
    expect(signal?.aborted).toBe(true);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    expect(client.getQueryData(foreign)).toEqual({ retained: true });
  });
  it.each([401, 403, 404])("hides cached observation immediately on access HTTP %s", (status) => {
    state.error = new ReviewControlHttpError("Private diagnostic error text", {
      status,
      operation: "read scheduling",
      retryable: false,
    });
    const html = render();
    expect(html).toContain("Scheduling access is unavailable");
    expect(html).not.toContain("concurrent execution limit");
    expect(html).not.toContain("Private diagnostic");
  });
  it("does not retain stale data on ordinary transport failure", () => {
    state.error = new Error("worker:private details");
    const html = render();
    expect(html).toContain("No previous observation is shown");
    expect(html).not.toContain("concurrent execution limit");
    expect(html).not.toContain("worker:private");
  });
  it("rejects a changed subject even when a mocked transport returns it", async () => {
    render();
    state.get.mockResolvedValue({
      ...observation,
      subject: { ...observation.subject, workItemId: "another-item" },
    });
    await expect(query().queryFn({ signal: new AbortController().signal })).rejects.toThrow(
      "another scope",
    );
  });
  it("hides full global usage from repository-only sessions", async () => {
    state.data = {
      ...observation,
      policy: { ...observation.policy, platform: platformObservation.policy.platform },
    };
    expect(render()).toContain("No previous observation is shown");
    expect(render()).not.toContain("Platform active executions");
    state.get.mockResolvedValue(state.data);
    await expect(query().queryFn({ signal: new AbortController().signal })).rejects.toThrow(
      "another scope",
    );
  });
  it("rejects stale policy identity and missing policy without showing previous content", async () => {
    for (const policy of [
      undefined,
      {
        ...observation.policy,
        repository: { ...observation.policy.repository, repositoryId: "foreign" },
      },
    ]) {
      state.data = { ...observation, policy } as DiagnosticValue;
      const html = render();
      expect(html).toContain("No previous observation is shown");
      expect(html).not.toContain("Repository admitted queue");
      state.get.mockResolvedValue(state.data);
      await expect(query().queryFn({ signal: new AbortController().signal })).rejects.toThrow(
        "another scope",
      );
    }
  });
  it("stops querying when the browser document is hidden", () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    expect(render()).toBe("");
    expect(state.queries).toHaveLength(0);
  });
});

describe("honest scheduling presentation", () => {
  it("shows queue admission rules, current limits, and retained overage", () => {
    const value = structuredClone(observation);
    if (!value.job?.admission || !value.policy.repository)
      throw new Error("A repository job is required.");
    value.job.admission = { ...value.job.admission, state: "pending", admittedAt: null };
    value.policy.repository.limits = { maxActiveLeases: 2, maxQueuedJobs: 3 };
    value.policy.repository.usage = {
      activeLeases: 3,
      admittedQueuedJobs: 4,
      awaitingAdmissionJobs: 5,
      awaitingConfigurationRequests: 6,
    };
    value.policy.repository.overage = { activeLeases: 1, admittedQueuedJobs: 1 };
    value.reasons = [
      { code: "awaiting_admission", effect: "claim_gate" },
      { code: "repository_queue_limit", effect: "admission_gate" },
      { code: "repository_active_limit", effect: "claim_gate" },
    ];
    const html = renderToStaticMarkup(<SchedulingObservation value={value} />);
    expect(html).toContain("Queue admission rule");
    expect(html).toContain("admitted queue has reached its configured limit");
    expect(html).toContain("1 active; 1 admitted. Existing work is retained.");
    expect(html).toContain("Repository awaiting admission");
    expect(html).toContain("does not establish worker availability");
  });
  it("distinguishes a saved pending job from a request with no job", () => {
    const value = structuredClone(observation);
    if (!value.job?.admission) throw new Error("The fixture must include a waiting job.");
    value.job.admission = { ...value.job.admission, state: "pending", admittedAt: null };
    value.reasons = [{ code: "awaiting_admission", effect: "claim_gate" }];
    const pending = renderToStaticMarkup(<SchedulingObservation value={value} />);
    expect(pending).toContain("Awaiting admission");
    expect(pending).toContain("recorded and is waiting to enter the execution queue");
    expect(pending).not.toContain("Waiting for an execution to be created");
    const missing = renderToStaticMarkup(
      <SchedulingObservation value={{ ...value, job: null, reasons: [] }} />,
    );
    expect(missing).toContain("Waiting for an execution to be created");
    expect(missing).not.toContain("Awaiting admission");
  });
  it("shows incomplete inspection without claiming worker absence", () => {
    const value: DiagnosticValue = {
      ...observation,
      workerInspection: { state: "partial", latestContactAt: null },
      reasons: [{ code: "inspection_incomplete", effect: "observation" }],
    };
    const html = renderToStaticMarkup(<SchedulingObservation value={value} />);
    expect(html).toContain("Partial");
    expect(html).toContain("has not been ruled out");
    expect(html).not.toContain("No compatible worker");
  });
  it("does not label contact time as the timestamp of a capacity report", () => {
    const value: DiagnosticValue = {
      ...observation,
      reasons: [{ code: "worker_capacity_unavailable", effect: "observation" }],
    };
    const html = renderToStaticMarkup(<SchedulingObservation value={value} />);
    expect(html).toContain("reporting time is unknown");
    expect(html).toContain("Contact time does not establish");
    expect(html).not.toContain("heartbeat");
  });
  it("retains source prerequisites as distinct from enforced claim gates", () => {
    const value: DiagnosticValue = {
      ...observation,
      reasons: [{ code: "authorization_changed", effect: "current_prerequisite" }],
    };
    const html = renderToStaticMarkup(<SchedulingObservation value={value} />);
    expect(html).toContain("Current request requirement");
    expect(html).toContain("do not necessarily prevent an already queued execution");
  });
  it("shows retry eligibility without an estimated start", () => {
    const value: DiagnosticValue = {
      ...observation,
      reasons: [{ code: "retry_backoff", effect: "claim_gate", until: "2026-09-07T09:00:00.000Z" }],
    };
    expect(renderToStaticMarkup(<SchedulingObservation value={value} />)).toContain(
      "not an estimated start",
    );
  });
  it("does not infer reserved capacity from an empty reason list", () => {
    expect(
      renderToStaticMarkup(<SchedulingObservation value={{ ...observation, reasons: [] }} />),
    ).toContain("does not reserve capacity");
  });
  it.each([
    [{ visible: true, connected: true, error: false, stage: "waiting" as const }, 5000],
    [{ visible: true, connected: true, error: false, stage: "executing" as const }, 5000],
    [{ visible: true, connected: true, error: false, stage: "terminal" as const }, false],
    [{ visible: false, connected: true, error: false }, false],
    [{ visible: true, connected: false, error: false }, false],
    [{ visible: true, connected: true, error: true }, false],
  ] as const)("polls only visible available live observations", (input, expected) => {
    expect(schedulingPollingInterval(input)).toBe(expected);
  });
});
