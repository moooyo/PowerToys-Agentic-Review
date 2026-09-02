import {
  type CreateServerStorageRuntimeOptions,
  createServerStorageRuntimeWithInitialSweepTimeoutForTest,
  type ServerStorageRuntime,
} from "../../dist/runtime/server-storage-runtime.js";

/** Test-only deadline control. This file is excluded from the production TypeScript build. */
export const createServerStorageRuntimeWithInitialSweepTimeout = (
  options: CreateServerStorageRuntimeOptions,
  initialSweepTimeoutMilliseconds: number,
): Promise<ServerStorageRuntime> =>
  createServerStorageRuntimeWithInitialSweepTimeoutForTest(
    options,
    initialSweepTimeoutMilliseconds,
  );
