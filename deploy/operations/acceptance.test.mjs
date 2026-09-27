import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acceptanceTemplate, summarizeAcceptance } from "./acceptance.mjs";

const catalogs = [
  {
    schemaVersion: 1,
    scenarios: [{ id: "fixture", requiredEvidenceKinds: ["native_report", "cleanup_receipt"] }],
  },
];
const revision = "a".repeat(40);

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "operations-evidence-"));
  try {
    const content = "Synthetic evidence; not an application observation.\n";
    await writeFile(join(root, "receipt.json"), content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const packet = acceptanceTemplate(catalogs, revision);
    Object.assign(packet.results[0], {
      status: "passed",
      runId: "fixture-run",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:01:00Z",
      evidence: ["native_report", "cleanup_receipt"].map((kind) => ({
        kind,
        path: "receipt.json",
        sha256,
      })),
    });
    await run(root, packet);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("preparation leaves every real scenario not run", () => {
  assert.equal(acceptanceTemplate(catalogs, revision).results[0].status, "not_run");
});

test("complete hashes make a packet ready for review without claiming execution", async () => {
  await fixture(async (root, packet) => {
    const result = await summarizeAcceptance(catalogs, packet, root);
    assert.equal(result.status, "ready_for_review");
    assert.equal(result.scenarios[0].declaredStatus, "passed");
    assert.equal(result.scenarios[0].status, "ready_for_review");
  });
});

test("a missing scenario or missing cleanup evidence cannot pass", async () => {
  await fixture(async (root, packet) => {
    packet.results[0].evidence.pop();
    assert.equal(
      (await summarizeAcceptance(catalogs, packet, root)).scenarios[0].status,
      "invalid_evidence",
    );
    packet.results = [];
    assert.equal(
      (await summarizeAcceptance(catalogs, packet, root)).scenarios[0].status,
      "not_run",
    );
  });
});

test("changed bytes, path traversal, and absolute evidence paths are rejected", async () => {
  await fixture(async (root, packet) => {
    for (const path of ["../outside.json", join(root, "receipt.json")]) {
      packet.results[0].evidence[0].path = path;
      assert.equal(
        (await summarizeAcceptance(catalogs, packet, root)).scenarios[0].status,
        "invalid_evidence",
      );
    }
    packet.results[0].evidence[0].path = "receipt.json";
    await writeFile(join(root, "receipt.json"), "Changed receipt");
    assert.equal(
      (await summarizeAcceptance(catalogs, packet, root)).scenarios[0].status,
      "invalid_evidence",
    );
  });
});

test("historical failures remain failures even with valid evidence", async () => {
  await fixture(async (root, packet) => {
    packet.results[0].status = "failed";
    const result = await summarizeAcceptance(catalogs, packet, root);
    assert.equal(result.status, "incomplete");
    assert.equal(result.scenarios[0].status, "failed");
  });
});
