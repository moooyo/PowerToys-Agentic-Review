import type { ArtifactReconciliationDatabaseOperation } from "../database/artifacts.js";
import type { DatabaseOperationMap } from "../database/protocol.js";
import {
  type ArtifactReconciliationDatabaseHandle,
  registerArtifactReconciliationDatabaseHandle,
} from "./artifact-reconciliation-coordinator.js";

export interface FakeArtifactReconciliationDatabaseOwner {
  request<TOperation extends ArtifactReconciliationDatabaseOperation>(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
  ): Promise<DatabaseOperationMap[TOperation]["output"]>;
}

export const attachArtifactReconciliationDatabaseForTest = (
  owner: FakeArtifactReconciliationDatabaseOwner,
): ArtifactReconciliationDatabaseHandle => registerArtifactReconciliationDatabaseHandle(owner);
