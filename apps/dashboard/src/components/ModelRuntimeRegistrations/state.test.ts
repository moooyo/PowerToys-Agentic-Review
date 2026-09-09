import type * as C from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import { createHttpModelRuntimeRegistrationAdapter } from "@/services/model-runtime-registrations";
import {
  controlRequest,
  registrationRequest,
  registryActor,
  registryId,
  runtimeStatus,
} from "@/services/model-runtime-registrations/fixtures.testing";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlRequestError,
} from "@/services/review-control/errors";
import {
  type RegistrationFields,
  RegistryMutationController,
  registrationFromFields,
  registryAccessState,
} from "./state";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const update = vi.fn();
  const controller = new RegistryMutationController(
    createHttpModelRuntimeRegistrationAdapter({ fetch }),
    update,
  );
  return { fetch, update, controller };
}
function values(): RegistrationFields {
  const request = registrationRequest(),
    identity = request.identity;
  return {
    name: request.name,
    requestedModel: request.requestedModel,
    enabled: request.enabled,
    providerId: identity.providerId,
    modelId: identity.modelId,
    endpointSha256: identity.endpointSha256,
    clientVersion: identity.client.version,
    executableSha256: identity.client.executableSha256,
    launchPolicySha256: identity.client.launchPolicySha256,
    relayImplementationSha256: identity.relay.implementationSha256,
    relayPolicySha256: identity.relay.policySha256,
  };
}
describe("model runtime registration intent", () => {
  it("retains an original committed-but-unconfirmed request through same-session access failure and restoration", async () => {
    const f = fixture();
    f.fetch
      .mockRejectedValueOnce(new Error("The successful response was lost"))
      .mockResolvedValueOnce(json(runtimeStatus()));
    await f.controller.submit({
      kind: "register",
      request: registrationRequest(),
      actor: registryActor,
    });
    const temporarilyUnknown = registryAccessState({
      mode: "connected",
      authenticated: true,
      principal: registryActor,
      ready: false,
      checking: false,
      platformAdministrator: false,
      error: new ReviewControlNetworkError("read access"),
    });
    expect(temporarilyUnknown).toBe("unavailable");
    f.controller.setAuthorization(temporarilyUnknown === "authorized");
    await expect(f.controller.retry()).resolves.toBeNull();
    await expect(
      f.controller.submit({
        kind: "register",
        request: { ...registrationRequest(), changeId: "must-not-replace" },
        actor: registryActor,
      }),
    ).resolves.toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const restored = registryAccessState({
      mode: "connected",
      authenticated: true,
      principal: registryActor,
      ready: true,
      checking: false,
      platformAdministrator: true,
      error: null,
    });
    f.controller.setAuthorization(restored === "authorized");
    await expect(f.controller.retry()).resolves.toEqual(runtimeStatus());
    expect(f.fetch.mock.calls[1]?.[1]?.body).toBe(f.fetch.mock.calls[0]?.[1]?.body);
  });
  it.each(["permission", "forbidden", "logout"])(
    "discards an uncertain intent only after confirmed %s",
    async (kind) => {
      const f = fixture();
      f.fetch.mockRejectedValueOnce(new Error("lost reply"));
      await f.controller.submit({
        kind: "register",
        request: registrationRequest(),
        actor: registryActor,
      });
      const decision = registryAccessState({
        mode: "connected",
        authenticated: kind !== "logout",
        principal: kind === "logout" ? null : registryActor,
        ready: kind === "permission",
        checking: false,
        platformAdministrator: false,
        error:
          kind === "forbidden"
            ? new ReviewControlHttpError("Denied", {
                operation: "read access",
                status: 403,
                retryable: false,
              })
            : null,
      });
      expect(decision).toBe("revoked");
      if (decision === "revoked") f.controller.close();
      f.controller.setAuthorization(true);
      await expect(f.controller.retry()).resolves.toBeNull();
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("builds the full expected identity without treating a requested alias as an observed model", () => {
    const result = registrationFromFields(values(), registrationRequest().changeId);
    expect(result).toEqual(registrationRequest());
    expect(result.requestedModel).not.toBe(result.identity.modelId);
  });
  it.each([
    "endpointSha256",
    "executableSha256",
    "launchPolicySha256",
    "relayImplementationSha256",
    "relayPolicySha256",
  ] as const)("rejects an incomplete %s without inventing identity metadata", (key) => {
    expect(() => registrationFromFields({ ...values(), [key]: "unknown" }, "change-a")).toThrow(
      ReviewControlRequestError,
    );
  });
  it.each(["network", "malformed", "server"])(
    "keeps exact registration bytes and actor after an uncertain %s response",
    async (failure) => {
      const f = fixture(),
        request = registrationRequest(),
        actor = { ...registryActor };
      const intent = { kind: "register" as const, request, actor };
      if (failure === "network") f.fetch.mockRejectedValueOnce(new Error("lost reply"));
      if (failure === "malformed")
        f.fetch.mockResolvedValueOnce(json({ error: "unexpected successful response" }));
      if (failure === "server")
        f.fetch.mockResolvedValueOnce(json({ error: "internal_error" }, 500));
      f.fetch.mockResolvedValueOnce(json(runtimeStatus()));
      const first = f.controller.submit(intent);
      request.name = "Edited while pending";
      actor.subject = "different operator";
      await expect(first).resolves.toBeNull();
      expect(f.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ uncertain: true, busy: false }),
      );
      await expect(
        f.controller.submit({
          kind: "register",
          request: { ...registrationRequest(), changeId: "new-change" },
          actor: registryActor,
        }),
      ).resolves.toBeNull();
      expect(f.fetch).toHaveBeenCalledTimes(1);
      await expect(f.controller.retry()).resolves.toEqual(runtimeStatus());
      expect(f.fetch.mock.calls[0]?.[1]?.body).toBe(f.fetch.mock.calls[1]?.[1]?.body);
      expect(f.update).toHaveBeenLastCalledWith({
        busy: false,
        uncertain: false,
        conflict: false,
        error: null,
      });
    },
  );
  it("retains the original control scope, version and reason across an uncertain retry", async () => {
    const f = fixture(),
      request = controlRequest();
    f.fetch
      .mockRejectedValueOnce(new Error("lost reply"))
      .mockResolvedValueOnce(json(runtimeStatus(false, 2)));
    await f.controller.submit({
      kind: "control",
      registrationId: registryId,
      request,
      actor: registryActor,
    });
    request.expectedVersion = 40;
    request.reason = "A later edit";
    await expect(f.controller.retry()).resolves.toEqual(runtimeStatus(false, 2));
    const first = f.fetch.mock.calls[0],
      second = f.fetch.mock.calls[1];
    expect(second?.[0]).toBe(first?.[0]);
    expect(second?.[1]?.body).toBe(first?.[1]?.body);
    expect(JSON.parse(String(second?.[1]?.body))).toEqual(controlRequest());
  });
  it("does not silently rebase a conflict or generate a new retry intent", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(
      json({ error: "conflict", message: "Current version differs" }, 409),
    );
    await f.controller.submit({
      kind: "control",
      registrationId: registryId,
      request: controlRequest(),
      actor: registryActor,
    });
    expect(f.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ uncertain: false, conflict: true }),
    );
    await expect(f.controller.retry()).resolves.toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const current = runtimeStatus(false, 4);
    f.fetch.mockResolvedValueOnce(json(current));
    await expect(
      f.controller.submit({
        kind: "control",
        registrationId: registryId,
        request: { ...controlRequest(), changeId: "deliberate-change", expectedVersion: 3 },
        actor: registryActor,
      }),
    ).resolves.toEqual(current);
  });
  it.each([401, 403])(
    "clears the retry intent after current access is denied with %s",
    async (status) => {
      const f = fixture();
      f.fetch.mockResolvedValueOnce(json({ error: "forbidden" }, status));
      await f.controller.submit({
        kind: "register",
        request: registrationRequest(),
        actor: registryActor,
      });
      expect(f.update).toHaveBeenLastCalledWith(expect.objectContaining({ uncertain: false }));
      await expect(f.controller.retry()).resolves.toBeNull();
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("ignores a late success after sign-out or revocation closes its session", async () => {
    const f = fixture();
    let finish: ((response: Response) => void) | undefined;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.controller.submit({
      kind: "register",
      request: registrationRequest(),
      actor: registryActor,
    });
    expect(f.update).toHaveBeenCalledTimes(1);
    f.controller.close();
    finish?.(json(runtimeStatus()));
    await expect(pending).resolves.toBeNull();
    expect(f.update).toHaveBeenCalledTimes(1);
    await expect(f.controller.retry()).resolves.toBeNull();
    await expect(
      f.controller.submit({
        kind: "register",
        request: registrationRequest(),
        actor: registryActor,
      }),
    ).resolves.toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps only one mutation in flight and cannot transfer uncertain work to another session", async () => {
    const f = fixture();
    let fail: ((reason: Error) => void) | undefined;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const intent = {
      kind: "register" as const,
      request: registrationRequest(),
      actor: registryActor,
    };
    const pending = f.controller.submit(intent);
    await expect(f.controller.submit(intent)).resolves.toBeNull();
    await expect(f.controller.retry()).resolves.toBeNull();
    f.controller.close();
    fail?.(new Error("late network failure"));
    await pending;
    expect(f.update).toHaveBeenCalledTimes(1);
    const next = new RegistryMutationController(
      createHttpModelRuntimeRegistrationAdapter({ fetch: f.fetch }),
      f.update,
    );
    await expect(next.retry()).resolves.toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects missing actor before a transport or retained intent exists", async () => {
    const f = fixture();
    await expect(
      f.controller.submit({
        kind: "register",
        request: registrationRequest(),
        actor: undefined as unknown as C.OperatorPrincipal,
      }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(f.controller.retry()).resolves.toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
