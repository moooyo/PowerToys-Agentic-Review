import { performance } from "node:perf_hooks";
import {
  maximumResultArtifactChunkBytes,
  maximumResultArtifactChunks,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  ArtifactUploadCreateCoordinator,
  ArtifactUploadCreateCoordinatorError,
  type ArtifactUploadCreateCoordinatorOptions,
  type ArtifactUploadCreateDatabaseHandle,
  type ArtifactUploadCreateOwnerLock,
  type ArtifactUploadCreateStorageOwner,
} from "../../dist/artifacts/artifact-upload-create-coordinator.js";
import { attachArtifactUploadCreateDatabaseForTest } from "../../dist/artifacts/artifact-upload-create-coordinator.testing.js";
import { ArtifactStorageClientError } from "../../dist/artifacts/errors.js";
import type {
  ArtifactCapacityAdmission,
  ArtifactCapacityEvaluationInput,
  ArtifactCapacityLimits,
} from "../../dist/artifacts/types.js";
import type {
  ArtifactUploadCreateAccounting,
  CreateArtifactUploadInput,
  CreateArtifactUploadResult,
  ProbeArtifactUploadCreateResult,
} from "../../dist/database/artifacts.js";
import { DatabaseRequestError } from "../../dist/database/errors.js";

class FakeDatabaseOwner {
  readonly events: string[];
  readonly probedInputs: CreateArtifactUploadInput[] = [];
  readonly createdInputs: CreateArtifactUploadInput[] = [];
  probe: (input: CreateArtifactUploadInput) => Promise<ProbeArtifactUploadCreateResult>;
  create: (input: CreateArtifactUploadInput) => Promise<CreateArtifactUploadResult>;
  closeDatabase: () => Promise<void>;

  constructor(events: string[]) {
    this.events = events;
    this.probe = () => Promise.resolve(newProbe());
    this.create = (input) => Promise.resolve(createdResult(input.clientArtifactId));
    this.closeDatabase = () => Promise.resolve();
  }

  probeArtifactUploadCreate(
    input: CreateArtifactUploadInput,
  ): Promise<ProbeArtifactUploadCreateResult> {
    this.events.push(`probe:${input.clientArtifactId}`);
    this.probedInputs.push(input);
    return this.probe(input);
  }

  createArtifactUpload(input: CreateArtifactUploadInput): Promise<CreateArtifactUploadResult> {
    this.events.push(`create:${input.clientArtifactId}`);
    this.createdInputs.push(input);
    return this.create(input);
  }

  close(): Promise<void> {
    this.events.push("database-close");
    return this.closeDatabase();
  }
}

class FakeStorageOwner implements ArtifactUploadCreateStorageOwner {
  readonly events: string[];
  readonly exit = Promise.withResolvers<number>();
  readonly ownerExit = this.exit.promise;
  readonly capacityInputs: ArtifactCapacityEvaluationInput[] = [];
  evaluate: (input: ArtifactCapacityEvaluationInput) => Promise<ArtifactCapacityAdmission>;
  closeStorage: () => Promise<void>;

  constructor(events: string[]) {
    this.events = events;
    this.evaluate = (input) => Promise.resolve(capacityAdmission(input));
    this.closeStorage = () => {
      this.exit.resolve(0);
      return Promise.resolve();
    };
  }

  evaluateCapacity(input: ArtifactCapacityEvaluationInput): Promise<ArtifactCapacityAdmission> {
    this.events.push(`capacity:${input.request.expectedTotalBytes}`);
    this.capacityInputs.push(input);
    return this.evaluate(input);
  }

  close(): Promise<void> {
    this.events.push("storage-close");
    return this.closeStorage();
  }
}

class FakeOwnerLock implements ArtifactUploadCreateOwnerLock {
  readonly events: string[];
  closeLock: () => Promise<void> = () => Promise.resolve();

  constructor(events: string[]) {
    this.events = events;
  }

  close(): Promise<void> {
    this.events.push("owner-lock-close");
    return this.closeLock();
  }
}

const clientArtifactId = (ordinal: number): string =>
  `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, "0")}`;

const createInput = (ordinal = 1): CreateArtifactUploadInput => ({
  jobId: `job-${ordinal}`,
  runAttemptId: `attempt-${ordinal}`,
  workerNodeId: "worker-node",
  workerInstanceId: "worker-instance",
  leaseToken: "t".repeat(32),
  leaseGeneration: 1,
  clientArtifactId: clientArtifactId(ordinal),
  purpose: "result",
  name: `result-${ordinal}.json`,
  mediaType: "application/json",
  totalBytes: ordinal,
  sha256: ordinal.toString(16).padStart(64, "0"),
});

const createdResult = (uploadId: string, replayed = false): CreateArtifactUploadResult => {
  const common = {
    uploadId,
    maximumChunkBytes: maximumResultArtifactChunkBytes,
    maximumChunkCount: maximumResultArtifactChunks,
    state: "receiving" as const,
    nextChunkIndex: 0 as const,
    nextOffsetBytes: 0 as const,
  };
  return replayed ? { ...common, replayed: true } : { ...common, replayed: false };
};

const newProbe = (
  accounting: ArtifactUploadCreateAccounting = {
    accountingCertain: true,
    liveUploadCount: 0,
    liveUploadExpectedByteSizeBuckets: [],
    cleanupBacklogEntries: 0,
  },
): ProbeArtifactUploadCreateResult => ({ disposition: "new", accounting });

const exactReplay = (ordinal = 1): ProbeArtifactUploadCreateResult => ({
  disposition: "exact-replay",
  result: createdResult(`upload-${ordinal}`, true),
});

const storageCapacity: ArtifactCapacityLimits = {
  hardBytes: 1_000_000n,
  hardEntries: 100_000,
  emergencyReserveBytes: 1_000n,
  perUploadMetadataHeadroomBytes: 0n,
  cleanupBacklogHighWaterEntries: 4_096,
};

const capacityAdmission = (
  input: ArtifactCapacityEvaluationInput = {
    request: { expectedTotalBytes: 1 },
    accounting: {
      accountingCertain: true,
      liveUploadCount: 0,
      liveUploadExpectedByteSizeBuckets: [],
      cleanupBacklogEntries: 0,
    },
  },
): ArtifactCapacityAdmission => {
  const requiredBytes = BigInt(input.request.expectedTotalBytes) * 2n;
  const outstandingReservationBytes = input.accounting.liveUploadExpectedByteSizeBuckets.reduce(
    (total, bucket) => total + BigInt(bucket.expectedTotalBytes) * 2n * BigInt(bucket.uploadCount),
    0n,
  );
  const outstandingReservationEntries = input.accounting.liveUploadCount * 4;
  const filesystemAvailableBytes = 1_000_000n;
  return {
    requiredBytes,
    requiredEntries: 4,
    physicalAllocatedBytes: 0n,
    physicalEntries: 0,
    outstandingReservationBytes,
    outstandingReservationEntries,
    filesystemAvailableBytes,
    filesystemAvailableAfterReservationsBytes:
      filesystemAvailableBytes - outstandingReservationBytes,
    filesystemAllocationUnitBytes: 1n,
    projectedChargedBytes: outstandingReservationBytes + requiredBytes,
    projectedChargedEntries: outstandingReservationEntries + 4,
  };
};

const fixture = (
  overrides: Partial<ArtifactUploadCreateCoordinatorOptions> = {},
): {
  readonly coordinator: ArtifactUploadCreateCoordinator;
  readonly database: FakeDatabaseOwner;
  readonly databaseHandle: ArtifactUploadCreateDatabaseHandle;
  readonly storage: FakeStorageOwner;
  readonly ownerLock: FakeOwnerLock;
  readonly events: string[];
  readonly fatalErrors: ArtifactUploadCreateCoordinatorError[];
} => {
  const events: string[] = [];
  const fatalErrors: ArtifactUploadCreateCoordinatorError[] = [];
  const database = new FakeDatabaseOwner(events);
  const databaseHandle = attachArtifactUploadCreateDatabaseForTest(database);
  const storage = new FakeStorageOwner(events);
  const ownerLock = new FakeOwnerLock(events);
  const coordinator = ArtifactUploadCreateCoordinator.start({
    database: databaseHandle,
    storage,
    storageCapacity,
    databaseOwnerLock: ownerLock,
    requestTimeoutMilliseconds: 1_000,
    closeTimeoutMilliseconds: 1_000,
    storageJoinTimeoutMilliseconds: 1_000,
    maximumPendingCreates: 16,
    onFailStop: (error) => {
      fatalErrors.push(error);
    },
    ...overrides,
  });
  return {
    coordinator,
    database,
    databaseHandle,
    storage,
    ownerLock,
    events,
    fatalErrors,
  };
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

describe("ArtifactUploadCreateCoordinator sequencing", () => {
  it("returns exact replay without touching storage or durable create", async () => {
    const { coordinator, database, storage, events } = fixture();
    database.probe = () => Promise.resolve(exactReplay());

    await expect(coordinator.createArtifactUpload(createInput())).resolves.toMatchObject({
      uploadId: "upload-1",
      replayed: true,
    });
    expect(storage.capacityInputs).toHaveLength(0);
    expect(database.createdInputs).toHaveLength(0);
    expect(events).toEqual([`probe:${clientArtifactId(1)}`]);
    await coordinator.close();
  });

  it("serializes probe, capacity, and independently rechecked create", async () => {
    const { coordinator, database, storage, events } = fixture();
    let durableCreates = 0;
    database.probe = () =>
      Promise.resolve(
        durableCreates === 0
          ? newProbe()
          : newProbe({
              accountingCertain: true,
              liveUploadCount: durableCreates,
              liveUploadExpectedByteSizeBuckets: [
                { expectedTotalBytes: 1, uploadCount: durableCreates },
              ],
              cleanupBacklogEntries: 0,
            }),
      );
    database.create = (input) => {
      durableCreates += 1;
      return Promise.resolve(createdResult(`upload-${input.clientArtifactId}`));
    };

    const first = coordinator.createArtifactUpload(createInput(1));
    const second = coordinator.createArtifactUpload(createInput(2));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(events.slice(0, 6)).toEqual([
      `probe:${clientArtifactId(1)}`,
      "capacity:1",
      `create:${clientArtifactId(1)}`,
      `probe:${clientArtifactId(2)}`,
      "capacity:2",
      `create:${clientArtifactId(2)}`,
    ]);
    expect(storage.capacityInputs[1]?.accounting).toEqual({
      accountingCertain: true,
      liveUploadCount: 1,
      liveUploadExpectedByteSizeBuckets: [{ expectedTotalBytes: 1, uploadCount: 1 }],
      cleanupBacklogEntries: 0,
    });
    await coordinator.close();
  });

  it("snapshots caller input before it waits in the Server-wide FIFO", async () => {
    const { coordinator, database } = fixture();
    const firstProbe = Promise.withResolvers<ProbeArtifactUploadCreateResult>();
    let probeCalls = 0;
    database.probe = () => {
      probeCalls += 1;
      return probeCalls === 1 ? firstProbe.promise : Promise.resolve(exactReplay(2));
    };
    const first = coordinator.createArtifactUpload(createInput(1));
    const mutable = { ...createInput(2) };
    const second = coordinator.createArtifactUpload(mutable);
    mutable.name = "mutated.json";
    mutable.totalBytes = 999;
    firstProbe.resolve(exactReplay(1));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(database.probedInputs[1]).toMatchObject({
      name: "result-2.json",
      totalBytes: 2,
    });
    expect(Object.isFrozen(database.probedInputs[1])).toBe(true);
    await coordinator.close();
  });

  it("always calls durable create after capacity so DB can recheck authority", async () => {
    const { coordinator, database, events } = fixture();
    database.create = () =>
      Promise.reject(
        new DatabaseRequestError("changed state at /secret/database", "ARTIFACT_UPLOAD_CONFLICT"),
      );

    await expect(coordinator.createArtifactUpload(createInput())).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_CONFLICT",
      message: "Artifact upload create conflicts with durable state.",
      retryable: false,
    });
    expect(events.slice(0, 3)).toEqual([
      `probe:${clientArtifactId(1)}`,
      "capacity:1",
      `create:${clientArtifactId(1)}`,
    ]);
    expect(JSON.stringify(events)).not.toContain("/secret");
    await coordinator.close();
  });

  it("maps a completion-mode change during durable create without fail-stop", async () => {
    const { coordinator, database, fatalErrors } = fixture();
    database.create = () =>
      Promise.reject(
        new DatabaseRequestError(
          "mode changed at /secret/database",
          "ARTIFACT_COMPLETION_MODE_MISMATCH",
        ),
      );

    await expect(coordinator.createArtifactUpload(createInput())).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_COMPLETION_MODE_MISMATCH",
      retryable: false,
      requiresFailStop: false,
    });
    expect(database.createdInputs).toHaveLength(1);
    expect(fatalErrors).toHaveLength(0);
    await coordinator.close();
  });
});

describe("ArtifactUploadCreateCoordinator deadlines and errors", () => {
  it("maps stable lease and quota database errors without poisoning the gate", async () => {
    const { coordinator, database, storage, fatalErrors } = fixture();
    const errors = [
      ["LEASE_LOST", "ARTIFACT_CREATE_LEASE_LOST"],
      ["ARTIFACT_UPLOAD_QUOTA_EXCEEDED", "ARTIFACT_CREATE_QUOTA_EXCEEDED"],
      ["ARTIFACT_COMPLETION_MODE_MISMATCH", "ARTIFACT_CREATE_COMPLETION_MODE_MISMATCH"],
    ] as const;
    for (const [databaseCode, coordinatorCode] of errors) {
      database.probe = () =>
        Promise.reject(new DatabaseRequestError("database path /secret", databaseCode));
      await expect(coordinator.createArtifactUpload(createInput())).rejects.toMatchObject({
        code: coordinatorCode,
        retryable: false,
        requiresFailStop: false,
      });
    }
    expect(storage.capacityInputs).toHaveLength(0);
    expect(fatalErrors).toHaveLength(0);
    await coordinator.close();
  });

  it("maps storage capacity rejection without calling durable create", async () => {
    const { coordinator, database, storage, fatalErrors } = fixture();
    storage.evaluate = () =>
      Promise.reject(
        new ArtifactStorageClientError(
          "ARTIFACT_STORAGE_CAPACITY",
          "capacity path /secret/storage",
          true,
        ),
      );

    await expect(coordinator.createArtifactUpload(createInput())).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_CAPACITY",
      message: "Artifact upload storage capacity is unavailable.",
      retryable: true,
      requiresFailStop: false,
    });
    expect(database.createdInputs).toHaveLength(0);
    expect(fatalErrors).toHaveLength(0);
    await coordinator.close();
  });

  it("maps storage client backpressure to a retryable create-busy result", async () => {
    const { coordinator, database, storage, fatalErrors } = fixture();
    storage.evaluate = () =>
      Promise.reject(
        new ArtifactStorageClientError(
          "ARTIFACT_STORAGE_CLIENT_BUSY",
          "internal pending detail",
          true,
        ),
      );

    await expect(coordinator.createArtifactUpload(createInput())).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_BUSY",
      retryable: true,
      requiresFailStop: false,
    });
    expect(database.createdInputs).toHaveLength(0);
    expect(fatalErrors).toHaveLength(0);
    await coordinator.close();
  });

  it("fail-stops when a forged capacity success does not match its exact request", async () => {
    const { coordinator, database, storage, fatalErrors } = fixture();
    storage.evaluate = (input) => {
      const admission = capacityAdmission(input);
      return Promise.resolve({
        ...admission,
        requiredBytes: admission.requiredBytes + 1n,
        projectedChargedBytes: admission.projectedChargedBytes + 1n,
      });
    };

    await expect(coordinator.createArtifactUpload(createInput())).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_PROTOCOL_FAILURE",
      retryable: false,
      requiresFailStop: true,
    });
    expect(database.createdInputs).toHaveLength(0);
    expect(fatalErrors).toHaveLength(1);
    await expect(coordinator.close()).rejects.toBe(fatalErrors[0]);
  });

  it("maps storage owner failure to one path-free fail-stop error", async () => {
    const { coordinator, storage, fatalErrors } = fixture();
    storage.evaluate = () =>
      Promise.reject(
        new ArtifactStorageClientError(
          "ARTIFACT_STORAGE_INTEGRITY",
          "integrity failure at /secret/storage",
          false,
        ),
      );

    await expect(coordinator.createArtifactUpload(createInput())).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_STORAGE_FAILURE",
      message: "Artifact upload storage owner failed.",
      retryable: false,
      requiresFailStop: true,
    });
    expect(fatalErrors).toHaveLength(1);
    expect(JSON.stringify(fatalErrors[0])).not.toContain("/secret");
    await expect(coordinator.close()).rejects.toBe(fatalErrors[0]);
  });

  it("cancels queued work without releasing the FIFO around an active probe", async () => {
    const { coordinator, database, storage } = fixture();
    const firstProbe = Promise.withResolvers<ProbeArtifactUploadCreateResult>();
    database.probe = () => firstProbe.promise;
    const first = coordinator.createArtifactUpload(createInput(1));
    await flush();
    const cancellation = new AbortController();
    const second = coordinator.createArtifactUpload(createInput(2), cancellation.signal);
    cancellation.abort();

    await expect(second).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_CANCELLED",
      retryable: true,
    });
    expect(database.probedInputs).toHaveLength(1);
    firstProbe.resolve(exactReplay(1));
    await expect(first).resolves.toMatchObject({ replayed: true });
    await flush();
    expect(database.probedInputs).toHaveLength(1);
    expect(storage.capacityInputs).toHaveLength(0);
    await coordinator.close();
  });

  it("times out an active read-only probe and never advances to storage", async () => {
    const { coordinator, database, storage, fatalErrors } = fixture({
      requestTimeoutMilliseconds: 5,
    });
    const probe = Promise.withResolvers<ProbeArtifactUploadCreateResult>();
    database.probe = () => probe.promise;
    const result = coordinator.createArtifactUpload(createInput());

    await expect(result).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_TIMEOUT",
      retryable: true,
      requiresFailStop: false,
    });
    probe.resolve(newProbe());
    await flush();
    expect(storage.capacityInputs).toHaveLength(0);
    expect(database.createdInputs).toHaveLength(0);
    expect(fatalErrors).toHaveLength(0);
    await coordinator.close();
  });

  it("validates a malformed probe response that arrives after caller timeout", async () => {
    const { coordinator, database, storage, fatalErrors } = fixture({
      requestTimeoutMilliseconds: 5,
    });
    const probe = Promise.withResolvers<ProbeArtifactUploadCreateResult>();
    database.probe = () => probe.promise;
    const result = coordinator.createArtifactUpload(createInput());

    await expect(result).rejects.toMatchObject({ code: "ARTIFACT_CREATE_TIMEOUT" });
    probe.resolve({ disposition: "exact-replay", result: createdResult("wrong", false) });
    await flush();
    expect(storage.capacityInputs).toHaveLength(0);
    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toMatchObject({ code: "ARTIFACT_CREATE_PROTOCOL_FAILURE" });
    await expect(coordinator.close()).rejects.toBe(fatalErrors[0]);
  });

  it("observes a late storage-owner failure after caller timeout", async () => {
    const { coordinator, storage, database, fatalErrors } = fixture({
      requestTimeoutMilliseconds: 5,
    });
    const capacity = Promise.withResolvers<ArtifactCapacityAdmission>();
    storage.evaluate = () => capacity.promise;
    const result = coordinator.createArtifactUpload(createInput());
    await flush();

    await expect(result).rejects.toMatchObject({ code: "ARTIFACT_CREATE_TIMEOUT" });
    capacity.reject(
      new ArtifactStorageClientError(
        "ARTIFACT_STORAGE_INTEGRITY",
        "late storage failure at /secret/path",
        false,
      ),
    );
    await flush();
    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toMatchObject({
      code: "ARTIFACT_CREATE_STORAGE_FAILURE",
      requiresFailStop: true,
    });
    expect(database.createdInputs).toHaveLength(0);
    await expect(coordinator.close()).rejects.toBe(fatalErrors[0]);
  });

  it("treats cancellation during durable create as outcome-unknown fatal", async () => {
    const { coordinator, database, events, fatalErrors } = fixture();
    const create = Promise.withResolvers<CreateArtifactUploadResult>();
    const createEntered = Promise.withResolvers<void>();
    database.create = () => {
      createEntered.resolve();
      return create.promise;
    };
    const cancellation = new AbortController();
    const result = coordinator.createArtifactUpload(createInput(), cancellation.signal);
    await createEntered.promise;
    cancellation.abort();

    await expect(result).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_OUTCOME_UNKNOWN",
      retryable: false,
      requiresFailStop: true,
    });
    await expect(coordinator.createArtifactUpload(createInput(2))).rejects.toBe(fatalErrors[0]);
    expect(fatalErrors).toHaveLength(1);
    expect(await coordinator.fatal).toBe(fatalErrors[0]);
    const closing = coordinator.close();
    await flush();
    expect(events).not.toContain("storage-close");
    create.resolve(createdResult("upload-after-cancel"));
    await flush();
    await expect(closing).rejects.toBe(fatalErrors[0]);
  });

  it("observes a rejected asynchronous fail-stop callback", async () => {
    const callbackError = new Error("supervisor rejected fail-stop");
    const { coordinator, storage } = fixture({
      onFailStop: async () => {
        throw callbackError;
      },
    });
    storage.evaluate = () => Promise.reject(new Error("storage terminal"));

    await expect(coordinator.createArtifactUpload(createInput())).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_STORAGE_FAILURE",
    });
    const callbackCompletion = coordinator.failStopCallbackCompletion;
    expect(callbackCompletion).toBeDefined();
    await expect(callbackCompletion).rejects.toBe(callbackError);
    await expect(coordinator.close()).rejects.toBe(await coordinator.fatal);
  });

  it("maps unknown database create failure to a path-free fatal cause", async () => {
    const { coordinator, database, fatalErrors } = fixture();
    database.create = () => Promise.reject(new Error("database failed at /secret/path"));

    await expect(coordinator.createArtifactUpload(createInput())).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_OUTCOME_UNKNOWN",
      message: "Artifact upload durable create outcome is unknown.",
    });
    expect(fatalErrors).toHaveLength(1);
    expect(JSON.stringify(fatalErrors[0])).not.toContain("/secret");
    await expect(coordinator.close()).rejects.toBe(fatalErrors[0]);
  });
});

describe("ArtifactUploadCreateCoordinator admission and owner lifecycle", () => {
  it("does not adopt owners when startup validation fails", async () => {
    const events: string[] = [];
    const database = new FakeDatabaseOwner(events);
    const databaseHandle = attachArtifactUploadCreateDatabaseForTest(database);
    const storage = new FakeStorageOwner(events);
    const ownerLock = new FakeOwnerLock(events);
    expect(() =>
      ArtifactUploadCreateCoordinator.start({
        database: databaseHandle,
        storage,
        storageCapacity,
        databaseOwnerLock: ownerLock,
        requestTimeoutMilliseconds: 1_000,
        closeTimeoutMilliseconds: 1_000,
        storageJoinTimeoutMilliseconds: 1_000,
        maximumPendingCreates: 0,
        onFailStop: () => undefined,
      }),
    ).toThrow(/pending limit/u);
    expect(events).toEqual([]);
    const coordinator = ArtifactUploadCreateCoordinator.start({
      database: databaseHandle,
      storage,
      storageCapacity,
      databaseOwnerLock: ownerLock,
      requestTimeoutMilliseconds: 1_000,
      closeTimeoutMilliseconds: 1_000,
      storageJoinTimeoutMilliseconds: 1_000,
      maximumPendingCreates: 16,
      onFailStop: () => undefined,
    });
    await coordinator.close();
  });

  it("consumes an opaque database handle exactly once", async () => {
    const { coordinator, databaseHandle, storage, ownerLock } = fixture();
    expect(Reflect.ownKeys(databaseHandle)).toEqual([]);
    expect(() =>
      ArtifactUploadCreateCoordinator.start({
        database: databaseHandle,
        storage,
        storageCapacity,
        databaseOwnerLock: ownerLock,
        requestTimeoutMilliseconds: 1_000,
        closeTimeoutMilliseconds: 1_000,
        storageJoinTimeoutMilliseconds: 1_000,
        maximumPendingCreates: 16,
        onFailStop: () => undefined,
      }),
    ).toThrow(/already consumed/u);
    await coordinator.close();
  });

  it("rejects a second handle for an already adopted raw database owner", async () => {
    const { coordinator, database } = fixture();
    const secondHandle = attachArtifactUploadCreateDatabaseForTest(database);
    const events: string[] = [];
    const storage = new FakeStorageOwner(events);
    const ownerLock = new FakeOwnerLock(events);
    expect(() =>
      ArtifactUploadCreateCoordinator.start({
        database: secondHandle,
        storage,
        storageCapacity,
        databaseOwnerLock: ownerLock,
        requestTimeoutMilliseconds: 1_000,
        closeTimeoutMilliseconds: 1_000,
        storageJoinTimeoutMilliseconds: 1_000,
        maximumPendingCreates: 16,
        onFailStop: () => undefined,
      }),
    ).toThrow(/already adopted/u);
    await coordinator.close();
  });

  it("fail-stops when the idle storage owner exits", async () => {
    const { coordinator, storage, fatalErrors } = fixture();
    storage.exit.resolve(0);
    await flush();

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toMatchObject({
      code: "ARTIFACT_CREATE_STORAGE_FAILURE",
      retryable: false,
      requiresFailStop: true,
    });
    await expect(coordinator.createArtifactUpload(createInput())).rejects.toBe(fatalErrors[0]);
    await expect(coordinator.close()).rejects.toBe(fatalErrors[0]);
  });

  it("retains DB ownership when the idle storage exit signal rejects", async () => {
    const { coordinator, storage, events, fatalErrors } = fixture();
    storage.exit.reject(new Error("owner exit unavailable"));
    await flush();

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]?.code).toBe("ARTIFACT_CREATE_STORAGE_FAILURE");
    await expect(coordinator.close()).rejects.toBe(fatalErrors[0]);
    expect(events).toEqual(["storage-close"]);
    expect(events).not.toContain("database-close");
    expect(events).not.toContain("owner-lock-close");
  });

  it("treats storage exit during close quiescence as unexpected", async () => {
    const { coordinator, database, storage, events, fatalErrors } = fixture();
    const probe = Promise.withResolvers<ProbeArtifactUploadCreateResult>();
    database.probe = () => probe.promise;
    const create = coordinator.createArtifactUpload(createInput());
    await flush();
    const closing = coordinator.close();
    storage.exit.resolve(0);
    await flush();

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]?.code).toBe("ARTIFACT_CREATE_STORAGE_FAILURE");
    await expect(create).rejects.toBe(fatalErrors[0]);
    expect(events).not.toContain("storage-close");
    probe.resolve(exactReplay());
    await expect(closing).rejects.toBe(fatalErrors[0]);
  });

  it("binds owner methods once when it adopts ready owners", async () => {
    const { coordinator, database, storage, ownerLock, events } = fixture();
    database.probeArtifactUploadCreate = () => Promise.reject(new Error("replaced probe"));
    database.createArtifactUpload = () => Promise.reject(new Error("replaced create"));
    database.close = () => Promise.reject(new Error("replaced database close"));
    storage.evaluateCapacity = () => Promise.reject(new Error("replaced capacity"));
    storage.close = () => Promise.reject(new Error("replaced storage close"));
    ownerLock.close = () => Promise.reject(new Error("replaced lock close"));

    await expect(coordinator.createArtifactUpload(createInput())).resolves.toMatchObject({
      replayed: false,
    });
    await expect(coordinator.close()).resolves.toBeUndefined();
    expect(events).toEqual([
      `probe:${clientArtifactId(1)}`,
      "capacity:1",
      `create:${clientArtifactId(1)}`,
      "storage-close",
      "database-close",
      "owner-lock-close",
    ]);
  });

  it("snapshots capacity limits when it adopts the storage owner", async () => {
    const mutableCapacity = { ...storageCapacity };
    const { coordinator } = fixture({ storageCapacity: mutableCapacity });
    mutableCapacity.hardBytes = 1n;
    mutableCapacity.hardEntries = 1;
    mutableCapacity.emergencyReserveBytes = 0n;

    await expect(coordinator.createArtifactUpload(createInput())).resolves.toMatchObject({
      replayed: false,
    });
    await coordinator.close();
  });

  it("ignores caller overrides of AbortSignal lifecycle accessors", async () => {
    const { coordinator, database } = fixture();
    database.probe = () => Promise.resolve(exactReplay());
    const signal = new AbortController().signal;
    let overriddenGetterCalls = 0;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get() {
        overriddenGetterCalls += 1;
        void coordinator.close();
        return false;
      },
    });

    await expect(coordinator.createArtifactUpload(createInput(), signal)).resolves.toMatchObject({
      replayed: true,
    });
    expect(overriddenGetterCalls).toBe(0);
    await coordinator.close();
  });

  it("bounds recursive caller getters before they can grow the FIFO", async () => {
    const { coordinator, database } = fixture({ maximumPendingCreates: 3 });
    database.probe = (input) =>
      Promise.resolve({
        disposition: "exact-replay",
        result: createdResult(`upload-${input.clientArtifactId}`, true),
      });
    const input = { ...createInput() };
    const originalName = input.name;
    const nested: Promise<CreateArtifactUploadResult>[] = [];
    let getterCalls = 0;
    Object.defineProperty(input, "name", {
      enumerable: true,
      get() {
        getterCalls += 1;
        nested.push(coordinator.createArtifactUpload(input));
        return originalName;
      },
    });

    const outer = coordinator.createArtifactUpload(input);
    expect(getterCalls).toBe(3);
    const settled = await Promise.allSettled([outer, ...nested]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(3);
    const rejected = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "ARTIFACT_CREATE_BUSY" });
    expect(database.probedInputs).toHaveLength(3);
    await coordinator.close();
  });

  it("waits for a reentrant input snapshot before closing adopted owners", async () => {
    const { coordinator, events } = fixture();
    const input = { ...createInput() };
    const originalName = input.name;
    let closing: Promise<void> | undefined;
    Object.defineProperty(input, "name", {
      enumerable: true,
      get() {
        closing ??= coordinator.close();
        return originalName;
      },
    });

    await expect(coordinator.createArtifactUpload(input)).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_CLOSED",
    });
    if (closing === undefined) {
      throw new Error("The reentrant coordinator close was not started.");
    }
    await expect(closing).resolves.toBeUndefined();
    expect(events).toEqual(["storage-close", "database-close", "owner-lock-close"]);
  });

  it("drains accepted work and proves storage exit before releasing the DB lock", async () => {
    const { coordinator, database, storage, events } = fixture();
    const probe = Promise.withResolvers<ProbeArtifactUploadCreateResult>();
    const databaseClose = Promise.withResolvers<void>();
    database.probe = () => probe.promise;
    database.closeDatabase = () => databaseClose.promise;
    storage.closeStorage = () => Promise.resolve();
    const create = coordinator.createArtifactUpload(createInput());
    await flush();
    const closing = coordinator.close();

    await expect(coordinator.createArtifactUpload(createInput(2))).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_CLOSED",
    });
    expect(events).toEqual([`probe:${clientArtifactId(1)}`]);
    probe.resolve(exactReplay());
    await expect(create).resolves.toMatchObject({ replayed: true });
    await flush();
    expect(events).toEqual([`probe:${clientArtifactId(1)}`, "storage-close"]);
    storage.exit.resolve(0);
    await flush();
    expect(events).toEqual([`probe:${clientArtifactId(1)}`, "storage-close", "database-close"]);
    expect(events).not.toContain("owner-lock-close");
    databaseClose.resolve();
    await expect(closing).resolves.toBeUndefined();
    expect(events).toEqual([
      `probe:${clientArtifactId(1)}`,
      "storage-close",
      "database-close",
      "owner-lock-close",
    ]);
  });

  it("rebuilds a foreign coordinator error as a local shutdown fatal", async () => {
    const { coordinator, storage, fatalErrors } = fixture();
    const foreign = new ArtifactUploadCreateCoordinatorError("ARTIFACT_CREATE_CLOSED");
    storage.closeStorage = () => Promise.reject(foreign);
    storage.exit.resolve(0);

    await expect(coordinator.close()).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE",
      requiresFailStop: true,
    });
    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).not.toBe(foreign);
    expect(fatalErrors[0]?.code).toBe("ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE");
  });

  it("waits for ownerExit after storage close rejects", async () => {
    const { coordinator, storage, events, fatalErrors } = fixture();
    storage.closeStorage = () => Promise.reject(new Error("storage client terminal"));
    const closing = coordinator.close();
    await flush();
    expect(fatalErrors).toHaveLength(1);
    expect(events).toEqual(["storage-close"]);
    expect(events).not.toContain("database-close");

    storage.exit.resolve(0);
    await expect(closing).rejects.toBe(fatalErrors[0]);
    expect(events).toEqual(["storage-close", "database-close", "owner-lock-close"]);
  });

  it("fail-stops on storage owner-exit timeout and retains DB ownership", async () => {
    const { coordinator, storage, events, fatalErrors } = fixture({
      closeTimeoutMilliseconds: 100,
      storageJoinTimeoutMilliseconds: 5,
    });
    storage.closeStorage = () => Promise.resolve();

    await expect(coordinator.close()).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE",
      requiresFailStop: true,
    });
    expect(fatalErrors).toHaveLength(1);
    expect(events).toEqual(["storage-close"]);
    expect(events).not.toContain("database-close");
    expect(events).not.toContain("owner-lock-close");
    await expect(coordinator.createArtifactUpload(createInput())).rejects.toBe(fatalErrors[0]);
  });

  it("post-checks the close deadline after an owner promise resolves", async () => {
    const { coordinator, storage, events, fatalErrors } = fixture({
      closeTimeoutMilliseconds: 5,
    });
    storage.closeStorage = async () => {
      await Promise.resolve();
      const blockUntil = performance.now() + 10;
      while (performance.now() < blockUntil) {
        // Deliberately hold the event loop past the absolute close deadline.
      }
    };

    await expect(coordinator.close()).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE",
      requiresFailStop: true,
    });
    expect(fatalErrors).toHaveLength(1);
    expect(events).toEqual(["storage-close"]);
    expect(events).not.toContain("database-close");
    expect(events).not.toContain("owner-lock-close");
  });

  it("fail-stops if accepted work cannot drain before close deadline", async () => {
    const { coordinator, database, events, fatalErrors } = fixture({
      closeTimeoutMilliseconds: 5,
    });
    database.probe = () => new Promise<ProbeArtifactUploadCreateResult>(() => undefined);
    const create = coordinator.createArtifactUpload(createInput());
    await flush();
    const closing = coordinator.close();

    await expect(closing).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_OWNER_SHUTDOWN_FAILURE",
      requiresFailStop: true,
    });
    await expect(create).rejects.toBe(fatalErrors[0]);
    expect(events).toEqual([`probe:${clientArtifactId(1)}`]);
    expect(events).not.toContain("storage-close");
    expect(events).not.toContain("database-close");
    expect(events).not.toContain("owner-lock-close");
  });

  it("rejects malformed owner protocol data and stops further admission", async () => {
    const { coordinator, database, storage, fatalErrors } = fixture();
    database.probe = () =>
      Promise.resolve({
        disposition: "exact-replay",
        result: createdResult("upload-invalid", false),
      });

    await expect(coordinator.createArtifactUpload(createInput())).rejects.toMatchObject({
      code: "ARTIFACT_CREATE_PROTOCOL_FAILURE",
      requiresFailStop: true,
    });
    expect(storage.capacityInputs).toHaveLength(0);
    expect(database.createdInputs).toHaveLength(0);
    expect(fatalErrors).toHaveLength(1);
    await expect(coordinator.createArtifactUpload(createInput(2))).rejects.toBe(fatalErrors[0]);
    await expect(coordinator.close()).rejects.toBe(fatalErrors[0]);
  });
});
