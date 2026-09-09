import type { OperatorAccessContext } from "@agentic-review/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { publicationAccessRefreshVerified } from "./access-refresh";

const actor = { issuer: "https://publication.example", subject: "operator-a" };
const scope = {
  repositoryId: "repo-a",
  principal: actor,
  identityKey: ["connected", actor.issuer, actor.subject],
  authenticationEpoch: 1,
};
const prefix = ["operator-access", "context", ...scope.identityKey, scope.authenticationEpoch];
const global: OperatorAccessContext = {
  principal: actor,
  platformAdministrator: false,
  repository: null,
};
const repository: OperatorAccessContext = {
  ...global,
  repository: {
    repositoryId: "repo-a",
    role: "viewer",
    source: "repository",
    permissions: ["read"],
  },
};
function prepared() {
  const client = new QueryClient();
  client.setQueryData([...prefix, null], global);
  client.setQueryData([...prefix, "repo-a"], repository);
  return client;
}
describe("explicit publication access recovery verification", () => {
  it("accepts fresh matching repository read authority without requiring publication configure", () => {
    const client = prepared();
    expect(publicationAccessRefreshVerified(client, scope)).toBe(true);
    client.clear();
  });
  it.each([null, "repo-a"])(
    "rejects a failed refetch even if old allowed data remains cached: %s",
    (target) => {
      const client = prepared();
      client
        .getQueryCache()
        .find({ queryKey: [...prefix, target] })
        ?.setState({ status: "error", error: new Error("Refetch failed") });
      expect(publicationAccessRefreshVerified(client, scope)).toBe(false);
      client.clear();
    },
  );
  it.each([null, "repo-a"])("rejects a still-fetching access observation: %s", (target) => {
    const client = prepared();
    client
      .getQueryCache()
      .find({ queryKey: [...prefix, target] })
      ?.setState({ fetchStatus: "fetching" });
    expect(publicationAccessRefreshVerified(client, scope)).toBe(false);
    client.clear();
  });
  it.each([null, "repo-a"])("rejects a different actor in a successful response: %s", (target) => {
    const client = prepared();
    client.setQueryData([...prefix, target], {
      ...(target === null ? global : repository),
      principal: { ...actor, subject: "other" },
    });
    expect(publicationAccessRefreshVerified(client, scope)).toBe(false);
    client.clear();
  });
  it("rejects a foreign repository or revoked read permission", () => {
    const client = prepared();
    for (const value of [
      { ...repository, repository: { ...repository.repository, repositoryId: "repo-b" } },
      { ...repository, repository: { ...repository.repository, permissions: [] } },
    ]) {
      client.setQueryData([...prefix, "repo-a"], value);
      expect(publicationAccessRefreshVerified(client, scope)).toBe(false);
    }
    client.clear();
  });
  it("does not reuse access from a previous authentication epoch, repository, or signed-out actor", () => {
    const client = prepared();
    expect(publicationAccessRefreshVerified(client, { ...scope, authenticationEpoch: 2 })).toBe(
      false,
    );
    expect(publicationAccessRefreshVerified(client, { ...scope, repositoryId: "repo-b" })).toBe(
      false,
    );
    expect(publicationAccessRefreshVerified(client, { ...scope, principal: null })).toBe(false);
    client.clear();
  });
});
