import assert from "node:assert/strict";
import { test } from "node:test";
import { observationOrigin, openObservationSession, responseBytes } from "./observation-client.mjs";

test("observation origins exclude plaintext remote hosts and embedded credentials", () => {
  assert.equal(observationOrigin("http://127.0.0.1:8000/"), "http://127.0.0.1:8000");
  assert.equal(observationOrigin("https://review.example/"), "https://review.example");
  for (const origin of [
    "http://example.com",
    "http://localhost:8000",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com/?query=secret",
  ])
    assert.throws(() => observationOrigin(origin));
});

test("the observer uses only fixed read routes and its own session lifecycle", async () => {
  const requests = [];
  const session = await openObservationSession(
    "http://127.0.0.1:8000",
    { username: "synthetic-admin", password: "synthetic-password" },
    async (url, options) => {
      requests.push({ url, ...options });
      assert.equal(options.redirect, "error");
      if (url.endsWith("/api/auth/login"))
        return Response.json(
          { authenticated: true, expiresAt: "2100-01-01T00:00:00Z", user: { isAdmin: true } },
          { headers: { "set-cookie": "session=synthetic; HttpOnly" } },
        );
      if (url.endsWith("/api/auth/logout")) return new Response(null, { status: 204 });
      assert(url.endsWith("/api/operations/status"));
      assert.equal(options.headers.cookie, "session=synthetic");
      return Response.json({ schemaVersion: "InvestigationOperationsStatusV1" });
    },
  );
  await session.status();
  await session.close();
  assert.deepEqual(
    requests.map((entry) => [new URL(entry.url).pathname, entry.method]),
    [
      ["/api/auth/login", "POST"],
      ["/api/operations/status", "GET"],
      ["/api/auth/logout", "POST"],
    ],
  );
});

test("a non-admin session is logged out before refusing operations access", async () => {
  const paths = [];
  await assert.rejects(() =>
    openObservationSession(
      "https://review.example",
      { username: "reader", password: "synthetic" },
      async (url) => {
        paths.push(new URL(url).pathname);
        if (url.endsWith("/login"))
          return Response.json(
            { authenticated: true, user: { isAdmin: false } },
            { headers: { "set-cookie": "session=synthetic" } },
          );
        return new Response(null, { status: 204 });
      },
    ),
  );
  assert.deepEqual(paths, ["/api/auth/login", "/api/auth/logout"]);
});

test("response bytes are bounded even without a content-length header", async () => {
  await assert.rejects(() => responseBytes(new Response("12345"), 4));
});

test("long observations rotate only their own session before expiry", async () => {
  let time = Date.UTC(2026, 0, 1);
  const paths = [];
  const session = await openObservationSession(
    "https://review.example",
    { username: "admin", password: "synthetic" },
    async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith("/login"))
        return Response.json(
          {
            authenticated: true,
            expiresAt: new Date(time + 120_000).toISOString(),
            user: { isAdmin: true },
          },
          { headers: { "set-cookie": "session=synthetic" } },
        );
      if (path.endsWith("/logout")) return new Response(null, { status: 204 });
      return Response.json({ schemaVersion: "InvestigationOperationsStatusV1" });
    },
    () => time,
  );
  time += 70_000;
  await session.status();
  await session.close();
  assert.deepEqual(paths, [
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/login",
    "/api/operations/status",
    "/api/auth/logout",
  ]);
});
