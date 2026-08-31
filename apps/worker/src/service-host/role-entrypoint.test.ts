import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { HostControlSession } from "./host-control-session.js";
import {
  SERVICE_HOST_CONTROL_PIPE_PREFIX,
  type ServiceHostPayloadRole,
} from "./launch-contract.js";
import { openServiceHostRoleFoundation, runServiceHostRoleEntrypoint } from "./role-entrypoint.js";

const pipe = `${SERVICE_HOST_CONTROL_PIPE_PREFIX}${"a".repeat(64)}`;
const argumentsFor = (role: "control" | "executor"): string[] => [
  `--service-role=${role}`,
  "--servicehost-arwx-stdio",
  `--servicehost-host-control-pipe=${pipe}`,
];

class FakeHostControlSession<TRole extends ServiceHostPayloadRole>
  implements HostControlSession<TRole>
{
  public closed = false;

  public constructor(public readonly role: TRole) {}

  public async drain(): Promise<void> {
    this.closed = true;
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeControlHostControlSession extends FakeHostControlSession<"control"> {
  public readonly controlOnlyMarker = true;
}

describe("ServiceHost role entrypoint", () => {
  it.each(["control", "executor"] as const)(
    "opens only the fixed %s transport foundation",
    async (role) => {
      const host = new FakeHostControlSession(role);
      const input = new PassThrough();
      const output = new PassThrough();
      let connected = false;
      const foundation = await openServiceHostRoleFoundation(role, {
        platform: "win32",
        environment: { NODE_ENV: "production" },
        argumentsList: argumentsFor(role),
        input,
        output,
        connect: async (options) => {
          connected = true;
          expect(options).toEqual({ role, pipe });
          return host;
        },
      });

      expect(connected).toBe(true);
      expect(foundation.launch.role).toBe(role);
      expect(foundation.arwx.localRole).toBe(role);
      await foundation.close();
      expect(host.closed).toBe(true);
      expect(output.readableLength).toBe(0);
    },
  );

  it("preserves the concrete role-specific HostControl session type", async () => {
    const host = new FakeControlHostControlSession("control");
    const foundation = await openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      connect: async () => host,
    });

    expect(foundation.hostControl.controlOnlyMarker).toBe(true);
    await foundation.close();
  });

  it.each([
    {
      name: "non-Windows platform",
      platform: "linux" as NodeJS.Platform,
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
    },
    {
      name: "non-production environment",
      platform: "win32" as NodeJS.Platform,
      environment: { NODE_ENV: "development" },
      argumentsList: argumentsFor("control"),
    },
    {
      name: "role mismatch",
      platform: "win32" as NodeJS.Platform,
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("executor"),
    },
  ])("fails before connection for $name", async ({ platform, environment, argumentsList }) => {
    let connected = false;
    await expect(
      openServiceHostRoleFoundation("control", {
        platform,
        environment,
        argumentsList,
        input: new PassThrough(),
        output: new PassThrough(),
        connect: async () => {
          connected = true;
          return new FakeHostControlSession("control");
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(connected).toBe(false);
  });

  it("connects, then fails closed while RuntimeBootstrapV1 is unavailable", async () => {
    const host = new FakeHostControlSession("control");
    await expect(
      runServiceHostRoleEntrypoint("control", {
        platform: "win32",
        environment: { NODE_ENV: "production" },
        argumentsList: argumentsFor("control"),
        input: new PassThrough(),
        output: new PassThrough(),
        connect: async () => host,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "RUNTIME_BOOTSTRAP_UNAVAILABLE" }));
    expect(host.closed).toBe(true);
  });

  it("bridges startup cancellation without forwarding its original reason", async () => {
    const controller = new AbortController();
    let connectorSignal: AbortSignal | undefined;
    const opening = openServiceHostRoleFoundation("executor", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("executor"),
      input: new PassThrough(),
      output: new PassThrough(),
      signal: controller.signal,
      connect: async (_options, signal) => {
        connectorSignal = signal;
        return await new Promise<HostControlSession<"executor">>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    });
    await waitFor(() => connectorSignal !== undefined);
    controller.abort(new Error("leaseToken=must-not-cross"));

    await expect(opening).rejects.toThrow("cancelled");
    expect(connectorSignal?.aborted).toBe(true);
    expect(String(connectorSignal?.reason)).not.toContain("must-not-cross");
  });

  it.each(["end", "close"] as const)(
    "cancels a pending HostControl connection when ARWX input emits %s",
    async (event) => {
      const input = new PassThrough();
      let connectorSignal: AbortSignal | undefined;
      const opening = openServiceHostRoleFoundation("executor", {
        platform: "win32",
        environment: { NODE_ENV: "production" },
        argumentsList: argumentsFor("executor"),
        input,
        output: new PassThrough(),
        connect: async (_options, signal) => {
          connectorSignal = signal;
          return await new Promise<HostControlSession<"executor">>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            });
          });
        },
      });
      await waitFor(() => connectorSignal !== undefined);
      if (event === "end") input.end();
      else input.destroy();

      await expect(opening).rejects.toThrow("cancelled");
      expect(connectorSignal?.aborted).toBe(true);
    },
  );
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for startup state.");
}
