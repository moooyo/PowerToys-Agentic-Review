import { configuration } from "../configuration";
import type { ReviewRunAdapter } from "./adapter";
import { HttpReviewRunAdapter } from "./http-adapter";
import { MockReviewRunAdapter } from "./mock-adapter";

export const runs: ReviewRunAdapter =
  process.env.NODE_ENV === "development"
    ? new MockReviewRunAdapter({ configuration })
    : new HttpReviewRunAdapter();

export type {
  DashboardReviewRunReproductionCaseQuery,
  DashboardReviewRunReproductionCaseResponse,
} from "@agentic-review/contracts";
export type {
  ReviewRunAdapter,
  ReviewRunJobListQuery,
  ReviewRunListQuery,
  ReviewRunPageQuery,
} from "./adapter";
export { HttpReviewRunAdapter } from "./http-adapter";
export { MockReviewRunAdapter } from "./mock-adapter";
