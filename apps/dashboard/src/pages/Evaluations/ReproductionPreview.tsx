import type * as C from "@agentic-review/contracts";
import { Alert, AlertTitle, Button, Chip, Stack, Typography } from "@mui/material";
import { useEffect, useRef } from "react";
import type { EvaluationReproductionAdapter } from "@/services/evaluation-reproduction";
import { type Arm, armLabels, arms } from "./batch-state";
import { useEvaluationPage, useEvaluationQuery } from "./context";
import {
  assertReproductionPreview,
  type ReproductionDraft,
  reproductionPreviewKey,
} from "./reproduction-state";
import { errorMessage } from "./state";
export function ReproductionPreviewResult({ value }: { value: C.EvaluationReproductionPreviewV1 }) {
  return (
    <Stack
      style={{
        width: "100%",
      }}
      direction="column"
      spacing={1.5}
      sx={{
        minWidth: 0,
      }}
    >
      {arms.map((arm) => (
        <div key={arm}>
          <Typography
            component="span"
            variant="body2"
            sx={{
              fontWeight: 500,
            }}
          >
            {armLabels[arm]}
          </Typography>{" "}
          <Chip
            label={
              value[arm].state === "ready"
                ? "Mapping ready"
                : value[arm].state === "blocked"
                  ? "Mapping blocked"
                  : "Not applicable"
            }
            color={value[arm].state === "blocked" ? "warning" : "default"}
          />
          {value[arm].blockers.length ? (
            <ul>
              {[
                ...new Map(
                  value[arm].blockers.map((blocker) => [
                    JSON.stringify([blocker.code, blocker.message]),
                    blocker,
                  ]),
                ).entries(),
              ].map(([key, blocker]) => (
                <li key={key}>{blocker.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
      <Typography component="p" variant="body2" color={"text.secondary"}>
        This preview checks your choices without running validation. Creating the batch rechecks the
        original source and selected profiles.
      </Typography>
    </Stack>
  );
}
export function ReproductionPreview({
  api,
  request,
  sourceDefinitionSha256,
  profiles,
  disabled,
  onPreview,
}: {
  api: EvaluationReproductionAdapter;
  request: C.EvaluationReproductionPreviewRequest;
  sourceDefinitionSha256: string;
  profiles: Record<Arm, C.ValidationProfileVersion>;
  disabled: boolean;
  onPreview: (value: ReproductionDraft["preview"] | null) => void;
}) {
  const page = useEvaluationPage();
  const key = reproductionPreviewKey(request, sourceDefinitionSha256, profiles);
  const current = useRef({
    key,
    allowed: false,
  });
  if (current.current.key !== key) {
    current.current.allowed = false;
    current.current = {
      key,
      allowed: false,
    };
  }
  current.current.allowed = !disabled && page.canConfigure;
  useEffect(() => {
    const binding = current.current;
    binding.allowed = binding.key === key && !disabled && page.canConfigure;
    return () => {
      binding.allowed = false;
    };
  }, [disabled, page.canConfigure, key]);
  const query = useEvaluationQuery(
    ["reproduction-mapping-preview", page.repositoryId, request.sourceId, key],
    async (signal) => {
      const value = await api.preview(page.repositoryId, request, signal);
      assertReproductionPreview(value, request, sourceDefinitionSha256, profiles);
      return value;
    },
    false,
  );
  const preview = async () => {
    const binding = current.current;
    if (!binding.allowed || query.isFetching) return;
    onPreview(null);
    const result = await query.refetch();
    if (
      current.current === binding &&
      binding.key === key &&
      binding.allowed &&
      !result.isError &&
      result.data
    )
      onPreview({
        key,
        value: result.data,
      });
  };
  return (
    <div
      style={{
        marginTop: 16,
      }}
    >
      <Button
        disabled={disabled || !page.canConfigure}
        loading={query.isFetching}
        onClick={() => void preview()}
        aria-label={`Preview reproduction mapping for ${request.selection.caseId}`}
        variant="outlined"
      >
        Preview reproduction mapping
      </Button>
      {query.error ? (
        <Alert severity={"error"}>
          <AlertTitle>{"Mapping preview unavailable"}</AlertTitle>
          {errorMessage(query.error)}
        </Alert>
      ) : null}
      {query.data && !query.isFetching ? (
        <ReproductionPreviewResult value={query.data} />
      ) : (
        <Typography component="p" variant="body2" color={"text.secondary"}>
          Preview the current choices before creating the batch. Any source, case or profile change
          requires a new preview.
        </Typography>
      )}
    </div>
  );
}
