import { access } from "../access";
import { runs } from "../runs";
import type { DecisionAdapter } from "./adapter";
import { HttpDecisionAdapter } from "./http-adapter";
import { MockDecisionAdapter } from "./mock-adapter";

export const decisions: DecisionAdapter =
  process.env.NODE_ENV === "development"
    ? new MockDecisionAdapter({ runs, access })
    : new HttpDecisionAdapter();

export type { DecisionAdapter, DecisionPageQuery } from "./adapter";
export { HttpDecisionAdapter } from "./http-adapter";
export { MockDecisionAdapter, type MockDecisionAdapterOptions } from "./mock-adapter";
