import type { ReviewControlAdapter } from "./adapter";
import { HttpReviewControlAdapter } from "./http-adapter";
import { MockReviewControlAdapter } from "./mock/mock-adapter";

// Development remains deterministic; every other build uses the authenticated,
// same-origin control-plane API and fails closed for unavailable mutations.
export const reviewControl: ReviewControlAdapter =
  process.env.NODE_ENV === "development"
    ? new MockReviewControlAdapter()
    : new HttpReviewControlAdapter();

export type { ReviewControlAdapter } from "./adapter";
export * from "./errors";
export { HttpReviewControlAdapter } from "./http-adapter";
export type * from "./types";
