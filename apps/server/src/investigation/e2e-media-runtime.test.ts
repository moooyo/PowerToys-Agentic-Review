import { describe, expect, it } from "vitest";
import { parseInvestigationMediaRuntimeConfig } from "./e2e-media-runtime.js";

describe("E2E media runtime configuration", () => {
  it("uses server-side publishing by default with a bounded upload timeout", () => {
    expect(parseInvestigationMediaRuntimeConfig({})).toEqual({
      enabled: true,
      requestTimeoutMs: 120_000,
    });
    expect(
      parseInvestigationMediaRuntimeConfig({
        INVESTIGATION_MEDIA_UPLOADS_ENABLED: "false",
        INVESTIGATION_MEDIA_UPLOAD_TIMEOUT_MS: "45000",
      }),
    ).toEqual({ enabled: false, requestTimeoutMs: 45_000 });
  });
  it.each([
    { INVESTIGATION_MEDIA_UPLOADS_ENABLED: "1" },
    { INVESTIGATION_MEDIA_UPLOAD_TIMEOUT_MS: "0" },
    { INVESTIGATION_MEDIA_UPLOAD_TIMEOUT_MS: "600001" },
    { INVESTIGATION_MEDIA_UPLOAD_TIMEOUT_MS: "1000ms" },
  ])("rejects ambiguous or unbounded configuration", (configuration) => {
    expect(() => parseInvestigationMediaRuntimeConfig(configuration)).toThrow();
  });
});
