import { link, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InvestigationModelInvocationReceipt,
  type InvestigationWorkerLease,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessHostRecoverySnapshot } from "../execution/process-host-protocol.js";
import { InvestigationModelUsageJournal } from "./model-usage-journal.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "model-usage-"));
  directories.push(result);
  return result;
}
const context = {
  taskId: "task-1",
  attemptId: "attempt-1",
  purpose: "analysis" as const,
  engine: "codex" as const,
  model: null,
};

describe("durable Worker model usage journal", () => {
  const ownership = (generation: string): ProcessHostRecoverySnapshot => ({
    capability: "named-job-tree-v1",
    instanceKey: "a".repeat(64),
    generation: generation.repeat(64),
    previousTreeDrained: true,
  });

  it("closes interrupted calls only after the matching native tree generation has drained", async () => {
    const path = await directory();
    let sequence = 0;
    const journal = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => `native-call-${++sequence}`,
    });
    const unknown = await journal.begin(context, undefined, ownership("b"));
    const partial = await journal.begin(context, undefined, ownership("b"));
    await journal.update(partial.invocationId, {
      state: "running",
      completeness: "partial",
      usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 42 },
    });
    const receipts: InvestigationModelInvocationReceipt[] = [];
    const restarted = new InvestigationModelUsageJournal({
      directory: path,
      deliver: async (receipt) => {
        receipts.push(receipt);
      },
    });
    expect(await restarted.closeInterruptedInvocations(ownership("c"))).toBe(2);
    await restarted.replay();
    expect(
      receipts.filter((receipt) => receipt.invocationId === unknown.invocationId).at(-1),
    ).toMatchObject({
      state: "failed",
      disposition: "rejected",
      completeness: "unavailable",
      usage: { totalTokens: null },
    });
    expect(
      receipts.filter((receipt) => receipt.invocationId === partial.invocationId).at(-1),
    ).toMatchObject({
      state: "failed",
      disposition: "rejected",
      completeness: "partial",
      usage: { totalTokens: 42 },
    });
    expect(JSON.stringify(receipts)).not.toContain("nativeOwnership");
    expect(await restarted.closeInterruptedInvocations(ownership("c"))).toBe(0);
  });

  it.each([
    { ...ownership("b") },
    { ...ownership("c"), instanceKey: "d".repeat(64) },
    { ...ownership("c"), previousTreeDrained: false },
    { ...ownership("c"), capability: "pid-absence" },
    { ...ownership("c"), generation: "not-a-native-generation" },
  ])(
    "does not close active calls using unrelated, current-generation or fabricated proof: %j",
    async (proof) => {
      const path = await directory();
      const journal = new InvestigationModelUsageJournal({
        directory: path,
        createInvocationId: () => "active-native-call",
      });
      await journal.begin(context, undefined, ownership("b"));
      expect(
        await journal.closeInterruptedInvocations(proof as unknown as ProcessHostRecoverySnapshot),
      ).toBe(0);
      const receipts = (await readdir(path)).filter((name) => /^[a-f0-9]+\.\d+\.json$/u.test(name));
      expect(receipts).toHaveLength(1);
    },
  );

  it("retains legacy calls with no native proof even after another Host has recovered", async () => {
    const journal = new InvestigationModelUsageJournal({
      directory: await directory(),
      createInvocationId: () => "legacy-native-call",
    });
    await journal.begin(context);
    expect(await journal.closeInterruptedInvocations(ownership("c"))).toBe(0);
  });
  it("initializes strict contract formats before registration and retained receipt replay", async () => {
    FormatRegistry.Delete("date-time");
    const path = await directory();
    const journal = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => "call-format-initialization",
    });
    const receipt = await journal.begin(context);
    expect(receipt.state).toBe("registered");
    FormatRegistry.Delete("date-time");
    const recovered: InvestigationModelInvocationReceipt[] = [];
    const restarted = new InvestigationModelUsageJournal({
      directory: path,
      deliver: async (entry) => {
        recovered.push(entry);
      },
    });
    await restarted.replay();
    expect(recovered).toEqual([receipt]);
  });

  it("rejects impossible retained calendar dates after independent initialization", async () => {
    const path = await directory();
    const journal = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => "call-invalid-date",
    });
    const receipt = await journal.begin(context);
    const receiptPath = join(path, `${Buffer.from(receipt.invocationId).toString("hex")}.1.json`);
    await writeFile(
      receiptPath,
      JSON.stringify({ ...receipt, startedAt: "2026-02-30T00:00:00Z" }),
      "utf8",
    );
    FormatRegistry.Delete("date-time");
    const restarted = new InvestigationModelUsageJournal({ directory: path });
    await expect(restarted.replay()).rejects.toThrow(/retained usage receipt is invalid/u);
  });
  it("acknowledges denied admission and records zero consumption without permitting dispatch", async () => {
    const path = await directory();
    const invocationId = "call-denied";
    const prefix = Buffer.from(invocationId).toString("hex");
    const lease = { attemptId: context.attemptId, fence: 4, leaseToken: "private-denied-lease" };
    const received: InvestigationModelInvocationReceipt[] = [];
    const journal = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => invocationId,
      deliver: async (receipt) => {
        received.push(receipt);
        if (receipt.revision === 1) return { executionAllowed: false };
      },
    });
    await expect(journal.begin(context, lease)).rejects.toThrow(/not admitted for execution/u);
    expect(received.map((receipt) => receipt.state)).toEqual(["registered", "failed"]);
    expect(received[1]).toMatchObject({
      revision: 2,
      disposition: "rejected",
      completeness: "complete",
      usage: { totalTokens: 0 },
    });
    const acknowledgement = await readFile(join(path, `${prefix}.1.json.ack`), "utf8");
    expect(JSON.parse(acknowledgement)).toEqual({
      invocationId,
      revision: 1,
      executionAllowed: false,
    });
    expect(acknowledgement).not.toContain(lease.leaseToken);
    await expect(journal.update(invocationId, { state: "running" })).rejects.toThrow(
      /terminal state/u,
    );
    await journal.replay();
    expect(received).toHaveLength(2);
  });

  it("replays a denied invocation's pending zero receipt without rejecting its acknowledged registration again", async () => {
    const path = await directory();
    const first = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => "call-denied",
      deliver: async (receipt) => {
        if (receipt.revision === 1) return { executionAllowed: false };
        throw new Error("Synthetic zero receipt transport failure.");
      },
    });
    await expect(first.begin(context)).rejects.toThrow(/not admitted for execution/u);
    const other = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => "call-other",
    });
    await other.begin(context);
    const received: InvestigationModelInvocationReceipt[] = [];
    const restarted = new InvestigationModelUsageJournal({
      directory: path,
      deliver: async (receipt) => {
        received.push(receipt);
      },
    });
    await restarted.replay();
    await restarted.replay();
    expect(received.map(({ invocationId, revision }) => ({ invocationId, revision }))).toEqual([
      { invocationId: "call-denied", revision: 2 },
      { invocationId: "call-other", revision: 1 },
    ]);
    expect(received[0]).toMatchObject({
      state: "failed",
      disposition: "rejected",
      usage: { totalTokens: 0 },
    });
  });

  it("recovers a crash after denial was acknowledged but before its zero receipt was written", async () => {
    const path = await directory();
    const invocationId = "call-denied";
    const prefix = Buffer.from(invocationId).toString("hex");
    const first = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => invocationId,
    });
    await first.begin(context);
    await writeFile(
      join(path, `${prefix}.1.json.ack`),
      JSON.stringify({
        invocationId,
        revision: 1,
        executionAllowed: false,
      }),
    );
    const received: InvestigationModelInvocationReceipt[] = [];
    const restarted = new InvestigationModelUsageJournal({
      directory: path,
      deliver: async (receipt) => {
        received.push(receipt);
      },
    });
    await restarted.replay();
    await restarted.replay();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      invocationId,
      revision: 2,
      state: "failed",
      disposition: "rejected",
      completeness: "complete",
      usage: { totalTokens: 0 },
    });
  });

  it("ignores partial pending files from a crash before atomic publication", async () => {
    const path = await directory();
    const invocationId = "call-atomic";
    const prefix = Buffer.from(invocationId).toString("hex");
    const pendingName = `${prefix}.1.json.interrupted.pending`;
    await writeFile(join(path, pendingName), '{"invocationId":');
    const first = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => invocationId,
    });
    await first.begin(context);
    const received: InvestigationModelInvocationReceipt[] = [];
    const restarted = new InvestigationModelUsageJournal({
      directory: path,
      deliver: async (receipt) => {
        received.push(receipt);
      },
    });
    await restarted.replay();
    expect(received.map((receipt) => receipt.invocationId)).toEqual([invocationId]);
    expect(await readFile(join(path, pendingName), "utf8")).toBe('{"invocationId":');
    expect((await readdir(path)).filter((name) => name.endsWith(".pending"))).toEqual([
      pendingName,
    ]);
  });

  it("replays a published private context when a crash leaves its pending hard link behind", async () => {
    const path = await directory();
    const invocationId = "call-atomic";
    const prefix = Buffer.from(invocationId).toString("hex");
    const lease = { attemptId: context.attemptId, fence: 2, leaseToken: "retained-atomic-lease" };
    const first = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => invocationId,
    });
    await first.begin(context, lease);
    await link(
      join(path, `${prefix}.delivery.json`),
      join(path, `${prefix}.delivery.json.interrupted.pending`),
    );
    const received: (InvestigationWorkerLease | undefined)[] = [];
    const restarted = new InvestigationModelUsageJournal({
      directory: path,
      deliver: async (_receipt, retainedLease) => {
        received.push(retainedLease);
      },
    });
    await restarted.replay();
    expect(received).toEqual([lease]);
  });

  it("persists the original delivery lease before registration while keeping public receipts credential-free", async () => {
    const path = await directory();
    const lease = { attemptId: context.attemptId, fence: 4, leaseToken: "retained-private-lease" };
    const expectedLease = structuredClone(lease);
    const received: InvestigationWorkerLease[] = [];
    const journal = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => "call-private",
      deliver: async (receipt, retainedLease) => {
        const prefix = Buffer.from(receipt.invocationId).toString("hex");
        expect(JSON.parse(await readFile(join(path, `${prefix}.delivery.json`), "utf8"))).toEqual({
          lease: expectedLease,
        });
        expect(
          await readFile(join(path, `${prefix}.${receipt.revision}.json`), "utf8"),
        ).not.toContain(expectedLease.leaseToken);
        expect(retainedLease).toEqual(expectedLease);
        received.push(retainedLease!);
      },
    });
    const registered = journal.begin(context, lease);
    lease.leaseToken = "mutated-caller-value";
    await registered;
    expect(received).toEqual([expectedLease]);
  });

  it("replays terminal receipts after restart with the invocation's original lease and fence", async () => {
    const path = await directory();
    const lease = { attemptId: context.attemptId, fence: 7, leaseToken: "original-retained-lease" };
    const first = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => "call-private",
    });
    await first.begin(context, lease);
    await first.update("call-private", {
      state: "cancelled",
      disposition: "rejected",
      completeness: "partial",
      usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 15 },
    });
    const received: { revision: number; lease: InvestigationWorkerLease | undefined }[] = [];
    const restarted = new InvestigationModelUsageJournal({
      directory: path,
      deliver: async (receipt, retainedLease) => {
        received.push({ revision: receipt.revision, lease: retainedLease });
      },
    });
    await restarted.replay();
    await restarted.replay();
    expect(received).toEqual([
      { revision: 1, lease },
      { revision: 2, lease },
    ]);
  });

  it("rejects a mismatched delivery lease before persisting or dispatching a receipt", async () => {
    const path = await directory();
    const journal = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => "call-private",
    });
    await expect(
      journal.begin(context, {
        attemptId: "another-attempt",
        fence: 1,
        leaseToken: "wrong-lease",
      }),
    ).rejects.toThrow(/does not match/u);
    expect(await readdir(path)).toEqual([]);
  });

  it("refuses retained delivery context bound to another attempt without acknowledging it", async () => {
    const path = await directory();
    const invocationId = "call-private";
    const prefix = Buffer.from(invocationId).toString("hex");
    const first = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => invocationId,
    });
    await first.begin(context, {
      attemptId: context.attemptId,
      fence: 1,
      leaseToken: "original-lease",
    });
    await writeFile(
      join(path, `${prefix}.delivery.json`),
      JSON.stringify({
        lease: { attemptId: "another-attempt", fence: 1, leaseToken: "wrong-lease" },
      }),
    );
    const received: InvestigationModelInvocationReceipt[] = [];
    const restarted = new InvestigationModelUsageJournal({
      directory: path,
      deliver: async (receipt) => {
        received.push(receipt);
      },
    });
    await expect(restarted.replay()).rejects.toThrow(/delivery context is invalid/u);
    expect(received).toEqual([]);
    expect((await readdir(path)).some((name) => name.endsWith(".ack"))).toBe(false);
  });

  it("writes registration before delivering it and retains independent accepted disposition", async () => {
    const path = await directory();
    const received: InvestigationModelInvocationReceipt[] = [];
    const journal = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => "call-1",
      deliver: async (receipt) => {
        const name = `${Buffer.from(receipt.invocationId).toString("hex")}.${receipt.revision}.json`;
        expect(JSON.parse(await readFile(join(path, name), "utf8"))).toEqual(receipt);
        received.push(receipt);
      },
    });
    const initial = await journal.begin(context);
    await journal.update(initial.invocationId, {
      state: "completed",
      usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 50 },
      completeness: "complete",
    });
    await journal.update(initial.invocationId, { disposition: "accepted" });
    expect(received.map((receipt) => receipt.revision)).toEqual([1, 2, 3]);
    expect(received[2]).toMatchObject({
      state: "completed",
      disposition: "accepted",
      usage: { totalTokens: 50, cachedReadTokens: null },
    });
  });

  it("replays unacknowledged receipts in order after restart without calling a model", async () => {
    const path = await directory();
    const first = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => "call-1",
    });
    await first.begin(context);
    await first.update("call-1", { state: "running" });
    await first.update("call-1", { state: "cancelled", disposition: "rejected" });
    const received: number[] = [];
    const restarted = new InvestigationModelUsageJournal({
      directory: path,
      deliver: async (receipt) => {
        received.push(receipt.revision);
      },
    });
    await restarted.replay();
    await restarted.replay();
    expect(received).toEqual([1, 2, 3]);
  });

  it("keeps a failed delivery for retry and serializes simultaneous observations", async () => {
    const path = await directory();
    let failures = 1;
    const received: number[] = [];
    const journal = new InvestigationModelUsageJournal({
      directory: path,
      createInvocationId: () => "call-1",
      deliver: async (receipt) => {
        if (receipt.revision === 2 && failures-- > 0) throw new Error("network unavailable");
        received.push(receipt.revision);
      },
    });
    await journal.begin(context);
    await expect(journal.update("call-1", { state: "running" })).rejects.toThrow(
      "network unavailable",
    );
    await Promise.all([
      journal.update("call-1", { state: "failed" }),
      journal.update("call-1", { disposition: "rejected" }),
    ]);
    expect(received).toEqual([1, 2, 3, 4]);
    expect((await readdir(path)).filter((name) => name.endsWith(".json"))).toHaveLength(4);
  });

  it("rejects unknown invocation updates and unsafe token receipts", async () => {
    const journal = new InvestigationModelUsageJournal({
      directory: await directory(),
      createInvocationId: () => "call-1",
    });
    await expect(journal.update("missing", { state: "failed" })).rejects.toThrow(/registered/u);
    await journal.begin(context);
    await expect(
      journal.update("call-1", {
        usage: { ...unavailableInvestigationTokenUsage(), inputTokens: 10, cachedReadTokens: 20 },
      }),
    ).rejects.toThrow(/invalid/u);
  });
});
