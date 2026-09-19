import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpTransport,
  decodeResponse,
  fetchInvestigationArtifactContent,
  InvestigationHttpError,
  queryString,
  resumeInvestigationRequests,
  subscribeInvestigationSessionExpired,
  suspendInvestigationRequests,
} from "./transport";

const ResultSchema = Type.Object(
  { outcome: Type.Literal("completed") },
  { additionalProperties: false },
);

afterEach(() => resumeInvestigationRequests());

describe("investigation transport", () => {
  it("does not download an expired artifact error response as evidence content", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: "artifact_expired", message: "Artifact content expired." },
          { status: 410 },
        ),
      );
    await expect(
      fetchInvestigationArtifactContent("evidence:report", undefined, fetcher),
    ).rejects.toMatchObject({
      status: 410,
      message: expect.stringContaining("artifact_expired"),
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/artifacts/evidence%3Areport/content",
      expect.objectContaining({ credentials: "include", cache: "no-store", redirect: "error" }),
    );
  });

  it("expires the workspace session when an artifact download is unauthorized", async () => {
    const expired = vi.fn();
    const unsubscribe = subscribeInvestigationSessionExpired(expired);
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 401 }));
      await expect(
        fetchInvestigationArtifactContent("evidence", undefined, fetcher),
      ).rejects.toMatchObject({ status: 401 });
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it("discards artifact bytes that finish after the workspace session is suspended", async () => {
    let complete!: (content: Blob) => void;
    const response = new Response("artifact");
    const blob = vi.spyOn(response, "blob").mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          complete = resolve;
        }),
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const pending = fetchInvestigationArtifactContent("evidence", undefined, fetcher);
    await vi.waitFor(() => expect(blob).toHaveBeenCalledOnce());
    suspendInvestigationRequests();
    complete(new Blob(["artifact"]));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not turn invalid or legacy results into a successful structured report", () => {
    expect(() => decodeResponse(ResultSchema, { success: true })).toThrow(
      "invalid structured response",
    );
    expect(() => decodeResponse(ResultSchema, { outcome: "completed", findings: [] })).toThrow();
  });

  it.each([
    {
      status: 401,
      message: "Your session expired. Sign in again.",
      expiredCalls: 1,
    },
    {
      status: 403,
      message: "Your account does not have permission for this operation.",
      expiredCalls: 0,
    },
  ])("rejects a $status read response even when its error body is not JSON", async (testCase) => {
    const expired = vi.fn();
    const unsubscribe = subscribeInvestigationSessionExpired(expired);
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("Access denied", { status: testCase.status }));
      await expect(
        createHttpTransport(fetcher)("/api/repositories", ResultSchema),
      ).rejects.toMatchObject({
        name: "InvestigationHttpError",
        status: testCase.status,
        message: testCase.message,
      });
      expect(expired).toHaveBeenCalledTimes(testCase.expiredCalls);
    } finally {
      unsubscribe();
    }
  });

  it("rejects a successful HTTP response whose body is malformed JSON", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{"));
    await expect(
      createHttpTransport(fetcher)("/api/repositories", ResultSchema),
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  it("does not start a read with an already cancelled request signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createHttpTransport(fetcher)("/api/repositories", ResultSchema, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not expire the session for an unauthorized response to a cancelled read", async () => {
    const controller = new AbortController();
    const expired = vi.fn();
    const unsubscribe = subscribeInvestigationSessionExpired(expired);
    try {
      let complete!: (response: Response) => void;
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      );
      const pending = createHttpTransport(fetcher)("/api/repositories", ResultSchema, {
        signal: controller.signal,
      });
      controller.abort();
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      const response = new Response("{}", { status: 401 });
      const json = vi.spyOn(response, "json");
      complete(response);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(json).not.toHaveBeenCalled();
      expect(expired).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it.each(["request", "session"] as const)(
    "discards JSON that finishes after %s access is cancelled",
    async (cancellation) => {
      const controller = new AbortController();
      let complete!: (value: unknown) => void;
      const response = Response.json({ outcome: "completed" });
      const json = vi.spyOn(response, "json").mockImplementation(
        () =>
          new Promise<unknown>((resolve) => {
            complete = resolve;
          }),
      );
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const pending = createHttpTransport(fetcher)("/api/repositories", ResultSchema, {
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
      if (cancellation === "request") {
        controller.abort();
      } else {
        suspendInvestigationRequests();
        resumeInvestigationRequests();
      }
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      complete({ outcome: "completed" });
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    },
  );

  it("reports a rejected operation without substituting sample data", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 409 }));
    await expect(
      createHttpTransport(fetcher)("/api/action-intents", ResultSchema, {
        method: "POST",
        body: { operation: "approve" },
      }),
    ).rejects.toBeInstanceOf(InvestigationHttpError);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/action-intents",
      expect.objectContaining({
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        method: "POST",
      }),
    );
  });

  it("encodes opaque identifiers without changing their meaning", () => {
    expect(queryString({ reportId: "report/a & b", limit: 25, cursor: undefined })).toBe(
      "?reportId=report%2Fa+%26+b&limit=25",
    );
  });

  it("blocks both late responses and new workspace requests after session access is suspended", async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const transport = createHttpTransport(fetcher);
    const pending = transport("/api/repositories", ResultSchema);
    suspendInvestigationRequests();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    complete(Response.json({ outcome: "completed" }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(transport("/api/reports/old-session", ResultSchema)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetcher).toHaveBeenCalledOnce();

    resumeInvestigationRequests();
    fetcher.mockResolvedValue(Response.json({ outcome: "completed" }));
    await expect(transport("/api/repositories", ResultSchema)).resolves.toEqual({
      outcome: "completed",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
