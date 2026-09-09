import type { RepositoryAdapter } from "./adapter";
import { HttpRepositoryAdapter } from "./http-adapter";
import { MockRepositoryAdapter } from "./mock-adapter";

export const repositories: RepositoryAdapter =
  process.env.NODE_ENV === "development"
    ? new MockRepositoryAdapter()
    : new HttpRepositoryAdapter();

export type { RepositoryAdapter, RepositoryListQuery, RepositoryListResult } from "./adapter";
export { HttpRepositoryAdapter } from "./http-adapter";
export {
  MockRepositoryAdapter,
  type MockRepositoryAdapterOptions,
  sampleRepositories,
} from "./mock-adapter";
