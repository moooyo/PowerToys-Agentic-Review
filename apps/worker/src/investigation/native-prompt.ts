import {
  buildNativePromptInstructions,
  type InvestigationNativePromptContent,
  InvestigationNativePromptSnapshotSchema,
  type InvestigationTaskV1,
  type NativePromptRuntimeOptions,
  nativePromptBuiltInContent,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";

/** The task carries its immutable content; workers never resolve a mutable current binding. */
export function renderNativePromptInstructions(
  task: InvestigationTaskV1,
  mode: keyof InvestigationNativePromptContent,
  options: Omit<NativePromptRuntimeOptions, "kind" | "snapshotOnly" | "analysisTask">,
): string {
  const managed = task.kind === "pr-review" || task.kind === "issue-investigate";
  const snapshot = task.promptSnapshot;
  if (
    snapshot !== undefined &&
    (!managed ||
      !Value.Check(InvestigationNativePromptSnapshotSchema, snapshot) ||
      snapshot.kind !== task.kind ||
      snapshot.ref.id !== task.promptRef.id ||
      snapshot.ref.version !== task.promptRef.version ||
      snapshot.ref.digest !== task.promptRef.digest ||
      investigationContentDigest(snapshot.content) !== snapshot.ref.digest)
  ) {
    throw new Error("The frozen native prompt content does not match the task prompt reference.");
  }
  // Historical tasks lack frozen content. Their old reference is not a catalog content identity.
  const fallback = nativePromptBuiltInContent(
    task.kind === "issue-investigate" ? "issue-investigate" : "pr-review",
  );
  const content =
    snapshot?.content ??
    (managed
      ? fallback
      : {
          localCheckout: fallback.localCheckout.replace(/^#[^\n]+\n\n/u, ""),
          snapshot: fallback.snapshot.replace(/^#[^\n]+\n\n/u, ""),
        });
  return buildNativePromptInstructions(content, mode, {
    ...options,
    kind: task.kind,
    analysisTask: managed,
    snapshotOnly: task.executionPolicy.mode === "snapshot_only",
  });
}
