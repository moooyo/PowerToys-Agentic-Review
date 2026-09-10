import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Skeleton,
  Stack,
  Tab,
  Tabs,
} from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfigurationScopeGuard } from "@/components/ConfigurationScopeGuard";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { PageHeader } from "@/components/PageHeader";
import { RepositoryScopeUnavailable, useRepositoryScope } from "@/components/RepositoryScope";
import { EmptyState } from "@/components/ui";
import { createHttpEvaluationAdapter } from "@/services/evaluations";
import { useOperatorSession } from "@/state/session";
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
      page.api.listSuites(
        page.repositoryId,
        {
          page: number,
          pageSize: 50,
        },
        signal,
      ),
    ),
  );
  const sources = useEvaluationQuery(["sources"], (signal) =>
    collectCatalog((number) =>
      page.api.listSources(
        page.repositoryId,
        {
          page: number,
          pageSize: 50,
        },
        signal,
      ),
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
          variant="outlined"
        >
          Refresh catalog
        </Button>
      </div>
      {suites.error || sources.error ? (
        <Alert
          action={
            <Button disabled={!page.readable} onClick={refresh} variant="outlined">
              Retry catalog
            </Button>
          }
          severity={"error"}
        >
          <AlertTitle>{"Catalog unavailable"}</AlertTitle>
          {errorMessage(suites.error ?? sources.error)}
        </Alert>
      ) : null}
      {!page.allowsConfigure ? (
        <Alert severity={"info"}>
          <AlertTitle>{"Read-only access"}</AlertTitle>
          {
            "Repository configuration permission is required to manage sources and drafts, publish versions, and create or cancel batches."
          }
        </Alert>
      ) : null}
      {suites.isPending || sources.isPending ? (
        <Skeleton variant="rounded" height={96} aria-label="Loading evaluation content" />
      ) : null}
      <>
        <Tabs
          value={activeKind}
          onChange={(_event, value: string) => setActiveKind(value)}
          aria-label="Evaluation work item kind"
        >
          <Tab
            value={"pull_request"}
            label={"Pull requests"}
            id="evaluation-tab-pull_request"
            aria-controls="evaluation-panel-pull_request"
          />
          <Tab
            value={"issue"}
            label={"Issues"}
            id="evaluation-tab-issue"
            aria-controls="evaluation-panel-issue"
          />
        </Tabs>
        <Box
          role="tabpanel"
          id="evaluation-panel-pull_request"
          aria-labelledby="evaluation-tab-pull_request"
          hidden={activeKind !== "pull_request"}
          sx={{
            pt: 2,
          }}
        >
          {
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
          }
        </Box>
        <Box
          role="tabpanel"
          id="evaluation-panel-issue"
          aria-labelledby="evaluation-tab-issue"
          hidden={activeKind !== "issue"}
          sx={{
            pt: 2,
          }}
        >
          {
            <SuiteWorkspace
              kind="issue"
              active={activeKind === "issue"}
              suites={(suites.data ?? []).filter(
                (suite) => workflowKind(suite.workflowKind) === "issue",
              )}
              sources={(sources.data ?? []).filter((source) => source.workItemKind === "issue")}
            />
          }
        </Box>
      </>
    </>
  );
}
export default function EvaluationsPage() {
  const scope = useRepositoryScope(),
    access = useOperatorAccess(scope.repositoryId),
    client = useQueryClient();
  const { initialState } = useOperatorSession();
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
  const [binding, setBinding] = useState({
    identity,
    permissions: verified,
  });
  const next = nextAccessBinding(binding, identity, verified);
  if (next !== binding) setBinding(next);
  const [denial, setDenial] = useState({
    identity,
    denied: false,
  });
  if (denial.identity !== identity)
    setDenial({
      identity,
      denied: false,
    });
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
      previous.identity === identity
        ? {
            identity,
            denied: true,
          }
        : previous,
    );
    void client.cancelQueries({
      queryKey: [...evaluationQueryRoot, session],
    });
    client.removeQueries({
      queryKey: [...evaluationQueryRoot, session],
    });
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
    if (!readable)
      void client.cancelQueries({
        queryKey: [...evaluationQueryRoot, session],
      });
    return () => {
      void client.cancelQueries({
        queryKey: [...evaluationQueryRoot, session],
      });
    };
  }, [client, session, readable]);
  useEffect(
    () => () => {
      client.removeQueries({
        queryKey: [...evaluationQueryRoot, session],
      });
    },
    [client, session],
  );
  const refreshAccess = async () => {
    await access.refresh();
    await scope.refresh();
    setDenial((previous) =>
      previous.identity === identity
        ? {
            identity,
            denied: false,
          }
        : previous,
    );
  };
  const header = (
    <>
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
          <Button loading={access.checking} onClick={() => void refreshAccess()} variant="outlined">
            Refresh access
          </Button>
        }
      />
    </>
  );
  if (access.identityKey[0] === "sample")
    return (
      <section className="evaluations-page">
        {header}
        <Alert severity={"info"}>
          <AlertTitle>{"A connected server is required"}</AlertTitle>
          {
            "Evaluation management is unavailable in sample mode. Sources, drafts, publications, and batches are not simulated."
          }
        </Alert>
      </section>
    );
  if (forbidden)
    return (
      <section className="evaluations-page">
        {header}
        <Alert
          action={
            <Button onClick={() => void refreshAccess()} variant="outlined">
              Verify access
            </Button>
          }
          severity={"info"}
        >
          <AlertTitle>{"Evaluation access is unavailable"}</AlertTitle>
          {
            "Previous editor content and pending requests have been cleared. Verify repository access to continue."
          }
        </Alert>
      </section>
    );
  if (scope.ready && !scope.repositoryId)
    return (
      <section className="evaluations-page">
        {header}
        <Card variant="outlined">
          <CardContent>
            <EmptyState title={"Select a repository in the sidebar to manage frozen examples."} />
          </CardContent>
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
              <Stack
                className="evaluation-access-notice"
                direction="column"
                spacing={1.5}
                sx={{
                  minWidth: 0,
                }}
              >
                <Skeleton variant="rounded" height={72} aria-label="Loading evaluation content" />
                <Alert
                  action={
                    <Button onClick={() => void refreshAccess()} variant="outlined">
                      Verify access
                    </Button>
                  }
                  severity={access.error ? "warning" : "info"}
                >
                  <AlertTitle>
                    {access.error ? "Access could not be verified" : "Checking access"}
                  </AlertTitle>
                  {
                    "Editors and original pending requests are preserved while this same scope is verified."
                  }
                </Alert>
              </Stack>
            ) : null}
            <div hidden={!readable} inert={!readable} aria-hidden={!readable}>
              <>
                <RepositoryContent />
              </>
            </div>
          </EvaluationContext.Provider>
        ) : (
          <Skeleton variant="rounded" height={120} aria-label="Loading evaluation content" />
        )}
      </ConfigurationScopeGuard>
    </section>
  );
}
