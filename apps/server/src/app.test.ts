import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sanitizeRequestLogUrl } from "../dist/app.js";

describe("Server application Worker authentication wiring", () => {
  it("redacts bearer credentials and wires one database-backed Worker boundary", async () => {
    const source = await readFile(new URL("./app.ts", import.meta.url), "utf8");

    expect(source).toContain('paths: ["req.headers.authorization"]');
    expect(source).toContain('censor: "[REDACTED]"');
    expect(source).toContain("url: sanitizeRequestLogUrl(request.url)");
    expect(source).toContain("registerWorkerCredentialRoutes(credentialScope");
    expect(source).toContain("registerWorkerRoutes(workerScope");
    expect(source).toContain("registerWorkerArtifactRoutes(workerScope");
    expect(source).toContain("database: dependencies.database");
    expect(source).toContain("await workerScope.register(rateLimit");
    expect(source).toContain("workerScope.addHook(");
    expect(source).toContain("workerScope.rateLimit(");
    expect(source).toContain("credentialScope.rateLimit(");
    expect(source).toContain("operatorWorkerCredentialRequestsPerMinute = 300");
    expect(source).toContain("error.statusCode === 429");
    expect(source).toContain('code: "request_rate_limited"');
    expect(source).not.toContain("workerCertificateBindings");
    expect(source).not.toContain("allowInsecureWorkerAuth");
  });

  it("removes query strings and Worker tokens from request log URLs", () => {
    const token = `arw1_${Buffer.alloc(32, 17).toString("base64url")}`;

    expect(sanitizeRequestLogUrl(`/api/v1/worker/instances?token=${token}`)).toBe(
      "/api/v1/worker/instances",
    );
    expect(sanitizeRequestLogUrl(`/api/${token}/probe`)).toBe("/api/[REDACTED]/probe");
  });
});
