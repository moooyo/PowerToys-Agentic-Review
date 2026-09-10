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
vi.mock("@mui/icons-material", () => ({
  Add: () => null,
  Close: () => null,
  ContentCopy: () => null,
  ExpandMore: () => null,
  Refresh: () => null,
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
vi.mock("react-hook-form", () => ({
  useForm: () => ({
    control: {},
    watch: (name: keyof ProfileFormValues) => profileFormValues()[name],
    reset: vi.fn(),
    getValues: (name: keyof ProfileFormValues) => profileFormValues()[name],
    setValue: vi.fn(),
    trigger: vi.fn(),
    handleSubmit: (onFinish: typeof state.finish) => {
      state.finish = onFinish;
      return () => onFinish?.({ ...profileFormValues(), name: "New profile" });
    },
  }),
  Controller: () => null,
}));
vi.mock("@mui/material", async () => {
  const React = await import("react");
  type ContentProps = { children?: ReactNode };
  const Content = ({ children }: ContentProps) => React.createElement("div", null, children);
  const Button = ({
    children,
    disabled,
    onClick,
  }: ContentProps & { disabled?: boolean; onClick?: () => unknown }) => {
    if (typeof children === "string" && onClick) state.buttons.set(children, onClick);
    return React.createElement("button", { disabled }, children);
  };
  return {
    Accordion: Content,
    AccordionDetails: Content,
    AccordionSummary: Content,
    Alert: ({ children, action }: ContentProps & { action?: ReactNode }) =>
      React.createElement("aside", null, children, action),
    AlertTitle: Content,
    Box: Content,
    Button,
    Chip: ({ label }: { label?: ReactNode }) => React.createElement("span", null, label),
    Dialog: Content,
    DialogActions: Content,
    DialogContent: Content,
    DialogTitle: Content,
    Drawer: Content,
    FormControlLabel: Content,
    IconButton: Button,
    Paper: Content,
    Skeleton: Content,
    Stack: Content,
    Switch: Content,
    Tab: Content,
    Tabs: Content,
    TextField: Content,
    Tooltip: Content,
    Typography: Content,
  };
});
vi.mock("@/components/ui", async () => {
  const React = await import("react");
  return {
    DetailsGrid: ({ items }: { items: { label: ReactNode; value: ReactNode }[] }) =>
      React.createElement(
        "dl",
        null,
        items.map((item, index) =>
          React.createElement("div", { key: index }, item.label, item.value),
        ),
      ),
    EmptyState: ({
      title,
      description,
      action,
    }: {
      title: ReactNode;
      description?: ReactNode;
      action?: ReactNode;
    }) => React.createElement("div", null, title, description, action),
    notify: vi.fn(),
    DataTable: ({
      rows,
      columns,
    }: {
      rows: Record<string, unknown>[];
      columns: { id: string; render: (row: Record<string, unknown>, index: number) => ReactNode }[];
    }) =>
      React.createElement(
        "div",
        null,
        rows.map((row, index) =>
          React.createElement(
            "div",
            { key: index },
            columns.map((column) =>
              React.createElement("div", { key: column.id }, column.render(row, index)),
            ),
          ),
        ),
      ),
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
