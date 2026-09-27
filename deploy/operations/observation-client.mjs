import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

export function observationOrigin(value) {
  const url = new URL(value);
  assert(
    (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1")) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "",
    "Use an HTTPS origin or the literal HTTP loopback origin, without credentials or a path.",
  );
  return url.origin;
}

export async function readJsonFile(path, maximumBytes = 1_048_576) {
  const state = await lstat(path);
  assert(state.isFile() && !state.isSymbolicLink(), "Input must be an ordinary JSON file.");
  assert(state.size <= maximumBytes, "JSON input exceeds its size limit.");
  const bytes = await readFile(path);
  assert(bytes.length <= maximumBytes, "JSON input changed beyond its size limit.");
  return JSON.parse(bytes.toString("utf8"));
}

export async function responseBytes(response, maximumBytes = 1_048_576) {
  const chunks = [];
  let length = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        assert(length <= maximumBytes, "Observation response exceeds its size limit.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  return Buffer.concat(chunks);
}

/** The only writes this client can make are its own login and logout. */
export async function openObservationSession(
  originValue,
  credentials,
  request = globalThis.fetch,
  now = Date.now,
) {
  const origin = observationOrigin(originValue);
  assert(
    typeof credentials?.username === "string" &&
      typeof credentials?.password === "string" &&
      Object.keys(credentials).every((key) => key === "username" || key === "password"),
    "Credentials must contain only username and password.",
  );
  let cookie = "";
  let expiresAt = 0;
  async function send(path, method, payload) {
    const response = await request(`${origin}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        origin,
        "sec-fetch-site": "same-origin",
        ...(cookie === "" ? {} : { cookie }),
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    assert(response.ok, `Observation request ${method} ${path} returned HTTP ${response.status}.`);
    return response;
  }
  async function logout() {
    await responseBytes(await send("/api/auth/logout", "POST"));
    cookie = "";
  }
  async function authenticate() {
    const login = await send("/api/auth/login", "POST", credentials);
    const cookies = login.headers.getSetCookie();
    cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
    assert(
      cookie.length > 0 && cookie.length < 8192,
      "Login did not return a bounded session cookie.",
    );
    try {
      const session = JSON.parse((await responseBytes(login)).toString("utf8"));
      assert(
        session.authenticated === true && session.user?.isAdmin === true,
        "Operations observations require an administrator session.",
      );
      expiresAt = Date.parse(session.expiresAt);
      assert(
        Number.isFinite(expiresAt) && expiresAt > now() + 60_000,
        "The observation session must remain valid for at least one minute.",
      );
    } catch (error) {
      await logout();
      throw error;
    }
  }
  async function ensureSession() {
    if (now() + 60_000 < expiresAt) return;
    await logout();
    await authenticate();
  }
  await authenticate();
  return {
    origin,
    async status() {
      await ensureSession();
      return JSON.parse(
        (await responseBytes(await send("/api/operations/status", "GET"))).toString("utf8"),
      );
    },
    async deployment(dashboardIndexSha256) {
      await ensureSession();
      assert(
        /^[a-f0-9]{64}$/u.test(dashboardIndexSha256),
        "Supply the sealed Dashboard index SHA-256.",
      );
      const health = JSON.parse(
        (await responseBytes(await send("/health/live", "GET"))).toString("utf8"),
      );
      assert.equal(health.status, "ok", "Server liveness is not healthy.");
      const bytes = await responseBytes(await send("/", "GET"));
      const observed = createHash("sha256").update(bytes).digest("hex");
      assert.equal(
        observed,
        dashboardIndexSha256,
        "The served Dashboard differs from the sealed index.",
      );
      return {
        observedAt: new Date().toISOString(),
        health: "ok",
        dashboardIndexSha256: observed,
        scope:
          "Server liveness and exact Dashboard index bytes; not asset, browser, Worker, or build provenance acceptance.",
      };
    },
    async close() {
      if (cookie !== "") await logout();
    },
  };
}
