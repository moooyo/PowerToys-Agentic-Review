import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpTransport,
  decodeResponse,
  InvestigationHttpError,
  queryString,
  resumeInvestigationRequests,
  suspendInvestigationRequests,
} from "./transport";

const ResultSchema = Type.Object(
  { outcome: Type.Literal("completed") },
  { additionalProperties: false },
);

afterEach(() => resumeInvestigationRequests());

describe("investigation transport", () => {
  it("does not turn invalid or legacy results into a successful structured report", () => {
    expect(() => decodeResponse(ResultSchema, { success: true })).toThrow(
      "invalid structured response",
    );
    expect(() => decodeResponse(ResultSchema, { outcome: "completed", findings: [] })).toThrow();
  });

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
