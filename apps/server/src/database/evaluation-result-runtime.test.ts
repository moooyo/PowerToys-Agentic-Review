import type { OperatorPrincipal } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { bindOperatorDatabase } from "../../dist/database/operator-database.js";
import {
  createEvidenceControlPlaneFixture,
  type EvidenceControlPlaneFixture,
} from "./evidence-control-plane.testing.js";

const administrator: OperatorPrincipal = {
  issuer: "https://identity.example.test",
  subject: "evaluation-result-administrator",
};
const reader: OperatorPrincipal = {
  issuer: administrator.issuer,
  subject: "evaluation-result-reader",
};
const fixtures: EvidenceControlPlaneFixture[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(fixtures.splice(0).map((fixture) => fixture.dispose()));
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Evaluation result runtime cleanup failed.",
    );
});

describe.skipIf(process.platform !== "linux")(
  "evaluation result RPC through the real database owner",
  () => {
    it("requires current repository read permission before reaching the explicit result selector", async () => {
      const fixture = await createEvidenceControlPlaneFixture(1, [administrator]);
      fixtures.push(fixture);
      const repositoryId = fixture.run.repositoryId;
      const admin = bindOperatorDatabase(fixture.client, administrator);
      const viewer = bindOperatorDatabase(fixture.client, reader);
      const selection = {
        repositoryId,
        evaluationId: "missing-evaluation",
        cellId: "missing-cell",
        resultId: "missing-result",
        actor: reader,
      };
      const malformed = { ...selection, resultId: "invalid/result" };
      await expect(viewer.request("getEvaluationCellResult", malformed)).rejects.toMatchObject({
        code: "PLATFORM_NOT_FOUND",
      });
      await admin.request("changeRepositoryAccess", {
        repositoryId,
        actor: administrator,
        request: {
          changeId: "grant-evaluation-result-reader",
          expectedVersion: 0,
          principal: reader,
          role: "viewer",
          reason: "Exercise the evaluation result read boundary.",
        },
      });
      expect(
        await viewer.request("operatorCheckPermission", { repositoryId, permission: "read" }),
      ).toEqual({ authorized: true });
      await expect(viewer.request("getEvaluationCellResult", malformed)).rejects.toMatchObject({
        code: "PLATFORM_INVALID",
      });
      await expect(viewer.request("getEvaluationCellResult", selection)).rejects.toMatchObject({
        code: "PLATFORM_NOT_FOUND",
      });
      await expect(
        viewer.request("getEvaluationCellResult", { ...selection, actor: administrator }),
      ).rejects.toMatchObject({
        code: "PLATFORM_FORBIDDEN",
      });
      await expect(
        viewer.request("getEvaluationCellResult", {
          ...selection,
          repositoryId: "foreign-repository",
        }),
      ).rejects.toMatchObject({
        code: "PLATFORM_NOT_FOUND",
      });
      await admin.request("changeRepositoryAccess", {
        repositoryId,
        actor: administrator,
        request: {
          changeId: "revoke-evaluation-result-reader",
          expectedVersion: 1,
          principal: reader,
          role: null,
          reason: "Require the next result read to recheck current access.",
        },
      });
      await expect(viewer.request("getEvaluationCellResult", malformed)).rejects.toMatchObject({
        code: "PLATFORM_NOT_FOUND",
      });
    });
  },
);
