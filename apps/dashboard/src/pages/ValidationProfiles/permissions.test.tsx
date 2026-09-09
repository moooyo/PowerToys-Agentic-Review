import type { ValidationProfileVersionSummary } from "@agentic-review/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ProfileFormValues, profileFormValues } from "./forms";
import ValidationProfilesPage from "./index";
import { ProfileDetails } from "./ProfileDetails";
import { ProfileEditor } from "./ProfileEditor";

const state = vi.hoisted(() => ({
  available: true,
  read: true,
  configure: false,
  checking: false,
  publish: vi.fn(),
  saveBinding: vi.fn(),
  getVersion: vi.fn(),
  finish: undefined as ((values: ProfileFormValues) => Promise<void>) | undefined,
  buttons: new Map<string, () => unknown>(),
  queryKeys: [] as unknown[][],
}));

vi.mock("@/components/ConfigurationScopeGuard", () => ({
  useConfigurationAvailable: () => state.available,
  ConfigurationScopeGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/OperatorAccess", () => ({
  OperatorAccessGate: ({ children }: { children: ReactNode }) => (state.read ? children : null),
  useOperatorAccess: () => ({
    allows: () => state.configure,
    can: () => state.configure && !state.checking,
  }),
}));
vi.mock("@/components/RepositoryScope", () => ({
  useRepositoryScope: () => ({
    key: "repository-1",
    repositoryId: "repository-1",
    label: "Repository",
    ready: true,
    error: null,
  }),
  RepositoryScopeUnavailable: () => null,
}));
vi.mock("@/components/PageHeader", () => ({
  PageHeader: ({ actions }: { actions?: ReactNode }) => actions,
}));
vi.mock("@ant-design/icons", () => ({
  PlusOutlined: () => null,
  ReloadOutlined: () => null,
}));
vi.mock("@/services/configuration", () => ({
  configuration: {
    publishProfile: state.publish,
    saveProfileBinding: state.saveBinding,
    getProfileVersion: state.getVersion,
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    state.queryKeys.push(queryKey);
    return {
      data: queryKey.includes("bindings")
        ? []
        : queryKey.includes("binding-history")
          ? { items: [{ id: "history-1", profileVersionId: "version-1" }], total: 1 }
          : queryKey.includes("versions")
            ? { items: [], total: 0 }
            : undefined,
      isPending: true,
      isFetching: false,
      isError: false,
      isSuccess: false,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("antd", async () => {
  const React = await import("react");
  type ContentProps = { children?: ReactNode };
  const Content = ({ children }: ContentProps) => React.createElement("div", null, children);
  const Form = Object.assign(
    ({ children, onFinish }: ContentProps & { onFinish?: typeof state.finish }) => {
      state.finish = onFinish;
      return React.createElement("form", null, children);
    },
    {
      Item: Content,
      useWatch: () => undefined,
      useForm: () => [{ setFieldsValue: vi.fn(), getFieldValue: vi.fn(), submit: vi.fn() }],
    },
  );
  return {
    Alert: ({ title, description }: { title?: ReactNode; description?: ReactNode }) =>
      React.createElement("aside", null, title, description),
    Button: ({
      children,
      disabled,
      onClick,
    }: ContentProps & {
      disabled?: boolean;
      onClick?: () => unknown;
    }) => {
      if (typeof children === "string" && onClick) state.buttons.set(children, onClick);
      return React.createElement("button", { disabled }, children);
    },
    Card: Content,
    Collapse: Content,
    Descriptions: Content,
    Drawer: ({
      children,
      extra,
      footer,
    }: ContentProps & {
      extra?: ReactNode;
      footer?: ReactNode;
    }) => React.createElement("section", null, extra, children, footer),
    Empty: Content,
    Form,
    Input: Object.assign(Content, { TextArea: Content }),
    Select: Content,
    Skeleton: Content,
    Space: Content,
    Switch: Content,
    Table: ({
      dataSource,
      columns,
    }: {
      dataSource: Record<string, unknown>[];
      columns: { render?: (value: unknown, record: Record<string, unknown>) => ReactNode }[];
    }) =>
      React.createElement(
        "div",
        null,
        dataSource.map((record, row) =>
          React.createElement(
            "div",
            { key: row },
            columns.map((column, index) =>
              React.createElement("div", { key: index }, column.render?.(undefined, record)),
            ),
          ),
        ),
      ),
    Tabs: ({ items }: { items: { key: string; children: ReactNode }[] }) =>
      React.createElement(
        "div",
        null,
        items.map((item) => React.createElement("div", { key: item.key }, item.children)),
      ),
    Tag: Content,
    Typography: { Paragraph: Content, Text: Content, Title: Content },
    message: { useMessage: () => [{ success: vi.fn() }, null] },
  };
});

const profile: ValidationProfileVersionSummary = {
  id: "version-1",
  profileId: "profile-1",
  repositoryId: "repository-1",
  name: "Build profile",
  workflowKind: "pr_static_build",
  target: "headless",
  required: true,
  outputSchemaVersion: "PrReviewPlanV2",
  configSha256: "a".repeat(64),
  version: 1,
  createdAt: "2026-09-07T00:00:00.000Z",
  publishedAt: "2026-09-07T00:00:00.000Z",
  createdBy: "maintainer-1",
};

const renderEditor = () =>
  renderToStaticMarkup(
    <ProfileEditor repositoryId="repository-1" onClose={vi.fn()} onPublished={vi.fn()} />,
  );
const renderDetails = () =>
  renderToStaticMarkup(
    <ProfileDetails
      repositoryId="repository-1"
      profile={profile}
      onClose={vi.fn()}
      onNewVersion={vi.fn()}
    />,
  );

describe("validation profile permissions", () => {
  beforeEach(() => {
    state.available = true;
    state.read = true;
    state.configure = false;
    state.checking = false;
    state.finish = undefined;
    state.buttons.clear();
    state.queryKeys = [];
    vi.clearAllMocks();
  });

  it("does not mount profile queries before repository read access is granted", () => {
    state.read = false;
    expect(renderToStaticMarkup(<ValidationProfilesPage />)).toBe("");
    expect(state.queryKeys).toEqual([]);
  });

  it("lets viewers load the repository profile list without create controls", () => {
    const markup = renderToStaticMarkup(<ValidationProfilesPage />);
    expect(state.queryKeys).toContainEqual(["validation-profiles", "repository-1", "list", 1, 20]);
    expect(markup).toContain("View published workflow configurations and repository bindings.");
    expect(markup).not.toContain("Create profile");
  });

  it("keeps published details readable without exposing binding or version actions to viewers", () => {
    const markup = renderDetails();
    expect(markup).toContain("View the published version used for this repository.");
    expect(markup).not.toContain("Create new version");
    expect(markup).not.toContain("Use this version");
    expect(markup).not.toContain("Save repository binding");
    expect(markup).not.toContain("Enable this profile");
  });

  it("rejects direct publication calls without configuration permission", async () => {
    expect(renderEditor()).toContain("Configuration permission required");
    await state.finish?.({ ...profileFormValues(), name: "New profile" });
    expect(state.publish).not.toHaveBeenCalled();
  });

  it("blocks actions while configuration access is being checked", async () => {
    state.configure = true;
    state.checking = true;
    expect(renderEditor()).toContain('<button disabled="">Publish profile</button>');
    await state.finish?.({ ...profileFormValues(), name: "New profile" });
    const markup = renderDetails();
    expect(markup).toContain('<button disabled="">Create new version</button>');
    expect(markup).toContain('<button disabled="">Use this version</button>');
    await state.buttons.get("Use this version")?.();
    await state.buttons.get("Save repository binding")?.();
    expect(state.publish).not.toHaveBeenCalled();
    expect(state.getVersion).not.toHaveBeenCalled();
    expect(state.saveBinding).not.toHaveBeenCalled();
  });

  it("allows a confirmed maintainer to publish a profile", async () => {
    state.configure = true;
    state.publish.mockResolvedValue(profile);
    expect(renderEditor()).toContain("<button>Publish profile</button>");
    await state.finish?.({ ...profileFormValues(), name: "New profile" });
    expect(state.publish).toHaveBeenCalledOnce();
    expect(state.publish).toHaveBeenCalledWith(
      "repository-1",
      expect.objectContaining({ name: "New profile" }),
    );
  });

  it("blocks publication when repository confirmation is unavailable", async () => {
    state.configure = true;
    state.available = false;
    renderEditor();
    await state.finish?.({ ...profileFormValues(), name: "New profile" });
    expect(state.publish).not.toHaveBeenCalled();
  });
});
