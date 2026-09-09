import type * as C from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { bindOperatorDatabase } from "../../dist/database/operator-database.js";
import {
  createEvidenceControlPlaneFixture,
  type EvidenceControlPlaneFixture,
} from "./evidence-control-plane.testing.js";

const administrator: C.OperatorPrincipal = {
  issuer: "https://identity.example.test",
  subject: "adjudication-administrator",
};
const member: C.OperatorPrincipal = {
  issuer: administrator.issuer,
  subject: "adjudication-reviewer",
};
const fixtures: EvidenceControlPlaneFixture[] = [];
afterEach(async () => {
  const outcomes = await Promise.allSettled(fixtures.splice(0).map((fixture) => fixture.dispose()));
  const errors = outcomes.filter((outcome) => outcome.status === "rejected");
  if (errors.length)
    throw new AggregateError(
      errors.map((outcome) => outcome.reason),
      "Adjudication owner cleanup failed.",
    );
});

describe.skipIf(process.platform !== "linux")(
  "evaluation adjudication owner RPC boundaries",
  () => {
    it("enforces read and review independently across role changes and owner recovery", async () => {
      let recovery = false;
      const fixture = await createEvidenceControlPlaneFixture(1, [administrator], {
        createClient: (options) =>
          DatabaseClient.create({ ...options, recoveryMaintenance: recovery }),
      });
      fixtures.push(fixture);
      const repositoryId = fixture.run.repositoryId;
      const scope: C.EvaluationCellResultReadQuery = {
        repositoryId,
        evaluationId: "missing-evaluation",
        cellId: "missing-cell",
        resultId: "missing-result",
      };
      const occurrence = { ...scope, occurrenceKey: "a".repeat(64) };
      const change: C.EvaluationAdjudicationChangeRequest = {
        changeId: "new-judgment",
        expectedVersion: 0,
        resultDigest: "b".repeat(64),
        judgment: {
          kind: "unjudged",
          reason: "Exercise only the authenticated persistence boundary.",
        },
      };
      const operator = () => bindOperatorDatabase(fixture.client, member);
      let grantVersion = 0;
      const grant = (role: C.OperatorRepositoryRole | null) =>
        bindOperatorDatabase(fixture.client, administrator).request("changeRepositoryAccess", {
          repositoryId,
          actor: administrator,
          request: {
            changeId: `adjudication-grant-${grantVersion}`,
            expectedVersion: grantVersion++,
            principal: member,
            role,
            reason: "Exercise current adjudication permissions through the real owner.",
          },
        });
      const read = () =>
        operator().request("getEvaluationAdjudicationContext", { ...scope, actor: member });
      const history = () =>
        operator().request("listEvaluationAdjudicationHistory", {
          ...occurrence,
          actor: member,
          query: { page: 1, pageSize: 20 },
        });
      const write = (replayOnly?: true) =>
        operator().request("changeEvaluationAdjudication", {
          ...occurrence,
          actor: member,
          request: change,
          ...(replayOnly === undefined ? {} : { replayOnly }),
        });

      await expect(read()).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
      await expect(write()).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
      await grant("viewer");
      await expect(read()).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
      await expect(history()).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
      await expect(write()).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
      await expect(
        operator().request("getEvaluationAdjudicationContext", {
          ...scope,
          resultId: "invalid/result",
          actor: member,
        }),
      ).rejects.toMatchObject({ code: "PLATFORM_INVALID" });

      await grant("reviewer");
      await expect(write()).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
      await expect(
        operator().request("operatorCheckPermission", { repositoryId, permission: "configure" }),
      ).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
      await expect(
        operator().request("changeEvaluationAdjudication", {
          ...occurrence,
          actor: administrator,
          request: change,
        }),
      ).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
      await expect(
        operator().request("listEvaluationAdjudicationHistory", {
          ...occurrence,
          actor: member,
          query: { page: 1, pageSize: 51 },
        }),
      ).rejects.toMatchObject({ code: "PLATFORM_INVALID" });
      await expect(write(true)).rejects.toMatchObject({ code: "DATABASE_READ_ONLY" });

      recovery = true;
      await fixture.restart();
      await expect(read()).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
      await expect(write()).rejects.toMatchObject({ code: "DATABASE_READ_ONLY" });
      recovery = false;
      await fixture.restart();
      await grant(null);
      await expect(read()).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
      await expect(history()).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
      await expect(write(true)).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
      expect(
        fixture.read((database) =>
          database
            .prepare(
              "SELECT (SELECT COUNT(*) FROM evaluation_adjudication_events) AS events, (SELECT COUNT(*) FROM evaluation_mutation_receipts WHERE operation = 'finding_adjudicated') AS receipts",
            )
            .get(),
        ),
      ).toEqual({ events: 0, receipts: 0 });
    });
  },
);
