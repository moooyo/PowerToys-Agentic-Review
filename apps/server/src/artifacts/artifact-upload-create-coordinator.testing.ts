import type {
  CreateArtifactUploadInput,
  CreateArtifactUploadResult,
  ProbeArtifactUploadCreateResult,
} from "../database/artifacts.js";
import {
  type ArtifactUploadCreateDatabaseHandle,
  registerArtifactUploadCreateDatabaseHandle,
} from "./artifact-upload-create-coordinator.js";

export interface FakeArtifactUploadCreateDatabaseOwner {
  probeArtifactUploadCreate(
    input: CreateArtifactUploadInput,
  ): Promise<ProbeArtifactUploadCreateResult>;
  createArtifactUpload(input: CreateArtifactUploadInput): Promise<CreateArtifactUploadResult>;
  close(): Promise<void>;
}

export const attachArtifactUploadCreateDatabaseForTest = (
  owner: FakeArtifactUploadCreateDatabaseOwner,
): ArtifactUploadCreateDatabaseHandle => registerArtifactUploadCreateDatabaseHandle(owner, owner);
