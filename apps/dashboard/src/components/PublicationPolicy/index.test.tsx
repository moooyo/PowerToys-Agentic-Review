import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  policyEventFixture,
  publicationTestActor,
} from "../../services/publications/fixtures.testing";
import { ReviewControlHttpError } from "../../services/review-control/errors";
import { PublicationPolicy } from "./index";

const state = vi.hoisted(() => ({
  configure: true,
  readable: true,
  cursor: 0,
  values: [] as unknown[],
  policy: undefined as unknown,
  buttons: [] as { name: unknown; disabled?: boolean; onClick?: () => void }[],
  toggle: null as ((value: boolean) => void) | null,
  update: vi.fn(),
  refresh: vi.fn(),
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
}));
vi.mock("@/components/PublicationPreview/access", () => ({
  PublicationAccess: ({
    repositoryId,
    children,
  }: {
    repositoryId: string;
    children: (session: string, access: unknown) => ReactNode;
  }) =>
    state.readable ? (
      children("policy-session", {
        principal: { issuer: "https://fixture.example.test", subject: "maintainer" },
        can: () => state.configure,
        allows: () => state.configure,
        refresh: () => state.refresh(repositoryId),
      })
    ) : (
      <aside>Publication access is unavailable</aside>
    ),
  usePublicationReadGuard: () => ({
    denied: false,
    guard: {
      read: (operation: () => Promise<unknown>) => operation(),
      deny: vi.fn(),
      snapshot: () => false,
    },
  }),
  publicationAccessDenied: () => false,
  publicationError: (value: unknown) => (value instanceof Error ? value.message : "Unavailable"),
}));
vi.mock("@/services/publications", () => ({
  publicationQueryRoot: ["publications"],
  publications: { policy: vi.fn(), policyActivity: vi.fn(), updatePolicy: state.update },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (options: { queryKey: unknown[] }) => ({
    data: options.queryKey.includes("policy-history") ? { items: [], total: 0 } : state.policy,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("antd", () => {
  const Content = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Alert: ({ title, description }: { title?: ReactNode; description?: ReactNode }) => (
      <aside>
        {title}
        {description}
      </aside>
    ),
    Button: ({
      children,
      disabled,
      onClick,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onClick?: () => void;
    }) => {
      state.buttons.push({ name: children, disabled, onClick });
      return (
        <button type="button" disabled={disabled}>
          {children}
        </button>
      );
    },
    Card: ({
      children,
      title,
      extra,
    }: {
      children: ReactNode;
      title: ReactNode;
      extra: ReactNode;
    }) => (
      <section>
        {title}
        {extra}
        {children}
      </section>
    ),
    Collapse: Content,
    Descriptions: Content,
    Drawer: Content,
    Pagination: Content,
    Skeleton: Content,
    Space: Content,
    Table: Content,
    Tag: Content,
    Switch: ({
      checked,
      disabled,
      onChange,
    }: {
      checked: boolean;
      disabled: boolean;
      onChange: (value: boolean) => void;
    }) => {
      state.toggle = onChange;
      return <input type="checkbox" checked={checked} disabled={disabled} readOnly />;
    },
    Typography: { Text: Content, Paragraph: Content },
  };
});
function render() {
  state.cursor = 0;
  state.buttons = [];
  return renderToStaticMarkup(<PublicationPolicy repositoryId="repository-a" />);
}
function saveButton() {
  const button = state.buttons.find(
    (entry) =>
      entry.name === "Save publication policy" || entry.name === "Retry original policy save",
  );
  if (!button) throw new Error("Expected a policy save button.");
  return button;
}
beforeEach(() => {
  state.configure = true;
  state.readable = true;
  state.policy = policyEventFixture().previousSnapshot;
  state.values = [state.policy, false];
  state.cursor = 0;
  state.buttons = [];
  state.toggle = null;
  state.update.mockReset();
  vi.clearAllMocks();
});
describe("publication policy controls", () => {
  it("keeps absent policy disabled until an authorized explicit CAS save", async () => {
    expect(render()).toContain("Publication disabled");
    expect(saveButton().disabled).toBe(true);
    state.toggle?.(true);
    render();
    state.update.mockImplementation(async (_repositoryId, request) => ({
      change: { ...policyEventFixture(), changeId: request.changeId, actor: publicationTestActor },
      replayed: false,
    }));
    saveButton().onClick?.();
    await vi.waitFor(() => expect(render()).toContain("Publication policy saved."));
    expect(state.update.mock.calls[0]?.[0]).toBe("repository-a");
    expect(state.update.mock.calls[0]?.[1]).toMatchObject({ expectedVersion: 0, enabled: true });
    expect(state.update.mock.calls[0]?.[1]).not.toHaveProperty("actor");
  });
  it("does not allow a reader to save a publication policy", () => {
    state.configure = false;
    render();
    state.toggle?.(true);
    render();
    expect(saveButton().disabled).toBe(true);
    saveButton().onClick?.();
    expect(state.update).not.toHaveBeenCalled();
  });
  it("retains the edited selection after a CAS conflict and requires reload", async () => {
    render();
    state.toggle?.(true);
    render();
    state.update.mockRejectedValueOnce(
      new ReviewControlHttpError("Policy changed", {
        operation: "policy",
        status: 409,
        retryable: false,
      }),
    );
    saveButton().onClick?.();
    await vi.waitFor(() => expect(render()).toContain("Publication policy changed"));
    expect(saveButton().disabled).toBe(true);
    expect(state.values[1]).toBe(true);
  });
});
