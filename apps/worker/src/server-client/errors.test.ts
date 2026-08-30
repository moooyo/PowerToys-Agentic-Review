import { describe, expect, it } from "vitest";
import { WorkerApiError } from "./errors.js";

describe("WorkerApiError", () => {
  it("treats a superseded process instance as a terminal registration error", () => {
    const error = new WorkerApiError(
      "A newer process owns the node.",
      409,
      "worker_instance_superseded",
    );

    expect(error.isWorkerInstanceSuperseded).toBe(true);
    expect(error.isWorkerRegistrationLost).toBe(false);
    expect(error.isRetryable).toBe(false);
  });
});
