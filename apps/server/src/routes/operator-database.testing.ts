import type { OperatorPrincipal } from "@agentic-review/contracts";
import { expect, vi } from "vitest";
import type { DatabaseClient } from "../database/database-client.js";
import type { OperatorRequestInput } from "../database/operator-request.js";

/** The fixture has a distinct transport spy: raw RPCs or a forged caller fail every route test. */
export function createOperatorRouteTestDatabase(
  actor: OperatorPrincipal,
  implementation: (operation: string, input: unknown) => Promise<unknown>,
) {
  const request = vi.fn(implementation);
  const permissions = vi.fn(async (_input: unknown) => ({ authorized: true as const }));
  const transport = vi.fn(async (operation: string, input: unknown) => {
    expect(operation).toBe("operatorRequest");
    const frame = input as OperatorRequestInput;
    expect(Object.keys(frame).sort()).toEqual(["context", "input", "operation"]);
    expect(frame.context).toEqual({ kind: "operator", actor });
    if (frame.operation === "operatorCheckPermission") return permissions(frame.input);
    return request(frame.operation, frame.input);
  });
  return {
    database: { request: transport } as unknown as DatabaseClient,
    request,
    permissions,
    transport,
  };
}
