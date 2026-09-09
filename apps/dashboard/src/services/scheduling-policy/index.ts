import type { SchedulingPolicyAdapter } from "./adapter";
import { HttpSchedulingPolicyAdapter } from "./http-adapter";
import { SampleSchedulingPolicyAdapter } from "./sample-adapter";

export const schedulingPolicy: SchedulingPolicyAdapter =
  process.env.NODE_ENV === "development"
    ? new SampleSchedulingPolicyAdapter()
    : new HttpSchedulingPolicyAdapter();
export type { SchedulingPolicyAdapter } from "./adapter";
export { HttpSchedulingPolicyAdapter } from "./http-adapter";
export { SampleSchedulingPolicyAdapter } from "./sample-adapter";
export const schedulingPolicyQueryRoot = ["scheduling-policy"] as const;
