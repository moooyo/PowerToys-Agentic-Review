import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceAssetMetadata } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  evidenceFileIdentity,
  inspectEvidenceFile,
  inspectEvidenceRoot,
  probeEvidenceIdentities,
  ReadonlyEvidenceDirectory,
  verifyEvidenceAsset,
} from "./evidence-files.js";
import {
  type AssetVerificationSnapshot,
  evidenceSnapshotDigest,
  type ScenarioVerificationSnapshot,
} from "./evidence-verification-protocol.js";
import { verifyEvidenceScenario } from "./evidence-verification-worker.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const tests = describe.skipIf(process.platform !== "linux");
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "evidence-verification-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  const storageKey = randomUUID().replaceAll("-", "");
  await writeFile(join(directory, `.owner-${storageKey}`), "", { mode: 0o600 });
  const root = await inspectEvidenceRoot(directory, storageKey);
  const storage = { storageKey, device: root.device, inode: root.inode };
  async function asset(
    bytes = Buffer.from("evidence"),
    kind: EvidenceAssetMetadata["kind"] = "log",
    state: "uploading" | "finalized" = "finalized",
  ): Promise<AssetVerificationSnapshot> {
    const id = randomUUID();
    const path = join(directory, `${id}.${state === "uploading" ? "upload" : "asset"}`);
    await writeFile(path, bytes, { mode: 0o600 });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const metadata = {
      kind,
      mediaType:
        kind === "screenshot"
          ? "image/png"
          : kind === "steps"
            ? "application/json"
            : kind === "trace"
              ? "application/zip"
              : "text/plain",
      sizeBytes: bytes.length,
      sha256,
      capturedAt: "2026-09-07T00:00:00.000Z",
      checkId: "profile:settings",
    } as EvidenceAssetMetadata;
    const described: AssetVerificationSnapshot["asset"] = {
      id,
      state,
      scope: {
        repositoryId: "repo",
        runId: "run",
        requestId: "request",
        jobId: "job",
        runAttemptId: "attempt",
        profileVersionId: "profile",
        revisionKey: "a".repeat(64),
        planDigest: "b".repeat(64),
        checkId: "profile:settings",
      },
      metadata,
    };
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 524288) {
      const chunk = bytes.subarray(offset, offset + 524288);
      chunks.push({
        offset,
        sizeBytes: chunk.length,
        sha256: createHash("sha256").update(chunk).digest("hex"),
      });
    }
    return {
      storage,
      asset: described,
      manifestDigest: evidenceSnapshotDigest(described),
      expectedFile: evidenceFileIdentity(await lstat(path, { bigint: true })),
      chunks,
    };
  }
  return { directory, root, storage, asset, signal: new AbortController().signal };
}

tests("read-only evidence files", () => {
  it("verifies bounded chunks without changing directory entries or file identity", async () => {
    const f = await fixture();
    const value = await f.asset(Buffer.alloc(524305, 17));
    const before = await readdir(f.directory);
    const proof = await verifyEvidenceAsset(f.root, value, f.signal);
    expect(proof.attestation.sha256).toBe(value.asset.metadata.sha256);
    expect(proof.attestation.before).toEqual(proof.attestation.after);
    expect(proof.bytes).toBeUndefined();
    expect(await readdir(f.directory)).toEqual(before);
    expect(
      await inspectEvidenceFile(f.root, {
        assetId: value.asset.id,
        state: value.asset.state,
        device: value.expectedFile.device,
        inode: value.expectedFile.inode,
        sizeBytes: value.expectedFile.sizeBytes,
      }),
    ).toEqual(value.expectedFile);
  });
  it("does not initialize a missing read-only root", async () => {
    const f = await fixture();
    const missing = join(f.directory, "missing");
    await expect(inspectEvidenceRoot(missing, f.storage.storageKey)).rejects.toMatchObject({
      code: "EVIDENCE_FILE_UNAVAILABLE",
    });
    await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not mistake matching timestamp metadata for verified bytes", async () => {
    const f = await fixture();
    const value = await f.asset();
    const path = join(f.directory, `${value.asset.id}.asset`);
    await writeFile(path, "modified");
    const probe = await probeEvidenceIdentities(
      f.root,
      {
        storage: f.storage,
        assets: [
          { assetId: value.asset.id, state: value.asset.state, expectedFile: value.expectedFile },
        ],
      },
      f.signal,
    );
    // Same-tick writes can retain both timestamps. A probe reports metadata, not content truth.
    expect(probe.matches).toBe(
      JSON.stringify(probe.assets[0]?.after) === JSON.stringify(value.expectedFile),
    );
    await expect(verifyEvidenceAsset(f.root, value, f.signal)).rejects.toThrow(
      /EVIDENCE_(FILE_CHANGED|INTEGRITY_FAILED)/u,
    );
    value.expectedFile = evidenceFileIdentity(await lstat(path, { bigint: true }));
    await expect(verifyEvidenceAsset(f.root, value, f.signal)).rejects.toMatchObject({
      code: "EVIDENCE_INTEGRITY_FAILED",
    });
  });
  it.each(["symlink", "hardlink", "permission", "replacement", "missing", "size"])(
    "rejects unsafe file state: %s",
    async (kind) => {
      const f = await fixture();
      const value = await f.asset();
      const path = join(f.directory, `${value.asset.id}.asset`);
      if (kind === "symlink") {
        await rename(path, `${path}.old`);
        await symlink(`${path}.old`, path);
      }
      if (kind === "hardlink") await link(path, `${path}.link`);
      if (kind === "permission") await chmod(path, 0o644);
      if (kind === "replacement") {
        await rename(path, `${path}.old`);
        await writeFile(path, "evidence", { mode: 0o600 });
      }
      if (kind === "missing") await unlink(path);
      if (kind === "size") await writeFile(path, "x");
      await expect(verifyEvidenceAsset(f.root, value, f.signal)).rejects.toThrow(/EVIDENCE_FILE_/u);
    },
  );
  it("rejects a renamed root even with an open descriptor", async () => {
    const f = await fixture();
    const value = await f.asset();
    const directory = await ReadonlyEvidenceDirectory.open(f.root);
    const opened = await directory.openAsset({
      assetId: value.asset.id,
      state: value.asset.state,
      expectedFile: value.expectedFile,
    });
    try {
      const moved = `${f.directory}-moved`;
      directories.push(moved);
      await rename(f.directory, moved);
      await symlink(moved, f.directory);
      await expect(directory.after(opened)).rejects.toMatchObject({
        code: "EVIDENCE_FILE_CHANGED",
      });
    } finally {
      await opened.handle.close();
      await directory.close();
    }
  });
  it("rejects a different storage key and mismatched scope digest", async () => {
    const f = await fixture();
    const value = await f.asset();
    await expect(inspectEvidenceRoot(f.directory, "f".repeat(32))).rejects.toMatchObject({
      code: "EVIDENCE_FILE_UNAVAILABLE",
    });
    value.asset.scope.repositoryId = "other";
    await expect(verifyEvidenceAsset(f.root, value, f.signal)).rejects.toMatchObject({
      code: "EVIDENCE_INVALID_SNAPSHOT",
    });
  });
  it("verifies rename-before-commit recovery only for the original inode", async () => {
    const f = await fixture();
    const value = await f.asset(Buffer.from("evidence"), "log", "uploading");
    await rename(
      join(f.directory, `${value.asset.id}.upload`),
      join(f.directory, `${value.asset.id}.asset`),
    );
    value.expectedFile = await inspectEvidenceFile(f.root, {
      assetId: value.asset.id,
      state: "uploading",
      device: value.expectedFile.device,
      inode: value.expectedFile.inode,
      sizeBytes: value.expectedFile.sizeBytes,
    });
    expect((await verifyEvidenceAsset(f.root, value, f.signal)).attestation.assetId).toBe(
      value.asset.id,
    );
  });
  it("honors cancellation and never collects whole trace payloads", async () => {
    const f = await fixture();
    const value = await f.asset();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(verifyEvidenceAsset(f.root, value, cancelled.signal)).rejects.toMatchObject({
      code: "EVIDENCE_VERIFIER_CANCELLED",
    });
    await expect(verifyEvidenceAsset(f.root, value, f.signal, true)).rejects.toMatchObject({
      code: "EVIDENCE_INVALID_SNAPSHOT",
    });
  });
});

async function scenarioFixture(target: "web" | "windows_desktop") {
  const f = await fixture();
  const image = await f.asset(Buffer.from("trusted producer screenshot"), "screenshot");
  const trace = await f.asset(Buffer.from("trusted producer trace"), "trace");
  const execution = {
    schemaVersion: "UiScenarioExecutionEvidenceV1",
    source: "ui_driver",
    scenarioId: "settings",
    target,
    steps: [
      {
        stepId: "visible",
        name: "Visible",
        action: "assertVisible",
        expected: true,
        actual: true,
        outcome: "passed",
        summary: "The setting is visible.",
        evidenceIds: [image.asset.id],
      },
    ],
  };
  const steps = await f.asset(Buffer.from(JSON.stringify(execution)), "steps");
  const common = {
    storage: f.storage,
    resultDigest: "d".repeat(64),
    steps,
    checkOutcome: "passed" as const,
    dependencies: [image, ...(target === "web" ? [trace] : [])].map((item) => ({
      asset: item.asset,
      manifestDigest: item.manifestDigest,
      expectedFile: item.expectedFile,
    })),
  };
  const scenario = { id: "settings", name: "Settings", required: true, timeoutMs: 1000 };
  const step = {
    id: "visible",
    name: "Visible",
    action: "assertVisible" as const,
    expected: true,
    timeoutMs: 100,
  };
  const snapshot: ScenarioVerificationSnapshot =
    target === "web"
      ? {
          ...common,
          target,
          scenario: {
            ...scenario,
            path: "/",
            steps: [{ ...step, locator: { by: "testId", testId: "settings" } }],
          },
          policy: {
            screenshots: "every_assertion",
            screenshotScope: "viewport",
            trace: "always",
            required: true,
          },
        }
      : {
          ...common,
          target,
          scenario: {
            ...scenario,
            steps: [{ ...step, locator: { by: "automationId", automationId: "settings" } }],
          },
          policy: {
            screenshots: "every_assertion",
            screenshotScope: "owned_window",
            required: true,
          },
        };
  return { ...f, snapshot, execution };
}
tests("isolated scenario evidence semantics", () => {
  it.each(["web", "windows_desktop"] as const)(
    "accepts complete %s step evidence",
    async (target) => {
      const f = await scenarioFixture(target);
      const proof = await verifyEvidenceScenario(f.root, f.snapshot, f.signal);
      expect(proof.kind).toBe("scenario_verified");
      expect(proof.observed.length).toBe(f.snapshot.dependencies.length + 1);
    },
  );
  it.each(["expected", "name", "scenario", "missing_screenshot", "cross_check", "trace"])(
    "rejects semantic mismatch: %s",
    async (kind) => {
      const f = await scenarioFixture("web");
      if (kind === "expected")
        f.snapshot.scenario.steps[0] = {
          ...required(f.snapshot.scenario.steps[0]),
          action: "assertVisible",
          expected: false,
        };
      if (kind === "name") required(f.snapshot.scenario.steps[0]).name = "Different step";
      if (kind === "scenario") f.snapshot.scenario.id = "different";
      if (kind === "missing_screenshot")
        f.snapshot.dependencies = f.snapshot.dependencies.filter(
          (item) => item.asset.metadata.kind !== "screenshot",
        );
      if (kind === "trace")
        f.snapshot.dependencies = f.snapshot.dependencies.filter(
          (item) => item.asset.metadata.kind !== "trace",
        );
      if (kind === "cross_check") {
        required(f.snapshot.dependencies[0]).asset.scope.checkId = "profile:other";
        required(f.snapshot.dependencies[0]).manifestDigest = evidenceSnapshotDigest(
          required(f.snapshot.dependencies[0]).asset,
        );
      }
      await expect(verifyEvidenceScenario(f.root, f.snapshot, f.signal)).rejects.toThrow(
        /EVIDENCE_(SCENARIO_MISMATCH|INVALID_SNAPSHOT)/u,
      );
    },
  );
  it("does not accept changed structured steps under an old manifest", async () => {
    const f = await scenarioFixture("web");
    const path = join(f.directory, `${f.snapshot.steps.asset.id}.asset`);
    await writeFile(path, Buffer.alloc(f.snapshot.steps.expectedFile.sizeBytes));
    f.snapshot.steps.expectedFile = evidenceFileIdentity(await lstat(path, { bigint: true }));
    await expect(verifyEvidenceScenario(f.root, f.snapshot, f.signal)).rejects.toMatchObject({
      code: "EVIDENCE_INTEGRITY_FAILED",
    });
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture.");
  return value;
}
