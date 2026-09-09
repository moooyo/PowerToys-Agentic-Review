import { useQueryClient } from "@tanstack/react-query";
import { useModel } from "@umijs/max";
import { Alert, Button, Card, ConfigProvider, Empty, Skeleton, Space, Tabs } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfigurationScopeGuard } from "@/components/ConfigurationScopeGuard";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { RepositoryScopeUnavailable, useRepositoryScope } from "@/components/RepositoryScope";
import { createHttpEvaluationAdapter } from "@/services/evaluations";
import {
  EvaluationContext,
  useEvaluationPage,
  useEvaluationQuery,
  useRefreshEvaluations,
} from "./context";
import { SuiteWorkspace } from "./SuiteWorkspace";
import {
  accessDenied,
  bindingAllowsConfigure,
  collectCatalog,
  errorMessage,
  evaluationQueryRoot,
  nextAccessBinding,
  permissionSignature,
  workflowKind,
} from "./state";
import "./index.css";

function RepositoryContent() {
  const [activeKind, setActiveKind] = useState("pull_request");
  const page = useEvaluationPage(),
    refresh = useRefreshEvaluations();
  const suites = useEvaluationQuery(["suites"], (signal) =>
    collectCatalog((number) =>
      page.api.listSuites(page.repositoryId, { page: number, pageSize: 50 }, signal),
    ),
  );
  const sources = useEvaluationQuery(["sources"], (signal) =>
    collectCatalog((number) =>
      page.api.listSources(page.repositoryId, { page: number, pageSize: 50 }, signal),
    ),
  );
  return (
    <>
      <div className="evaluation-page-toolbar">
        <span>Frozen examples, expectation labels, and configuration comparisons</span>
        <Button
          loading={suites.isFetching || sources.isFetching}
          disabled={!page.readable}
          onClick={refresh}
        >
          Refresh catalog
        </Button>
      </div>
      {suites.error || sources.error ? (
        <Alert
          showIcon
          type="error"
          title="Catalog unavailable"
          description={errorMessage(suites.error ?? sources.error)}
          action={
            <Button disabled={!page.readable} onClick={refresh}>
              Retry catalog
            </Button>
          }
        />
      ) : null}
      {!page.allowsConfigure ? (
        <Alert
          type="info"
          showIcon
          title="Read-only access"
          description="Repository configuration permission is required to manage sources and drafts, publish versions, and create or cancel batches."
        />
      ) : null}
      {suites.isPending || sources.isPending ? <Skeleton active paragraph={{ rows: 3 }} /> : null}
      <Tabs
        activeKey={activeKind}
        onChange={setActiveKind}
        destroyOnHidden={false}
        items={[
          {
            key: "pull_request",
            label: "Pull requests",
            forceRender: true,
            children: (
              <SuiteWorkspace
                kind="pull_request"
                active={activeKind === "pull_request"}
                suites={(suites.data ?? []).filter(
                  (suite) => workflowKind(suite.workflowKind) === "pull_request",
                )}
                sources={(sources.data ?? []).filter(
                  (source) => source.workItemKind === "pull_request",
                )}
              />
            ),
          },
          {
            key: "issue",
            label: "Issues",
            forceRender: true,
            children: (
              <SuiteWorkspace
                kind="issue"
                active={activeKind === "issue"}
                suites={(suites.data ?? []).filter(
                  (suite) => workflowKind(suite.workflowKind) === "issue",
                )}
                sources={(sources.data ?? []).filter((source) => source.workItemKind === "issue")}
              />
            ),
          },
        ]}
      />
    </>
  );
}

export default function EvaluationsPage() {
  const scope = useRepositoryScope(),
    access = useOperatorAccess(scope.repositoryId),
    client = useQueryClient();
  const { initialState } = useModel("@@initialState");
  const api = useMemo(() => createHttpEvaluationAdapter(), []);
  const identity = JSON.stringify([
    scope.key,
    access.identityKey,
    initialState?.authenticationEpoch ?? 0,
  ]);
  const verified =
    access.ready && !access.checking && !access.pending && !access.error
      ? permissionSignature(access.context)
      : null;
  const [binding, setBinding] = useState({ identity, permissions: verified });
  const next = nextAccessBinding(binding, identity, verified);
  if (next !== binding) setBinding(next);
  const [denial, setDenial] = useState({ identity, denied: false });
  if (denial.identity !== identity) setDenial({ identity, denied: false });
  const locallyDenied = denial.identity === identity && denial.denied;
  const repositoryError = client.getQueryState([
    "managed-repositories",
    "detail",
    scope.repositoryId,
    ...access.identityKey,
  ])?.error;
  const session = JSON.stringify([identity, next.permissions]);
  const invalidateAccess = useCallback(() => {
    setDenial((previous) =>
      previous.identity === identity ? { identity, denied: true } : previous,
    );
    void client.cancelQueries({ queryKey: [...evaluationQueryRoot, session] });
    client.removeQueries({ queryKey: [...evaluationQueryRoot, session] });
  }, [client, identity, session]);
  const forbidden =
    locallyDenied ||
    accessDenied(access.error) ||
    accessDenied(repositoryError) ||
    !access.authenticated ||
    (access.ready &&
      !access.checking &&
      !access.pending &&
      !access.error &&
      !access.allows("read"));
  const readable =
    !forbidden &&
    scope.ready &&
    !!scope.repositoryId &&
    access.ready &&
    !access.checking &&
    !access.pending &&
    !access.error &&
    access.allows("read");
  useEffect(() => {
    if (!readable) void client.cancelQueries({ queryKey: [...evaluationQueryRoot, session] });
    return () => {
      void client.cancelQueries({ queryKey: [...evaluationQueryRoot, session] });
    };
  }, [client, session, readable]);
  useEffect(
    () => () => {
      client.removeQueries({ queryKey: [...evaluationQueryRoot, session] });
    },
    [client, session],
  );
  const refreshAccess = async () => {
    await access.refresh();
    await scope.refresh();
    setDenial((previous) =>
      previous.identity === identity ? { identity, denied: false } : previous,
    );
  };
  const header = (
    <ConfigProvider theme={{ token: { fontSizeHeading3: 20, fontWeightStrong: 600 } }}>
      <PageHeader
        eyebrow="Configuration"
        title="Evaluations"
        titleId="evaluation-suites-title"
        description={
          scope.repositoryId
            ? `Manage frozen examples, expectations, and comparison batches for ${scope.label}.`
            : "Choose a repository to manage its evaluation sample sets."
        }
        actions={
          <Button loading={access.checking} onClick={() => void refreshAccess()}>
            Refresh access
          </Button>
        }
      />
    </ConfigProvider>
  );
  if (access.identityKey[0] === "sample")
    return (
      <section className="evaluations-page">
        {header}
        <Alert
          showIcon
          type="info"
          title="A connected server is required"
          description="Evaluation management is unavailable in sample mode. Sources, drafts, publications, and batches are not simulated."
        />
      </section>
    );
  if (forbidden)
    return (
      <section className="evaluations-page">
        {header}
        <Alert
          showIcon
          type="info"
          title="Evaluation access is unavailable"
          description="Previous editor content and pending requests have been cleared. Verify repository access to continue."
          action={<Button onClick={() => void refreshAccess()}>Verify access</Button>}
        />
      </section>
    );
  if (scope.ready && !scope.repositoryId)
    return (
      <section className="evaluations-page">
        {header}
        <Card>
          <Empty description="Select a repository in the sidebar to manage frozen examples." />
        </Card>
      </section>
    );
  return (
    <section className="evaluations-page" aria-labelledby="evaluation-suites-title">
      {header}
      <ConfigurationScopeGuard
        key={identity}
        scopeKey={identity}
        available={scope.ready && !!scope.repositoryId}
        fallback={<RepositoryScopeUnavailable />}
      >
        {next.permissions !== null && access.principal && scope.repositoryId ? (
          <EvaluationContext.Provider
            key={session}
            value={{
              api,
              session,
              repositoryId: scope.repositoryId,
              principal: access.principal,
              readable,
              canConfigure: readable && access.can("configure"),
              allowsConfigure: bindingAllowsConfigure(next),
              invalidateAccess,
            }}
          >
            {!readable ? (
              <Space orientation="vertical" className="evaluation-access-notice">
                <Skeleton active paragraph={{ rows: 2 }} />
                <Alert
                  showIcon
                  type={access.error ? "warning" : "info"}
                  title={access.error ? "Access could not be verified" : "Checking access"}
                  description="Editors and original pending requests are preserved while this same scope is verified."
                  action={<Button onClick={() => void refreshAccess()}>Verify access</Button>}
                />
              </Space>
            ) : null}
            <div hidden={!readable} inert={!readable} aria-hidden={!readable}>
              <ConfigProvider
                getPopupContainer={(trigger) => trigger?.parentElement ?? document.body}
              >
                <RepositoryContent />
              </ConfigProvider>
            </div>
          </EvaluationContext.Provider>
        ) : (
          <Skeleton active paragraph={{ rows: 4 }} />
        )}
      </ConfigurationScopeGuard>
    </section>
  );
}
