import type { FindingsAdapter } from "./adapter";
import { HttpFindingsAdapter } from "./http-adapter";
import { MockFindingsAdapter } from "./mock-adapter";

export const findings: FindingsAdapter =
  process.env.NODE_ENV === "development" ? new MockFindingsAdapter() : new HttpFindingsAdapter();

export type { FindingPageQuery, FindingScope, FindingsAdapter } from "./adapter";
export { HttpFindingsAdapter } from "./http-adapter";
export { MockFindingsAdapter } from "./mock-adapter";
