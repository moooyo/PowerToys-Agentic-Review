import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detailFixture,
  previewFixture,
  publicationTestActor,
  publicationTestScope,
} from "../../services/publications/fixtures.testing";
import { ReviewControlHttpError } from "../../services/review-control/errors";
import { PublicationPreview } from "./index";

const state = vi.hoisted(() => ({
  readable: true,
  configure: true,
  checking: false,
  epoch: 1,
  values: [] as unknown[],
  cursor: 0,
  data: undefined as unknown,
  error: null as Error | null,
  queryKeys: [] as unknown[][],
  buttons: [] as { label: unknown; disabled?: boolean; onClick?: () => void }[],
  checkbox: null as {
    checked: boolean;
    disabled: boolean;
    onChange: (event: { target: { checked: boolean } }) => void;
  } | null,
  confirm: vi.fn(),
  refresh: vi.fn(),
  effects: [] as { run: () => unknown; dependencies?: readonly unknown[] }[],
  cancel: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.values)) state.values[index] = initial;
    return [
      state.values[index],
      (value: unknown) => {
        state.values[index] = value;
      },
    ];
  },
  useEffect: (effect: () => unknown, dependencies?: readonly unknown[]) => {
    state.effects.push({ run: effect, dependencies });
  },
}));
vi.mock("@/state/session", () => ({
  useOperatorSession: () => ({ initialState: { authenticationEpoch: state.epoch } }),
}));
vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: (repositoryId: string) => ({
    ready: state.readable,
    checking: state.checking,
    principal: { issuer: "https://fixture.example.test", subject: "maintainer" },
    identityKey: ["connected", "issuer", "maintainer"],
    context: {
      repository: { repositoryId, role: state.configure ? "maintainer" : "reviewer" },
      platformAdministrator: false,
    },
    allows: (permission: string) => (permission === "read" ? state.readable : state.configure),
    can: (permission: string) =>
      !state.checking && (permission === "read" ? state.readable : state.configure),
    refresh: state.refresh,
  }),
}));
vi.mock("@/services/publications", () => ({
  publicationQueryRoot: ["publications"],
  publications: { preview: vi.fn(), confirm: state.confirm },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    cancelQueries: state.cancel,
    removeQueries: state.remove,
  }),
  useQuery: (options: { queryKey: unknown[] }) => {
    state.queryKeys.push(options.queryKey);
    return {
      data: state.data,
      isError: !!state.error,
      error: state.error,
      isFetching: false,
      refetch: state.refresh,
    };
  },
}));
vi.mock("@mui/material", () => {
  const Content = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Alert: ({ children, action }: { children?: ReactNode; action?: ReactNode }) => (
      <aside>
        {children}
        {action}
      </aside>
    ),
    AlertTitle: Content,
    Button: ({
      children,
      disabled,
      onClick,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onClick?: () => void;
    }) => {
      state.buttons.push({ label: children, disabled, onClick });
      return (
        <button type="button" disabled={disabled}>
          {children}
        </button>
      );
    },
    Checkbox: (props: {
      checked: boolean;
      disabled: boolean;
      onChange: (event: { target: { checked: boolean } }) => void;
    }) => {
      state.checkbox = props;
      return (
        <input
          id="publication-preview-consent"
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled}
          readOnly
        />
      );
    },
    FormControlLabel: ({ control, label }: { control: ReactNode; label: ReactNode }) => (
      <label htmlFor="publication-preview-consent">
        {control}
        {label}
      </label>
    ),
    Dialog: Content,
    DialogTitle: Content,
    DialogContent: Content,
    DialogActions: Content,
    Skeleton: () => <span>Loading publication</span>,
    Stack: Content,
    Typography: Content,
  };
});
vi.mock("@/components/ui", () => ({
  DetailsGrid: ({ items }: { items: { key?: string; label: ReactNode; value: ReactNode }[] }) => (
    <dl>
      {items.map((entry, index) => (
        <div key={entry.key ?? index}>
          {entry.label}: {entry.value}
        </div>
      ))}
    </dl>
  ),
}));
function render(scope = publicationTestScope) {
  state.cursor = 0;
  state.buttons = [];
  state.effects = [];
  return renderToStaticMarkup(<PublicationPreview {...scope} onClose={vi.fn()} />);
}
function confirmButton() {
  const button = state.buttons.find(
    (entry) =>
      entry.label === "Confirm publication" || entry.label === "Retry original confirmation",
  );
  if (!button) throw new Error("Expected a confirmation button.");
  return button;
}
function consent() {
  state.checkbox?.onChange({ target: { checked: true } });
  render();
}
beforeEach(() => {
  state.readable = true;
  state.configure = true;
  state.checking = false;
  state.epoch = 1;
  state.values = [];
  state.cursor = 0;
  state.data = previewFixture();
  state.error = null;
  state.queryKeys = [];
  state.buttons = [];
  state.checkbox = null;
  state.confirm.mockReset();
  vi.clearAllMocks();
});
describe("explicit publication preview confirmation", () => {
  it("shows the complete plain-text body and exact target, event, commit and publisher", () => {
    const html = render();
    expect(html).toContain("Required check: failed.");
    expect(html).toContain("&lt;!-- publication:publication-a --&gt;");
    expect(html).toContain("fixture-owner/review-target");
    expect(html).toContain("Pull request #7");
    expect(html).toContain("COMMENT");
    expect(html).toContain("d".repeat(40));
    expect(html).toContain("303");
    expect(confirmButton().disabled).toBe(true);
    confirmButton().onClick?.();
    expect(state.confirm).not.toHaveBeenCalled();
  });
  it("requires configuration authority even when consent is supplied", () => {
    state.configure = false;
    render();
    consent();
    expect(confirmButton().disabled).toBe(true);
    confirmButton().onClick?.();
    expect(state.confirm).not.toHaveBeenCalled();
  });
  it("sends one exact confirmation after consent despite duplicate clicks", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    state.confirm.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render();
    consent();
    const button = confirmButton();
    expect(button.disabled).toBe(false);
    button.onClick?.();
    button.onClick?.();
    expect(state.confirm).toHaveBeenCalledTimes(1);
    const [scope, request] = state.confirm.mock.calls[0] ?? [];
    expect(scope).toEqual(publicationTestScope);
    expect(request.expectedSelectedDecisionId).toBe(publicationTestScope.decisionId);
    expect(request.expectedDecisionContextVersion).toBe(5);
    expect(request).not.toHaveProperty("body");
    resolve?.({
      intent: {
        ...detailFixture().intent,
        confirmationChangeId: request.changeId,
        actor: publicationTestActor,
      },
      replayed: false,
    });
    await vi.waitFor(() => expect(render()).toContain("Publication confirmed"));
  });
  it("reuses the original change ID after a lost confirmation response", async () => {
    state.confirm.mockRejectedValueOnce(new Error("Connection lost"));
    render();
    consent();
    confirmButton().onClick?.();
    await vi.waitFor(() => expect(render()).toContain("Publication confirmation failed"));
    const request = state.confirm.mock.calls[0]?.[1];
    state.confirm.mockResolvedValueOnce({
      intent: { ...detailFixture().intent, confirmationChangeId: request.changeId },
      replayed: true,
    });
    confirmButton().onClick?.();
    await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledTimes(2));
    expect(state.confirm.mock.calls[1]?.[1]).toEqual(request);
  });
  it("keeps the unknown original request while the same access scope is being checked", async () => {
    let previousFingerprint: unknown;
    const flushFingerprintEffect = () => {
      const effect = state.effects.find(
        (entry) =>
          entry.dependencies?.length === 1 &&
          (entry.dependencies[0] === null ||
            (typeof entry.dependencies[0] === "string" &&
              entry.dependencies[0].startsWith('["publication-a",'))),
      );
      if (!effect) throw new Error("The preview fingerprint effect was not registered.");
      const fingerprint = effect.dependencies?.[0];
      if (!Object.is(previousFingerprint, fingerprint)) {
        previousFingerprint = fingerprint;
        effect.run();
      }
    };
    state.confirm.mockRejectedValueOnce(new Error("Connection lost"));
    render();
    flushFingerprintEffect();
    consent();
    flushFingerprintEffect();
    confirmButton().onClick?.();
    await vi.waitFor(() => expect(render()).toContain("Publication confirmation failed"));
    flushFingerprintEffect();
    const request = state.confirm.mock.calls[0]?.[1];
    state.checking = true;
    expect(render()).not.toContain("Required check: failed.");
    flushFingerprintEffect();
    expect(confirmButton().disabled).toBe(true);
    state.checking = false;
    render();
    flushFingerprintEffect();
    render();
    expect(confirmButton().label).toBe("Retry original confirmation");
    state.confirm.mockResolvedValueOnce({
      intent: { ...detailFixture().intent, confirmationChangeId: request.changeId },
      replayed: true,
    });
    confirmButton().onClick?.();
    await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledTimes(2));
    expect(state.confirm.mock.calls[1]?.[1]).toEqual(request);
  });
  it("does not clear an unknown request when the same semantic effect setup is replayed", async () => {
    state.confirm.mockRejectedValueOnce(new Error("Connection lost"));
    render();
    const semanticEffect = state.effects.find(
      (entry) =>
        entry.dependencies?.length === 1 &&
        typeof entry.dependencies[0] === "string" &&
        entry.dependencies[0].startsWith('["publication-a",'),
    );
    if (!semanticEffect) throw new Error("The preview fingerprint effect is required.");
    semanticEffect.run();
    consent();
    confirmButton().onClick?.();
    await vi.waitFor(() => expect(render()).toContain("Publication confirmation failed"));
    const request = state.confirm.mock.calls[0]?.[1];
    semanticEffect.run();
    render();
    expect(confirmButton().label).toBe("Retry original confirmation");
    state.confirm.mockResolvedValueOnce({
      intent: { ...detailFixture().intent, confirmationChangeId: request.changeId },
      replayed: true,
    });
    confirmButton().onClick?.();
    await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledTimes(2));
    expect(state.confirm.mock.calls[1]?.[1]).toEqual(request);
  });
  it("requires another review after a stale-preview conflict", async () => {
    state.confirm.mockRejectedValueOnce(
      new ReviewControlHttpError("Changed", {
        operation: "confirm",
        status: 409,
        retryable: false,
      }),
    );
    render();
    consent();
    confirmButton().onClick?.();
    await vi.waitFor(() => expect(render()).toContain("This preview is no longer current"));
    expect(confirmButton().disabled).toBe(true);
    confirmButton().onClick?.();
    expect(state.confirm).toHaveBeenCalledTimes(1);
  });
  it("hides loaded content when access is revoked or a preview read is denied", () => {
    expect(render()).toContain("Required check: failed.");
    state.readable = false;
    expect(render()).not.toContain("Required check: failed.");
    state.readable = true;
    state.error = new ReviewControlHttpError("Denied", {
      operation: "preview",
      status: 404,
      retryable: false,
    });
    expect(render()).not.toContain("Required check: failed.");
  });
  it("keys preview reads by exact decision, repository and authentication session", () => {
    render();
    render({ ...publicationTestScope, decisionId: "another-event" });
    state.epoch = 2;
    render();
    expect(new Set(state.queryKeys.map((key) => JSON.stringify(key))).size).toBe(3);
  });
});
