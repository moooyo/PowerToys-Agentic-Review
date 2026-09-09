import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evidenceFileIdentity, inspectEvidenceRoot } from "./evidence-files.js";
import { attachEvidenceVerifierForTest } from "./evidence-verification-client.js";
import {
  type AssetVerificationSnapshot,
  evidenceSnapshotDigest,
  type ScenarioVerificationSnapshot,
} from "./evidence-verification-protocol.js";

describe.skipIf(process.platform !== "linux")("dedicated read-only evidence Worker", () => {
  let scratch: string;
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "evidence-verifier-worker-test-"));
    await writeFile(join(scratch, "package.json"), '{"type":"module"}');
    const source = dirname(fileURLToPath(import.meta.url));
    const compiler = join(
      dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))),
      "bin",
      "tsc",
    );
    execFileSync(
      process.execPath,
      [
        compiler,
        "--ignoreConfig",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2024",
        "--skipLibCheck",
        "--strict",
        "--types",
        "node",
        "--outDir",
        join(scratch, "compiled"),
        "--rootDir",
        join(source, ".."),
        ...[
          "evidence-files.ts",
          "evidence-verification-protocol.ts",
          "evidence-verification-worker.ts",
        ].map((name) => join(source, name)),
      ],
      { cwd: source, timeout: 30000, maxBuffer: 512 * 1024 },
    );
    // Reuse installed dependencies read-only; this fixture never installs or copies packages.
    await symlink(join(source, "..", "..", "node_modules"), join(scratch, "node_modules"), "dir");
  }, 35000);
  afterAll(async () => {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  });
  it("verifies through a real isolated thread and re-probes cached identity", async () => {
    const directory = await mkdtemp(join(scratch, "private-"));
    await chmod(directory, 0o700);
    const storageKey = randomUUID().replaceAll("-", "");
    await writeFile(join(directory, `.owner-${storageKey}`), "", { mode: 0o600 });
    const root = await inspectEvidenceRoot(directory, storageKey);
    const bytes = Buffer.alloc(524288 + 7, 23);
    const id = randomUUID();
    const path = join(directory, `${id}.asset`);
    await writeFile(path, bytes, { mode: 0o600 });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const asset: AssetVerificationSnapshot["asset"] = {
      id,
      state: "finalized",
      scope: {
        repositoryId: "repo",
        runId: "run",
        requestId: "request",
        jobId: "job",
        runAttemptId: "attempt",
        profileVersionId: "profile",
        revisionKey: "a".repeat(64),
        planDigest: "b".repeat(64),
        checkId: "profile:check",
      },
      metadata: {
        kind: "log",
        mediaType: "text/plain",
        capturedAt: "2026-09-07T00:00:00.000Z",
        sizeBytes: bytes.length,
        sha256,
        checkId: "profile:check",
      },
    };
    const snapshot: AssetVerificationSnapshot = {
      storage: { storageKey, device: root.device, inode: root.inode },
      asset,
      manifestDigest: evidenceSnapshotDigest(asset),
      expectedFile: evidenceFileIdentity(await lstat(path, { bigint: true })),
      chunks: [0, 524288].map((offset) => {
        const part = bytes.subarray(offset, offset + 524288);
        return {
          offset,
          sizeBytes: part.length,
          sha256: createHash("sha256").update(part).digest("hex"),
        };
      }),
    };
    const transport = new Worker(
      join(scratch, "compiled", "database", "evidence-verification-worker.js"),
      {
        workerData: root,
      },
    );
    const client = attachEvidenceVerifierForTest(transport, {
      storageRoot: root,
      operationTimeoutMs: 5000,
      closeTimeoutMs: 1000,
    });
    const signal = new AbortController().signal;
    try {
      let verified = false;
      const pending = client.verifyAsset(snapshot, signal).then((proof) => {
        verified = true;
        return proof;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(verified).toBe(false);
      const proof = await pending;
      expect(proof.sha256).toBe(sha256);
      expect(JSON.stringify(proof)).not.toContain(directory);
      expect(client.peekAssetAttestation(snapshot)).toEqual(
        proof.verification.reusable ? proof : null,
      );
      expect((await client.verifyAsset(snapshot, signal)).sha256).toBe(proof.sha256);
      await writeFile(path, Buffer.alloc(bytes.length, 24));
      await expect(client.verifyAsset(snapshot, signal)).rejects.toThrow(
        /EVIDENCE_(FILE_CHANGED|INTEGRITY_FAILED)/u,
      );
      expect(client.peekAssetAttestation(snapshot)).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("transports only selected failed assertion facts through the fixed Worker", async () => {
    const directory = await mkdtemp(join(scratch, "observations-"));
    await chmod(directory, 0o700);
    const storageKey = randomUUID().replaceAll("-", "");
    await writeFile(join(directory, `.owner-${storageKey}`), "", { mode: 0o600 });
    const root = await inspectEvidenceRoot(directory, storageKey);
    const storage = { storageKey, device: root.device, inode: root.inode };
    const scope = {
      repositoryId: "repo",
      runId: "run",
      requestId: "request",
      jobId: "job",
      runAttemptId: "attempt",
      profileVersionId: "profile",
      revisionKey: "a".repeat(64),
      planDigest: "b".repeat(64),
      checkId: "profile:settings",
    };
    const writeAsset = async (
      bytes: Buffer,
      kind: "steps" | "screenshot",
    ): Promise<AssetVerificationSnapshot> => {
      const id = randomUUID();
      const path = join(directory, `${id}.asset`);
      await writeFile(path, bytes, { mode: 0o600 });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const asset: AssetVerificationSnapshot["asset"] = {
        id,
        state: "finalized",
        scope,
        metadata: {
          ...(kind === "steps"
            ? { kind, mediaType: "application/json" as const }
            : { kind, mediaType: "image/png" as const }),
          capturedAt: "2026-09-07T00:00:00.000Z",
          sizeBytes: bytes.length,
          sha256,
          checkId: scope.checkId,
        },
      };
      return {
        storage,
        asset,
        manifestDigest: evidenceSnapshotDigest(asset),
        expectedFile: evidenceFileIdentity(await lstat(path, { bigint: true })),
        chunks: [{ offset: 0, sizeBytes: bytes.length, sha256 }],
      };
    };
    const screenshot = await writeAsset(Buffer.from("trusted producer screenshot"), "screenshot");
    const steps = await writeAsset(
      Buffer.from(
        JSON.stringify({
          schemaVersion: "UiScenarioExecutionEvidenceV1",
          source: "ui_driver",
          scenarioId: "settings",
          target: "web",
          steps: [
            {
              stepId: "status",
              name: "Status",
              action: "assertText",
              expected: "Ready",
              actual: "Duplicate",
              outcome: "failed",
              summary: "Private failure diagnostic canary",
              evidenceIds: [screenshot.asset.id],
              capture: { schemaVersion: "UiAssertionCaptureV1", state: "complete" },
            },
            {
              stepId: "later",
              name: "Later",
              action: "assertText",
              expected: "Private expected canary",
              actual: null,
              outcome: "not_run",
              summary: "Private later summary canary",
              evidenceIds: [],
              capture: {
                schemaVersion: "UiAssertionCaptureV1",
                state: "unavailable",
                reason: "not_run",
              },
            },
          ],
        }),
      ),
      "steps",
    );
    const snapshot: ScenarioVerificationSnapshot = {
      storage,
      resultDigest: "d".repeat(64),
      steps,
      checkOutcome: "failed",
      target: "web",
      observationSelection: { schemaVersion: "UiObservationSelectionV1", stepIds: ["status"] },
      dependencies: [
        {
          asset: screenshot.asset,
          manifestDigest: screenshot.manifestDigest,
          expectedFile: screenshot.expectedFile,
        },
      ],
      scenario: {
        id: "settings",
        name: "Settings",
        required: true,
        timeoutMs: 1000,
        path: "/",
        steps: [
          {
            id: "status",
            name: "Status",
            action: "assertText",
            match: "exact",
            expected: "Ready",
            timeoutMs: 100,
            locator: { by: "testId", testId: "status" },
          },
          {
            id: "later",
            name: "Later",
            action: "assertText",
            match: "exact",
            expected: "Private expected canary",
            timeoutMs: 100,
            locator: { by: "testId", testId: "later" },
          },
        ],
      },
      policy: {
        screenshots: "every_assertion",
        screenshotScope: "viewport",
        trace: "off",
        required: true,
      },
    };
    const transport = new Worker(
      join(scratch, "compiled", "database", "evidence-verification-worker.js"),
      {
        workerData: root,
      },
    );
    const client = attachEvidenceVerifierForTest(transport, {
      storageRoot: root,
      operationTimeoutMs: 5000,
      closeTimeoutMs: 1000,
    });
    try {
      const proof = await client.verifyScenario(snapshot, new AbortController().signal);
      expect(proof.observations).toEqual([
        {
          observation: { kind: "ui_assertion", scenarioId: "settings", stepId: "status" },
          checkId: "profile:settings",
          evidenceIds: [steps.asset.id, screenshot.asset.id],
          state: "observed",
          value: { type: "string", value: "Duplicate" },
        },
      ]);
      expect(JSON.stringify(proof)).not.toContain("canary");
      expect(JSON.stringify(proof)).not.toContain(directory);
      expect(proof.observed.map((item) => item.assetId)).toEqual([
        steps.asset.id,
        screenshot.asset.id,
      ]);
    } finally {
      await client.close();
    }
  });
});
