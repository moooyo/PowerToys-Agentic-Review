import { describe, expect, it } from "vitest";
import { assertLinuxServerPlatform } from "./server-platform.js";

describe("Server platform boundary", () => {
  it("accepts Linux", () => {
    expect(() => assertLinuxServerPlatform("linux")).not.toThrow();
  });

  it.each(["win32", "darwin", "freebsd"] as const)("rejects %s", (platform) => {
    expect(() => assertLinuxServerPlatform(platform)).toThrow(
      "Agentic Review Server runs only on Linux.",
    );
  });
});
