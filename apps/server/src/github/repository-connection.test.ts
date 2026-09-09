import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRepositoryConnectionResolver,
  RepositoryConnectionError,
} from "./repository-connection.js";

const repositoryPayload = {
  id: 42,
  node_id: "R_42",
  full_name: "microsoft/PowerToys",
  default_branch: "main",
  private: false,
};

const repositorySnapshot = {
  githubRepositoryId: 42,
  githubNodeId: "R_42",
  ownerLogin: "microsoft",
  name: "PowerToys",
  fullName: "microsoft/PowerToys",
  htmlUrl: "https://github.com/microsoft/PowerToys",
  defaultBranch: "main",
  isPrivate: false,
};

const maximumBodyBytes = 2 * 1024 * 1024;

async function expectFailure(
  operation: Promise<unknown>,
  code: string,
  statusCode: number,
  secrets: readonly string[] = [],
): Promise<RepositoryConnectionError> {
  const error: unknown = await operation.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(RepositoryConnectionError);
  expect(error).toMatchObject({ code, statusCode });
  const failure = error as RepositoryConnectionError;
  expect(failure.message.trim()).not.toBe("");
  expect(failure.cause).toBeUndefined();
  for (const secret of secrets) {
    expect(inspect(failure, { showHidden: true, depth: 5 })).not.toContain(secret);
  }
  return failure;
}

function redirect(location: string, status = 301): Response {
  return new Response(null, { status, headers: { location } });
}

function hangingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    { pull: () => new Promise<void>(() => undefined) },
    { highWaterMark: 0 },
  );
}

function chunkedBody(bytes: Uint8Array, chunkSize = 65_536): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createRepositoryConnectionResolver", () => {
  it.each([undefined, "github-secret-token"])(
    "resolves metadata using fixed GitHub headers with token %s",
    async (token) => {
      const fetchImplementation = vi.fn<typeof fetch>(async () =>
        Response.json({
          ...repositoryPayload,
          html_url: "https://attacker.example/credential-trap",
          owner: { login: "attacker" },
          name: "untrusted-name",
        }),
      );
      const resolveRepository = createRepositoryConnectionResolver({
        ...(token === undefined ? {} : { token }),
        fetchImplementation,
      });

      await expect(resolveRepository("microsoft/PowerToys", 42)).resolves.toEqual(
        repositorySnapshot,
      );

      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      const [input, init] = fetchImplementation.mock.calls[0] ?? [];
      const headers = new Headers(init?.headers);
      expect(String(input)).toBe("https://api.github.com/repos/microsoft/PowerToys");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(init?.credentials).toBe("omit");
      expect(headers.get("accept")).toBe("application/vnd.github+json");
      expect(headers.get("user-agent")).toBeTruthy();
      expect(headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(headers.get("authorization")).toBe(token === undefined ? null : `Bearer ${token}`);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (token !== undefined) {
        expect(String(input)).not.toContain(token);
      }
    },
  );

  it("accepts canonical metadata without an expected repository ID", async () => {
    const resolveRepository = createRepositoryConnectionResolver({
      fetchImplementation: async () => Response.json(repositoryPayload),
    });

    await expect(resolveRepository("microsoft/PowerToys")).resolves.toEqual(repositorySnapshot);
  });

  it("rejects a repository whose numeric identity changed", async () => {
    const resolveRepository = createRepositoryConnectionResolver({
      fetchImplementation: async () => Response.json(repositoryPayload),
    });

    await expectFailure(
      resolveRepository("microsoft/PowerToys", 43),
      "repository_identity_changed",
      409,
    );
  });

  it.each([
    "",
    "microsoft",
    "microsoft/PowerToys/extra",
    "https://github.com/microsoft/PowerToys",
    "microsoft/PowerToys?token=secret",
    "microsoft/PowerToys#fragment",
    "microsoft/PowerToys\n",
    "microsoft/..",
    "microsoft/%2e%2e",
    "microsoft\\PowerToys",
    "microsoft/Power Toys",
    `microsoft/${"a".repeat(101)}`,
  ])("rejects invalid repository name %j before fetching", async (fullName) => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const resolveRepository = createRepositoryConnectionResolver({ fetchImplementation });

    await expectFailure(resolveRepository(fullName), "repository_request_invalid", 400);

    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid expected repository ID %s before fetching",
    async (expectedId) => {
      const fetchImplementation = vi.fn<typeof fetch>();
      const resolveRepository = createRepositoryConnectionResolver({ fetchImplementation });

      await expectFailure(
        resolveRepository("microsoft/PowerToys", expectedId),
        "repository_request_invalid",
        400,
      );

      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it.each(["", " ", "\t", "secret\r\ninjected", "secret\u0000", "secret\u007f"])(
    "rejects invalid token configuration %j without exposing it",
    async (token) => {
      const fetchImplementation = vi.fn<typeof fetch>();
      await expectFailure(
        Promise.resolve().then(() =>
          createRepositoryConnectionResolver({ token, fetchImplementation })("microsoft/PowerToys"),
        ),
        "repository_configuration_invalid",
        503,
        token.trim() === "" ? [] : [token],
      );
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 15_001])(
    "rejects invalid timeout configuration %s before fetching",
    async (timeoutMs) => {
      const fetchImplementation = vi.fn<typeof fetch>();
      await expectFailure(
        Promise.resolve().then(() =>
          createRepositoryConnectionResolver({ timeoutMs, fetchImplementation })(
            "microsoft/PowerToys",
          ),
        ),
        "repository_configuration_invalid",
        503,
      );
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 404, 410])(
    "maps inaccessible HTTP status %s to a safe error",
    async (status) => {
      const token = "private-token-never-exposed";
      const body = "private-repository-response-body";
      const resolveRepository = createRepositoryConnectionResolver({
        token,
        fetchImplementation: async () => new Response(body, { status }),
      });

      await expectFailure(
        resolveRepository("microsoft/PowerToys"),
        "repository_not_accessible",
        404,
        [token, body],
      );
    },
  );

  it.each([
    { status: 429, headers: new Headers() },
    { status: 500, headers: new Headers() },
    { status: 502, headers: new Headers() },
    { status: 503, headers: new Headers() },
    { status: 403, headers: new Headers({ "x-ratelimit-remaining": "0" }) },
    { status: 403, headers: new Headers({ "retry-after": "60" }) },
  ])(
    "maps unavailable HTTP response $status with $headers to a safe error",
    async ({ status, headers }) => {
      const body = "sensitive-upstream-diagnostic";
      const resolveRepository = createRepositoryConnectionResolver({
        fetchImplementation: async () => new Response(body, { status, headers }),
      });

      await expectFailure(
        resolveRepository("microsoft/PowerToys"),
        "repository_upstream_unavailable",
        503,
        [body],
      );
    },
  );

  it("redacts network exception details and credentials", async () => {
    const token = "network-secret-token";
    const diagnostic = "upstream-network-private-diagnostic";
    const resolveRepository = createRepositoryConnectionResolver({
      token,
      fetchImplementation: async () => {
        throw new Error(`${diagnostic}: Authorization: Bearer ${token}`);
      },
    });

    await expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_upstream_unavailable",
      503,
      [token, diagnostic],
    );
  });

  it.each(["id", "node_id", "full_name", "default_branch", "private"])(
    "requires the GitHub response field %s",
    async (field) => {
      const payload: Record<string, unknown> = { ...repositoryPayload };
      delete payload[field];
      const resolveRepository = createRepositoryConnectionResolver({
        fetchImplementation: async () => Response.json(payload),
      });

      await expectFailure(
        resolveRepository("microsoft/PowerToys"),
        "repository_response_invalid",
        502,
      );
    },
  );

  it("accepts the maximum supported field lengths and safe numeric identity", async () => {
    const owner = "a".repeat(100);
    const name = "b".repeat(100);
    const resolveRepository = createRepositoryConnectionResolver({
      fetchImplementation: async () =>
        Response.json({
          id: Number.MAX_SAFE_INTEGER,
          node_id: "R".repeat(256),
          full_name: `${owner}/${name}`,
          default_branch: "a".repeat(255),
          private: true,
        }),
    });

    await expect(
      resolveRepository("microsoft/PowerToys", Number.MAX_SAFE_INTEGER),
    ).resolves.toEqual({
      githubRepositoryId: Number.MAX_SAFE_INTEGER,
      githubNodeId: "R".repeat(256),
      ownerLogin: owner,
      name,
      fullName: `${owner}/${name}`,
      htmlUrl: `https://github.com/${owner}/${name}`,
      defaultBranch: "a".repeat(255),
      isPrivate: true,
    });
  });

  it.each([
    { label: "zero ID", replacement: { id: 0 } },
    { label: "negative ID", replacement: { id: -42 } },
    { label: "fractional ID", replacement: { id: 42.5 } },
    { label: "unsafe ID", replacement: { id: Number.MAX_SAFE_INTEGER + 1 } },
    { label: "string ID", replacement: { id: "42" } },
    { label: "empty node ID", replacement: { node_id: "" } },
    { label: "numeric node ID", replacement: { node_id: 42 } },
    { label: "long node ID", replacement: { node_id: "R".repeat(257) } },
    { label: "node ID containing whitespace", replacement: { node_id: "R 42" } },
    { label: "node ID containing non-ASCII whitespace", replacement: { node_id: "R\u00a042" } },
    { label: "node ID containing an ASCII control", replacement: { node_id: "R\u000042" } },
    { label: "node ID containing DEL", replacement: { node_id: "R\u007f42" } },
    { label: "invalid full name", replacement: { full_name: "microsoft/PowerToys/extra" } },
    {
      label: "full name with trailing newline",
      replacement: { full_name: "microsoft/PowerToys\n" },
    },
    { label: "full name with traversal", replacement: { full_name: "microsoft/.." } },
    {
      label: "full name with an oversized owner",
      replacement: { full_name: `${"a".repeat(101)}/repo` },
    },
    {
      label: "full name with an oversized repository",
      replacement: { full_name: `microsoft/${"a".repeat(101)}` },
    },
    { label: "empty default branch", replacement: { default_branch: "" } },
    { label: "non-string default branch", replacement: { default_branch: 42 } },
    { label: "oversized default branch", replacement: { default_branch: "a".repeat(256) } },
    { label: "default branch with leading space", replacement: { default_branch: " main" } },
    { label: "default branch with trailing space", replacement: { default_branch: "main " } },
    {
      label: "default branch with leading Unicode whitespace",
      replacement: { default_branch: "\u00a0main" },
    },
    { label: "default branch containing a tab", replacement: { default_branch: "feature/\tmain" } },
    {
      label: "default branch containing a newline",
      replacement: { default_branch: "feature/\nmain" },
    },
    {
      label: "default branch containing DEL",
      replacement: { default_branch: "feature/\u007fmain" },
    },
    { label: "string private flag", replacement: { private: "false" } },
    { label: "numeric private flag", replacement: { private: 0 } },
  ])("rejects malformed response metadata: $label", async ({ replacement }) => {
    const resolveRepository = createRepositoryConnectionResolver({
      fetchImplementation: async () => Response.json({ ...repositoryPayload, ...replacement }),
    });

    await expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_response_invalid",
      502,
    );
  });

  it.each(["application/json", "application/json; charset=utf-8", "application/vnd.github+json"])(
    "accepts the supported JSON media type %s",
    async (contentType) => {
      const resolveRepository = createRepositoryConnectionResolver({
        fetchImplementation: async () =>
          new Response(JSON.stringify(repositoryPayload), {
            headers: { "content-type": contentType },
          }),
      });

      await expect(resolveRepository("microsoft/PowerToys")).resolves.toEqual(repositorySnapshot);
    },
  );

  it.each([
    undefined,
    "text/plain",
    "text/html",
    "application/jsonp",
    "application/problem+json",
    "application/vnd.github+json-extra",
  ])("rejects unsupported or missing JSON media type %s", async (contentType) => {
    const resolveRepository = createRepositoryConnectionResolver({
      fetchImplementation: async () =>
        new Response(new TextEncoder().encode(JSON.stringify(repositoryPayload)), {
          headers: contentType === undefined ? {} : { "content-type": contentType },
        }),
    });

    await expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_response_invalid",
      502,
    );
  });

  it.each(["{", "null", "[]", '"private-response-string"'])(
    "rejects malformed JSON or non-object response %s",
    async (body) => {
      const resolveRepository = createRepositoryConnectionResolver({
        fetchImplementation: async () =>
          new Response(body, {
            headers: { "content-type": "application/json" },
          }),
      });

      await expectFailure(
        resolveRepository("microsoft/PowerToys"),
        "repository_response_invalid",
        502,
        body.includes("private-response-string") ? ["private-response-string"] : [],
      );
    },
  );

  it("rejects invalid UTF-8 even in an unused JSON field", async () => {
    const encoder = new TextEncoder();
    const prefix = `${JSON.stringify(repositoryPayload).slice(0, -1)},"ignored":"`;
    const bytes = new Uint8Array([...encoder.encode(prefix), 0xc3, 0x28, ...encoder.encode('"}')]);
    const resolveRepository = createRepositoryConnectionResolver({
      fetchImplementation: async () =>
        new Response(bytes, {
          headers: { "content-type": "application/json" },
        }),
    });

    await expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_response_invalid",
      502,
    );
  });

  it.each([201, 204, 304])("requires a final 200 response instead of HTTP %s", async (status) => {
    const resolveRepository = createRepositoryConnectionResolver({
      fetchImplementation: async () =>
        new Response(null, {
          status,
          headers: { "content-type": "application/json" },
        }),
    });

    await expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_response_invalid",
      502,
    );
  });

  it("preserves a valid UTF-8 character split between streamed chunks", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ...repositoryPayload, default_branch: "feature/\u00e9" }),
    );
    const splitAt = bytes.indexOf(0xc3) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    });
    const resolveRepository = createRepositoryConnectionResolver({
      fetchImplementation: async () =>
        new Response(body, {
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(resolveRepository("microsoft/PowerToys")).resolves.toEqual({
      ...repositorySnapshot,
      defaultBranch: "feature/\u00e9",
    });
  });

  it("rejects an oversized Content-Length before reading the response body", async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(repositoryPayload)));
      controller.close();
    });
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const resolveRepository = createRepositoryConnectionResolver({
      fetchImplementation: async () =>
        new Response(body, {
          headers: {
            "content-type": "application/json",
            "content-length": String(maximumBodyBytes + 1),
          },
        }),
    });

    await expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_response_invalid",
      502,
    );
    expect(pull).not.toHaveBeenCalled();
  });

  it("accepts a valid JSON body of exactly 2 MiB", async () => {
    const encoder = new TextEncoder();
    const emptyPayload = { ...repositoryPayload, padding: "" };
    const paddingLength =
      maximumBodyBytes - encoder.encode(JSON.stringify(emptyPayload)).byteLength;
    const bytes = encoder.encode(
      JSON.stringify({ ...emptyPayload, padding: "a".repeat(paddingLength) }),
    );
    expect(bytes.byteLength).toBe(maximumBodyBytes);
    const resolveRepository = createRepositoryConnectionResolver({
      fetchImplementation: async () =>
        new Response(chunkedBody(bytes), {
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(resolveRepository("microsoft/PowerToys")).resolves.toEqual(repositorySnapshot);
  });

  it.each([undefined, "100"])(
    "enforces the streamed byte limit with Content-Length %s and multibyte text",
    async (contentLength) => {
      const text = JSON.stringify({
        ...repositoryPayload,
        padding: "\u00e9".repeat(maximumBodyBytes / 2),
      });
      const bytes = new TextEncoder().encode(text);
      expect(text.length).toBeLessThan(maximumBodyBytes);
      expect(bytes.byteLength).toBeGreaterThan(maximumBodyBytes);
      const resolveRepository = createRepositoryConnectionResolver({
        fetchImplementation: async () =>
          new Response(chunkedBody(bytes), {
            headers: {
              "content-type": "application/json",
              ...(contentLength === undefined ? {} : { "content-length": contentLength }),
            },
          }),
      });

      await expectFailure(
        resolveRepository("microsoft/PowerToys"),
        "repository_response_invalid",
        502,
      );
    },
  );

  it("discards the body reader's private error details", async () => {
    const diagnostic = "private-body-reader-diagnostic";
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(diagnostic));
      },
    });
    const resolveRepository = createRepositoryConnectionResolver({
      fetchImplementation: async () =>
        new Response(body, {
          headers: { "content-type": "application/json" },
        }),
    });

    await expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_upstream_unavailable",
      503,
      [diagnostic],
    );
  });

  it("follows at most two safe redirects and returns the canonical renamed repository", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect("/repositories/42"))
      .mockResolvedValueOnce(redirect("https://api.github.com/repos/new-owner/new-name", 302))
      .mockResolvedValueOnce(
        Response.json({ ...repositoryPayload, full_name: "new-owner/new-name" }),
      );
    const resolveRepository = createRepositoryConnectionResolver({
      token: "redirect-secret-token",
      fetchImplementation,
    });

    await expect(resolveRepository("microsoft/PowerToys", 42)).resolves.toEqual({
      ...repositorySnapshot,
      ownerLogin: "new-owner",
      name: "new-name",
      fullName: "new-owner/new-name",
      htmlUrl: "https://github.com/new-owner/new-name",
    });
    expect(fetchImplementation.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.github.com/repos/microsoft/PowerToys",
      "https://api.github.com/repositories/42",
      "https://api.github.com/repos/new-owner/new-name",
    ]);
    for (const [input, init] of fetchImplementation.mock.calls) {
      expect(new URL(String(input)).origin).toBe("https://api.github.com");
      expect(String(input)).not.toContain("redirect-secret-token");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer redirect-secret-token");
    }
  });

  it.each([
    "https://attacker.example/repos/microsoft/PowerToys",
    "https://api.github.com.attacker.example/repos/microsoft/PowerToys",
    "http://api.github.com/repos/microsoft/PowerToys",
    "https://api.github.com:444/repos/microsoft/PowerToys",
    "https://user:password@api.github.com/repos/microsoft/PowerToys",
    "https://@api.github.com/repos/microsoft/PowerToys",
    "//api.github.com/repos/microsoft/PowerToys",
    "repos/microsoft/PowerToys",
    "/repos/new-owner/new-name?access_token=secret",
    "/repos/new-owner/new-name#fragment",
    "/repos/new-owner/%6eew-name",
    "/repos/old-owner/../new-owner/new-name",
    "https://api.github.com/repos/old-owner/../new-owner/new-name",
    "/repos/new-owner/new-name/",
    "/repos/new-owner/new-name/pulls",
    "/repos\\new-owner\\new-name",
    "/repositories/0",
    "/repositories/042",
    "/repositories/-1",
    "/repositories/1.5",
    `/repositories/${Number.MAX_SAFE_INTEGER + 1}`,
    "/repositories/42?extra=true",
    "/users/new-owner",
  ])("rejects unsafe redirect location %j before another request", async (location) => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => redirect(location));
    const resolveRepository = createRepositoryConnectionResolver({
      token: "redirect-credential-must-stay-private",
      fetchImplementation,
    });

    await expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_response_invalid",
      502,
      [location, "redirect-credential-must-stay-private"],
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect without a location", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 302 }),
    );
    const resolveRepository = createRepositoryConnectionResolver({ fetchImplementation });

    await expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_response_invalid",
      502,
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("rejects a response that was automatically redirected by the transport", async () => {
    const response = Response.json(repositoryPayload);
    Object.defineProperty(response, "redirected", { value: true });
    const fetchImplementation = vi.fn<typeof fetch>(async () => response);
    const resolveRepository = createRepositoryConnectionResolver({ fetchImplementation });

    await expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_response_invalid",
      502,
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("rejects a third redirect without following it", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect("/repositories/42"))
      .mockResolvedValueOnce(redirect("/repos/new-owner/new-name"))
      .mockResolvedValueOnce(redirect("/repos/another-owner/another-name"));
    const resolveRepository = createRepositoryConnectionResolver({ fetchImplementation });

    await expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_response_invalid",
      502,
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("actively times out a fetch that ignores its abort signal after the default deadline", async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | null | undefined;
    const fetchImplementation = vi.fn<typeof fetch>((_input, init) => {
      upstreamSignal = init?.signal;
      return new Promise<Response>(() => undefined);
    });
    const resolveRepository = createRepositoryConnectionResolver({ fetchImplementation });
    let settled = false;
    const outcome = expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_connection_timeout",
      503,
    ).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;

    expect(upstreamSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("actively times out a response body that never completes", async () => {
    vi.useFakeTimers();
    const resolveRepository = createRepositoryConnectionResolver({
      timeoutMs: 100,
      fetchImplementation: async () =>
        new Response(hangingBody(), {
          headers: { "content-type": "application/json" },
        }),
    });
    let settled = false;
    const outcome = expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_connection_timeout",
      503,
    ).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one absolute deadline across redirects, fetches, and the final body", async () => {
    vi.useFakeTimers();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(redirect("/repositories/42")), 40);
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(hangingBody(), {
                    headers: { "content-type": "application/json" },
                  }),
                ),
              40,
            );
          }),
      );
    const resolveRepository = createRepositoryConnectionResolver({
      timeoutMs: 100,
      fetchImplementation,
    });
    let settled = false;
    const outcome = expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_connection_timeout",
      503,
    ).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an already cancelled parent signal without a request or leaked reason", async () => {
    const controller = new AbortController();
    const secret = "private-pre-cancellation-reason";
    controller.abort(new Error(secret));
    const fetchImplementation = vi.fn<typeof fetch>();
    const resolveRepository = createRepositoryConnectionResolver({
      signal: controller.signal,
      fetchImplementation,
    });

    await expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_connection_cancelled",
      503,
      [secret],
    );
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each(["fetch", "body"] as const)(
    "actively cancels a hung %s without forwarding the parent's private reason",
    async (phase) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const secret = "private-active-cancellation-reason";
      const reason = new Error(secret);
      let upstreamSignal: AbortSignal | null | undefined;
      const fetchImplementation = vi.fn<typeof fetch>((_input, init) => {
        upstreamSignal = init?.signal;
        return phase === "fetch"
          ? new Promise<Response>(() => undefined)
          : Promise.resolve(
              new Response(hangingBody(), {
                headers: { "content-type": "application/json" },
              }),
            );
      });
      const resolveRepository = createRepositoryConnectionResolver({
        signal: controller.signal,
        fetchImplementation,
      });
      const outcome = expectFailure(
        resolveRepository("microsoft/PowerToys"),
        "repository_connection_cancelled",
        503,
        [secret],
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(upstreamSignal).toBeInstanceOf(AbortSignal);
      expect(upstreamSignal).not.toBe(controller.signal);

      controller.abort(reason);
      await outcome;

      expect(upstreamSignal?.aborted).toBe(true);
      expect(upstreamSignal?.reason).not.toBe(reason);
      expect(inspect(upstreamSignal?.reason, { showHidden: true, depth: 5 })).not.toContain(secret);
      expect(controller.signal.reason).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("disposes a response when the absolute deadline elapsed before its timer ran", async () => {
    vi.useFakeTimers();
    const monotonicClock = vi.spyOn(performance, "now").mockReturnValue(0);
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "content-type": "application/json" },
    });
    let deliver: ((response: Response) => void) | undefined;
    const resolveRepository = createRepositoryConnectionResolver({
      timeoutMs: 100,
      fetchImplementation: () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    });
    const outcome = expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_connection_timeout",
      503,
    );

    monotonicClock.mockReturnValue(101);
    deliver?.(response);
    await outcome;
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes a late response from a transport that ignored timeout cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "content-type": "application/json" },
    });
    let deliver: ((response: Response) => void) | undefined;
    const resolveRepository = createRepositoryConnectionResolver({
      timeoutMs: 100,
      fetchImplementation: () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    });
    const outcome = expectFailure(
      resolveRepository("microsoft/PowerToys"),
      "repository_connection_timeout",
      503,
    );

    await vi.advanceTimersByTimeAsync(100);
    await outcome;
    expect(cancel).not.toHaveBeenCalled();
    deliver?.(response);
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up a successful request without cancelling the caller or a later request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    const resolveRepository = createRepositoryConnectionResolver({
      signal: controller.signal,
      fetchImplementation: async (_input, init) => {
        signals.push(init?.signal);
        return Response.json(repositoryPayload);
      },
    });

    await expect(resolveRepository("microsoft/PowerToys")).resolves.toEqual(repositorySnapshot);
    await expect(resolveRepository("microsoft/PowerToys")).resolves.toEqual(repositorySnapshot);

    expect(controller.signal.aborted).toBe(false);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
