import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const directories: string[] = [];
const environment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "development",
  AGENTIC_REVIEW_HOST: "127.0.0.1",
  AGENTIC_REVIEW_ALLOW_INSECURE_HTTP: "true",
  AGENTIC_REVIEW_OPERATOR_AUTH_MODE: "loopback",
  AGENTIC_REVIEW_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
  AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT: "publication-fixture",
});
async function tokenFile(bytes: string | Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "publication-config-test-"));
  directories.push(directory);
  const path = join(directory, "token");
  await writeFile(path, bytes);
  return path;
}
async function enabled(): Promise<NodeJS.ProcessEnv> {
  return {
    ...environment(),
    AGENTIC_REVIEW_PUBLICATION_ENABLED: "true",
    AGENTIC_REVIEW_PUBLICATION_GITHUB_USER_ID: "290930",
    AGENTIC_REVIEW_PUBLICATION_TOKEN_PATH: await tokenFile("dedicated-publication-fixture-token\n"),
  };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(basename(directory).startsWith("publication-config-test-")).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
});

describe("dedicated GitHub publication configuration", () => {
  it("is absent by default and does not read a configured credential while disabled", () => {
    expect(loadConfig(environment()).publication).toBeUndefined();
    expect(
      loadConfig({ ...environment(), AGENTIC_REVIEW_PUBLICATION_TOKEN_PATH: "missing-file" })
        .publication,
    ).toBeUndefined();
  });
  it("requires explicit true rather than loose truthy values", () => {
    for (const value of ["1", "yes", "TRUE", " true "])
      expect(() =>
        loadConfig({ ...environment(), AGENTIC_REVIEW_PUBLICATION_ENABLED: value }),
      ).toThrow(/PUBLICATION_ENABLED/u);
  });
  it("loads only its separate credential and pins the numeric publishing account", async () => {
    const config = loadConfig(await enabled());
    expect(config.publication).toEqual({
      token: "dedicated-publication-fixture-token",
      githubUserId: 290930,
    });
    expect(config.github).toBeUndefined();
    expect(Object.isFrozen(config.publication)).toBe(true);
  });
  it("does not reuse the ingestion credential", async () => {
    const configuration = await enabled();
    delete configuration.AGENTIC_REVIEW_PUBLICATION_TOKEN_PATH;
    configuration.AGENTIC_REVIEW_GITHUB_TOKEN_PATH = await tokenFile(
      "ingestion-only-fixture-token",
    );
    expect(() => loadConfig(configuration)).toThrow(/PUBLICATION_TOKEN_PATH/u);
  });
  it("requires operator authentication", async () => {
    const configuration = await enabled();
    delete configuration.AGENTIC_REVIEW_OPERATOR_AUTH_MODE;
    delete configuration.AGENTIC_REVIEW_PUBLIC_ORIGIN;
    delete configuration.AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT;
    expect(() => loadConfig(configuration)).toThrow(/operator authentication/u);
  });
  it.each([undefined, "", "0", "-1", "1.5", "9007199254740992", "1e3"])(
    "rejects invalid publisher identity %s",
    async (value) => {
      const configuration = await enabled();
      configuration.AGENTIC_REVIEW_PUBLICATION_GITHUB_USER_ID = value;
      expect(() => loadConfig(configuration)).toThrow(/PUBLICATION_GITHUB_USER_ID/u);
    },
  );
  it.each([
    "",
    "has space",
    "multi\nline",
    "a\u0000b",
    "\u79d8\u5bc6",
    "x".repeat(8193),
    Buffer.from([0xff, 0xfe]),
  ])("rejects invalid credential bytes without disclosing them", async (bytes) => {
    const configuration = await enabled();
    configuration.AGENTIC_REVIEW_PUBLICATION_TOKEN_PATH = await tokenFile(bytes);
    expect(() => loadConfig(configuration)).toThrow(/PUBLICATION_TOKEN_PATH/u);
  });
  it("requires an absolute credential path", async () => {
    const configuration = await enabled();
    configuration.AGENTIC_REVIEW_PUBLICATION_TOKEN_PATH = "relative-token";
    expect(() => loadConfig(configuration)).toThrow(/absolute path/u);
  });
  it("disables publication in recovery without reading the credential", async () => {
    const configuration = await enabled();
    configuration.AGENTIC_REVIEW_RECOVERY_MAINTENANCE = "true";
    configuration.AGENTIC_REVIEW_PUBLICATION_TOKEN_PATH = "missing-file";
    expect(loadConfig(configuration).publication).toBeUndefined();
  });
});
