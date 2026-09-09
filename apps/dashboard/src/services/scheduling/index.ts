import type { SchedulingAdapter } from "./adapter";
import { HttpSchedulingAdapter } from "./http-adapter";
import { SampleSchedulingAdapter } from "./sample-adapter";

export const scheduling: SchedulingAdapter =
  process.env.NODE_ENV === "development"
    ? new SampleSchedulingAdapter()
    : new HttpSchedulingAdapter();
export type { SchedulingAdapter, SchedulingReadScope } from "./adapter";
export { HttpSchedulingAdapter } from "./http-adapter";
export { SampleSchedulingAdapter } from "./sample-adapter";
export { schedulingMatchesScope, schedulingScopeKey } from "./validation";
