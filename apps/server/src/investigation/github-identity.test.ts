import { describe, expect, it, vi } from "vitest";
import {
  InvestigationGitHubIdentityResolver,
  readGitHubUserIdentity,
} from "../../dist/investigation/github-identity.js";

const profile = {
  id: 42,
  login: "fixture-user",
  avatar_url: "https://avatars.githubusercontent.com/u/42",
  html_url: "https://github.com/fixture-user",
};

describe("read-only GitHub identity resolution", () => {
  it("resolves a username to its stable ID and caches numeric and username lookups", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(profile));
    const resolver = new InvestigationGitHubIdentityResolver({ token: "synthetic-token", fetch });
    const resolved = await resolver.resolve("@fixture-user");
    expect(resolved).toEqual({
      githubUserId: 42,
      login: profile.login,
      avatarUrl: profile.avatar_url,
      htmlUrl: profile.html_url,
    });
    expect(await resolver.resolve("42")).toEqual(resolved);
    expect(await resolver.resolve("FIXTURE-USER")).toEqual(resolved);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/users/fixture-user",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("deduplicates concurrent lookups and rejects an unrelated numeric identity", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(profile));
    const resolver = new InvestigationGitHubIdentityResolver({ fetch });
    await Promise.all([resolver.resolve("42"), resolver.resolve("42")]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.github.com/user/42");
    await expect(resolver.resolve("43")).rejects.toMatchObject({
      code: "invalid_github_user_response",
    });
  });

  it("keeps an explicitly prefixed numeric username separate from a numeric user ID", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ...profile, id: 99, login: "42" }))
      .mockResolvedValueOnce(Response.json(profile));
    const resolver = new InvestigationGitHubIdentityResolver({ fetch });
    expect((await resolver.resolve("@42")).githubUserId).toBe(99);
    expect((await resolver.resolve("42")).githubUserId).toBe(42);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "https://api.github.com/users/42",
      "https://api.github.com/user/42",
    ]);
  });

  it("does not request invalid lookups or cache unsuccessful responses", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({}, { status: 404 }));
    const resolver = new InvestigationGitHubIdentityResolver({ fetch });
    for (const lookup of ["", "0", "../user", "fixture/user", "9007199254740992", " user "])
      await expect(resolver.resolve(lookup)).rejects.toMatchObject({
        code: "invalid_github_user_lookup",
      });
    expect(fetch).not.toHaveBeenCalled();
    await expect(resolver.resolve("missing")).rejects.toMatchObject({
      code: "github_user_not_found",
    });
    await expect(resolver.resolve("missing")).rejects.toMatchObject({
      code: "github_user_not_found",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves a valid identity while omitting unsafe optional URLs and tolerating absent source metadata", () => {
    expect(
      readGitHubUserIdentity({
        ...profile,
        avatar_url: "javascript:alert(1)",
        html_url: "https://user:secret@github.com/fixture-user",
      }),
    ).toEqual({ githubUserId: 42, login: profile.login, avatarUrl: null, htmlUrl: null });
    for (const input of [
      undefined,
      null,
      {},
      { id: "42", login: "fixture-user" },
      { id: 42, login: "<user>" },
    ])
      expect(readGitHubUserIdentity(input)).toBeNull();
  });
});
