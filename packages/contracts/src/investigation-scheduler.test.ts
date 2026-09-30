import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  InvestigationCleanupRequestSchema,
  InvestigationSchedulerSettingsRequestSchema,
} from "./investigation-scheduler.js";

describe("investigation scheduler contracts", () => {
  it("exposes only static concurrency and fixes desktop execution at one", () => {
    expect(Value.Check(InvestigationSchedulerSettingsRequestSchema, { staticConcurrency: 4 })).toBe(
      true,
    );
    for (const request of [
      { staticConcurrency: 0 },
      { staticConcurrency: 17 },
      { staticConcurrency: 1.5 },
      { staticConcurrency: 1, e2eConcurrency: 2 },
    ])
      expect(Value.Check(InvestigationSchedulerSettingsRequestSchema, request)).toBe(false);
  });

  it("requires both cleanup confirmations and original fenced ownership", () => {
    const request = {
      lease: { attemptId: "attempt-1", fence: 2, leaseToken: "synthetic-lease" },
      ownedProcessesStopped: true,
      desktopRestored: true,
    };
    expect(Value.Check(InvestigationCleanupRequestSchema, request)).toBe(true);
    for (const invalid of [
      { ...request, ownedProcessesStopped: false },
      { ...request, desktopRestored: false },
      { ...request, lease: { attemptId: "attempt-1", fence: 2 } },
    ])
      expect(Value.Check(InvestigationCleanupRequestSchema, invalid)).toBe(false);
  });

  it("accepts a bounded report failure code without arbitrary response content", () => {
    const request = {
      lease: { attemptId: "attempt-1", fence: 2, leaseToken: "synthetic-lease" },
      ownedProcessesStopped: true,
      desktopRestored: true,
      reportDeliveryFailure: { code: "invalid_logical_report_semantics", retryable: false },
    };
    expect(Value.Check(InvestigationCleanupRequestSchema, request)).toBe(true);
    for (const failure of [
      { code: "", retryable: false },
      { code: "x".repeat(129), retryable: false },
      { code: "response body\ncontents", retryable: false },
      { code: "REPORT_DELIVERY_FAILED\n", retryable: false },
      { code: "REPORT_DELIVERY_FAILED" },
      { code: "REPORT_DELIVERY_FAILED", retryable: false, body: "untrusted response" },
    ])
      expect(
        Value.Check(InvestigationCleanupRequestSchema, {
          ...request,
          reportDeliveryFailure: failure,
        }),
      ).toBe(false);
  });
});
