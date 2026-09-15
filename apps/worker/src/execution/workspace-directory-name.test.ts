import { describe, expect, it } from "vitest";
import {
  decodeAttemptDirectoryName,
  encodeAttemptDirectoryName,
  isStrictAttemptDirectoryName,
  resolveWorkspaceDirectoryNameFormat,
  type WorkspaceDirectoryNameFormat,
} from "./workspace-directory-name.js";

const maximumDigest = "f".repeat(64);
const maximumCompactName = "a1-6dp5qcb22im238nr3wvp0ic7q99w035jmy2iw7i6n43d37jtof";

describe("workspace directory identity encoding", () => {
  it("preserves legacy names by default and requires an explicit known format", () => {
    const digest = "abcdef0123456789".repeat(4);
    expect(resolveWorkspaceDirectoryNameFormat()).toBe("legacy");
    expect(encodeAttemptDirectoryName(digest)).toBe(`attempt-${digest}`);
    expect(encodeAttemptDirectoryName(digest, "legacy")).toBe(`attempt-${digest}`);
    for (const value of [null, "", "compact", "COMPACT-V1", false, {}]) {
      expect(() => resolveWorkspaceDirectoryNameFormat(value)).toThrow(TypeError);
      expect(() =>
        encodeAttemptDirectoryName(digest, value as WorkspaceDirectoryNameFormat),
      ).toThrow(TypeError);
    }
  });

  it.each([
    ["0".repeat(64), `a1-${"0".repeat(50)}`],
    [`${"0".repeat(63)}1`, `a1-${"0".repeat(49)}1`],
    [maximumDigest, maximumCompactName],
  ])("encodes the complete digest boundary %s without shortening its identity", (digest, name) => {
    expect(encodeAttemptDirectoryName(digest, "compact-v1")).toBe(name);
    expect(decodeAttemptDirectoryName(name)).toBe(digest);
    expect(decodeAttemptDirectoryName(`attempt-${digest}`)).toBe(digest);
    expect(name).toHaveLength(53);
  });

  it("retains every digest bit and has no Windows case aliases", () => {
    const names = new Set<string>();
    for (let bit = 0; bit < 256; bit += 1) {
      const digest = (1n << BigInt(bit)).toString(16).padStart(64, "0");
      const name = encodeAttemptDirectoryName(digest, "compact-v1");
      expect(decodeAttemptDirectoryName(name)).toBe(digest);
      expect(name).toBe(name.toLowerCase());
      names.add(name.toUpperCase());
    }
    expect(names.size).toBe(256);
  });

  it.each([
    "",
    "attempt-../outside",
    "a1-../outside",
    `attempt-${"A".repeat(64)}`,
    `attempt-${"a".repeat(63)}`,
    `attempt-${"a".repeat(64)}\n`,
    "a1-6dp5qcb22im238nr3wvp0ic7q99w035jmy2iw7i6n43d37jtog",
    `a1-${"z".repeat(50)}`,
    `a1-${"0".repeat(49)}`,
    `a1-${"0".repeat(51)}`,
    maximumCompactName.toUpperCase(),
    maximumCompactName.replace("q", "Q"),
    maximumCompactName.replace("q", "_"),
    `${maximumCompactName}\n`,
    `${maximumCompactName}\0`,
    `${maximumCompactName} `,
    `${maximumCompactName}\\checkout`,
    maximumCompactName.replace("a1-", "a2-"),
  ])("rejects a noncanonical or out-of-range directory name %j", (name) => {
    expect(decodeAttemptDirectoryName(name)).toBeNull();
    expect(isStrictAttemptDirectoryName(name)).toBe(false);
  });

  it.each([
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    `${"a".repeat(64)}\n`,
    "g".repeat(64),
  ])("rejects noncanonical digest input %j", (digest) =>
    expect(() => encodeAttemptDirectoryName(digest, "compact-v1")).toThrow(TypeError),
  );
});
