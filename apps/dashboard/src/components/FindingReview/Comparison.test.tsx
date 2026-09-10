import type { FindingComparisonResponse } from "@agentic-review/contracts";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewControlHttpError } from "../../services/review-control/errors";
import { sampleReviewRuns } from "../../services/runs/fixtures";
import { FindingComparison } from "./Comparison";
import { context, principal, result } from "./fixtures.testing";
import { findingQueryKey } from "./state";

interface Query {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  enabled?: boolean;
  retry?: boolean;
}
interface SelectionFieldProps {
  label: string;
  value?: string;
  children?: ReactNode;
  onChange: (event: { target: { value: string } }) => void;
}
interface SelectionRecord {
  value?: string | undefined;
  choices: { label: string; value: string; disabled?: boolean | undefined }[];
  onChange: SelectionFieldProps["onChange"];
}
const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  queries: [] as Query[],
  cache: new Map<string, { data?: unknown; error?: unknown; fetching?: boolean }>(),
  selects: new Map<string, SelectionRecord>(),
  buttons: new Map<string, { disabled?: boolean; onClick?: () => void }>(),
  list: vi.fn(),
  get: vi.fn(),
  listJobs: vi.fn(),
  compare: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const cursor = state.cursor++;
      if (!(cursor in state.values)) state.values[cursor] = initial;
      return [
        state.values[cursor],
        (next: unknown) => {
          state.values[cursor] = next;
        },
      ];
    },
  };
});
vi.mock("@/services/findings", () => ({ findings: { mode: "connected", compare: state.compare } }));
vi.mock("@/services/runs", () => ({
  runs: { list: state.list, get: state.get, listJobs: state.listJobs },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (query: Query) => {
    state.queries.push(query);
    const value = state.cache.get(JSON.stringify(query.queryKey));
    return {
      data: value?.data,
      error: value?.error,
      isError: Boolean(value?.error),
      isFetching: value?.fetching ?? false,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("./presentation", () => ({
  FindingComparisonView: ({ comparison }: { comparison: FindingComparisonResponse }) => (
    <article>
      {comparison.before.resultId} / {comparison.after.resultId}
    </article>
  ),
}));
vi.mock("@mui/material", async () => {
  const { materialComponents } = await import("./material.testing");
  return {
    ...materialComponents,
    Button: ({
      children,
      disabled,
      onClick,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onClick?: () => void;
    }) => {
      if (typeof children === "string") state.buttons.set(children, { disabled, onClick });
      return (
        <button type="button" disabled={disabled}>
          {children}
        </button>
      );
    },
    TextField: (props: SelectionFieldProps) => {
      const choices = Children.toArray(props.children).flatMap((child) => {
        if (
          !isValidElement<{ value?: string; disabled?: boolean; children?: ReactNode }>(child) ||
          typeof child.props.value !== "string" ||
          child.props.value === ""
        )
          return [];
        return [
          {
            value: child.props.value,
            label: String(child.props.children),
            disabled: child.props.disabled,
          },
        ];
      });
      state.selects.set(props.label, { value: props.value, choices, onChange: props.onChange });
      return (
        <select aria-label={props.label} value={props.value} onChange={() => undefined}>
          <option value="">Select a baseline</option>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value} disabled={choice.disabled}>
              {choice.label}
            </option>
          ))}
        </select>
      );
    },
    Skeleton: () => <span>Loading comparison</span>,
  };
});
vi.mock("@/components/ui", async () => (await import("./material.testing")).materialUiHelpers);
vi.mock("@mui/icons-material/ExpandMore", () => ({ default: () => null }));
vi.mock("@mui/icons-material/ContentCopy", () => ({ default: () => null }));
const run = sampleReviewRuns.find((candidate) => candidate.id === result.reviewRunId);
const request = run?.requests.find((candidate) => candidate.requestId === result.requestId);
if (!run || !request?.latestJob) throw new Error("A matching run and request are required.");
const baselineJob = {
  ...request.latestJob,
  jobId: "baseline-job",
  resultId: "baseline-result",
  resultDigest: "9".repeat(64),
};
const prefix = [...findingQueryKey("connected", result, principal), "comparison"];
const seed = () => {
  state.cache.set(JSON.stringify([...prefix, "runs", 1]), {
    data: { items: [run], total: 1, page: 1, pageSize: 20 },
  });
  state.cache.set(JSON.stringify([...prefix, "run", run.id]), { data: run });
  state.cache.set(JSON.stringify([...prefix, "jobs", run.id, request.requestId, 1]), {
    data: {
      items: [
        baselineJob,
        request.latestJob,
        { ...baselineJob, jobId: "no-result", resultId: null, resultDigest: null },
      ],
      total: 3,
      page: 1,
      pageSize: 20,
    },
  });
};
const render = () => {
  state.cursor = 0;
  state.queries = [];
  state.selects.clear();
  state.buttons.clear();
  return renderToStaticMarkup(
    <FindingComparison result={result} principal={principal} onDenied={vi.fn()} />,
  );
};
const chooseBaseline = () => {
  render();
  state.selects.get("Baseline run")?.onChange({ target: { value: run.id } });
  render();
  state.selects.get("Baseline request")?.onChange({ target: { value: request.requestId } });
  render();
  state.selects.get("Baseline saved job")?.onChange({ target: { value: baselineJob.jobId } });
  render();
  state.buttons.get("Compare selected results")?.onClick?.();
  render();
};
beforeEach(() => {
  state.values = [];
  state.cursor = 0;
  state.queries = [];
  state.cache.clear();
  state.selects.clear();
  state.buttons.clear();
  vi.clearAllMocks();
  seed();
});

describe("explicit comparison baseline selection", () => {
  it("does not automatically select a run, request, job, or issue a comparison", async () => {
    render();
    expect(state.queries).toHaveLength(4);
    expect(state.queries[1]?.enabled).toBe(false);
    expect(state.queries[2]?.enabled).toBe(false);
    expect(state.queries[3]?.enabled).toBe(false);
    expect(state.buttons.get("Compare selected results")?.disabled).toBe(true);
    state.list.mockResolvedValue({ items: [run], total: 1, page: 1, pageSize: 20 });
    await state.queries[0]?.queryFn();
    expect(state.list).toHaveBeenCalledExactlyOnceWith(result.repositoryId, {
      workItemId: result.workItemId,
      page: 1,
      pageSize: 20,
    });
    expect(state.compare).not.toHaveBeenCalled();
  });
  it("selects an explicit immutable baseline and validates the returned result pair", async () => {
    chooseBaseline();
    expect(state.queries[3]?.enabled).toBe(true);
    const beforeScope = {
      repositoryId: result.repositoryId,
      reviewRunId: run.id,
      requestId: request.requestId,
      jobId: baselineJob.jobId,
    };
    const afterScope = {
      repositoryId: result.repositoryId,
      reviewRunId: result.reviewRunId,
      requestId: result.requestId,
      jobId: result.jobId,
    };
    state.compare.mockResolvedValue({
      before: {
        ...context,
        ...beforeScope,
        resultId: baselineJob.resultId,
        resultDigest: baselineJob.resultDigest,
      },
      after: context,
    });
    await state.queries[3]?.queryFn();
    expect(state.compare).toHaveBeenCalledExactlyOnceWith(afterScope, beforeScope, {
      page: 1,
      pageSize: 20,
    });
  });
  it("disables the current result and jobs with no saved result", () => {
    chooseBaseline();
    const options = state.selects.get("Baseline saved job")?.choices;
    expect(options?.find((option) => option.value === result.jobId)?.disabled).toBe(true);
    expect(options?.find((option) => option.value === "no-result")?.disabled).toBe(true);
    expect(options?.find((option) => option.value === baselineJob.jobId)?.disabled).toBe(false);
  });
  it("clears an earlier baseline when the run or request selection changes", () => {
    chooseBaseline();
    state.selects.get("Baseline request")?.onChange({ target: { value: request.requestId } });
    render();
    expect(state.queries[3]?.enabled).toBe(false);
    expect(state.buttons.get("Compare selected results")?.disabled).toBe(true);
    chooseBaseline();
    state.selects.get("Baseline run")?.onChange({ target: { value: run.id } });
    render();
    expect(state.selects.has("Baseline saved job")).toBe(false);
    expect(state.queries[3]?.enabled).toBe(false);
  });
  it.each(["repositoryId", "workItemId", "workItemKind"] as const)(
    "rejects a baseline list outside the selected %s",
    async (field) => {
      render();
      state.list.mockResolvedValue({ items: [{ ...run, [field]: "another" }] });
      await expect(state.queries[0]?.queryFn()).rejects.toThrow("does not match this work item");
    },
  );
  it.each(["id", "repositoryId", "workItemId", "workItemKind"] as const)(
    "rejects a baseline detail with another %s",
    async (field) => {
      chooseBaseline();
      state.get.mockResolvedValue({ ...run, [field]: "another" });
      await expect(state.queries[1]?.queryFn()).rejects.toThrow("does not match this work item");
    },
  );
  it.each(["resultId", "resultDigest", "workItemId"] as const)(
    "rejects a comparison whose baseline %s changed",
    async (field) => {
      chooseBaseline();
      state.compare.mockResolvedValue({
        after: context,
        before: {
          ...context,
          resultId: baselineJob.resultId,
          resultDigest: baselineJob.resultDigest,
          [field]: "another",
        },
      });
      await expect(state.queries[3]?.queryFn()).rejects.toThrow("selected immutable results");
    },
  );
  it("does not show cached comparison data after denial, even alongside a different query error", () => {
    chooseBaseline();
    const comparisonKey = state.queries[3]?.queryKey;
    state.cache.set(JSON.stringify(comparisonKey), {
      data: { before: { ...context, resultId: "private-baseline" }, after: context },
      error: new ReviewControlHttpError("Denied", {
        status: 403,
        operation: "compare",
        retryable: false,
      }),
    });
    state.cache.set(JSON.stringify([...prefix, "runs", 1]), {
      data: { items: [run] },
      error: new Error("Network error"),
    });
    const html = render();
    expect(html).toContain("Finding comparison unavailable");
    expect(html).not.toContain("private-baseline");
    expect(html).not.toContain(run.id);
  });
});
