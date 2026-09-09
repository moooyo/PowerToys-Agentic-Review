import { describe, expect, it } from "vitest";
import { nextConfigurationScopeState } from "./state";

describe("configuration scope verification lifecycle", () => {
  it("does not mount editors for a repository that has never been verified", () => {
    const initial = { scopeKey: "unknown-repository", wasVerified: false };
    expect(nextConfigurationScopeState(initial, initial.scopeKey, false)).toBe(initial);
  });

  it("retains editor state when a confirmed repository temporarily fails verification", () => {
    const initial = { scopeKey: "repository-1", wasVerified: false };
    const confirmed = nextConfigurationScopeState(initial, initial.scopeKey, true);
    const unavailable = nextConfigurationScopeState(confirmed, initial.scopeKey, false);
    const recovered = nextConfigurationScopeState(unavailable, initial.scopeKey, true);
    expect(confirmed.wasVerified).toBe(true);
    expect(unavailable).toBe(confirmed);
    expect(recovered).toBe(confirmed);
  });

  it("cannot carry verification across an explicit repository change", () => {
    const previous = { scopeKey: "repository-1", wasVerified: true };
    expect(nextConfigurationScopeState(previous, "repository-2", false)).toEqual({
      scopeKey: "repository-2",
      wasVerified: false,
    });
  });

  it("requires fresh verification when changing from global defaults to an unknown scope", () => {
    const global = { scopeKey: "all", wasVerified: true };
    expect(nextConfigurationScopeState(global, "invalid-scope", false).wasVerified).toBe(false);
  });
});
