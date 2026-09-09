import * as C from "@agentic-review/contracts";
import {
  evaluationBatchActor,
  evaluationBatchRequest,
} from "@/services/evaluation-batches/validation";
import type { ModelRuntimeRegistrationAdapter } from "@/services/model-runtime-registrations";
import {
  ReviewControlHttpError,
  ReviewControlRequestError,
} from "@/services/review-control/errors";

export interface RegistrationFields {
  name: string;
  requestedModel: string;
  providerId: string;
  modelId: string;
  endpointSha256: string;
  clientVersion: string;
  executableSha256: string;
  launchPolicySha256: string;
  relayImplementationSha256: string;
  relayPolicySha256: string;
  enabled: boolean;
}
export function registrationFromFields(
  values: RegistrationFields,
  changeId: string,
): C.ModelRuntimeRegisterRequest {
  return evaluationBatchRequest(
    C.ModelRuntimeRegisterRequestSchema,
    {
      changeId,
      name: values.name,
      requestedModel: values.requestedModel,
      enabled: values.enabled,
      identity: {
        schemaVersion: "ModelRuntimeIdentityV1",
        providerId: values.providerId,
        modelId: values.modelId,
        endpointSha256: values.endpointSha256,
        client: {
          kind: "codex_cli",
          version: values.clientVersion,
          executableSha256: values.executableSha256,
          launchPolicySha256: values.launchPolicySha256,
        },
        relay: {
          implementationSha256: values.relayImplementationSha256,
          policySha256: values.relayPolicySha256,
        },
      },
    },
    "register expected model runtime",
    C.getModelRuntimeRegisterRequestIssues,
    C.maximumModelRuntimeRegistryRequestUtf8Bytes,
  );
}
export type RegistryMutationIntent =
  | { kind: "register"; request: C.ModelRuntimeRegisterRequest; actor: C.OperatorPrincipal }
  | {
      kind: "control";
      registrationId: string;
      request: C.ModelRuntimeControlRequest;
      actor: C.OperatorPrincipal;
    };
export interface RegistryMutationState {
  busy: boolean;
  uncertain: boolean;
  error: string | null;
  conflict: boolean;
}
export const initialRegistryMutationState: RegistryMutationState = {
  busy: false,
  uncertain: false,
  error: null,
  conflict: false,
};

export type RegistryAccessState = "authorized" | "checking" | "unavailable" | "revoked" | "sample";
export function registryAccessState(access: {
  mode: string;
  authenticated: boolean;
  principal: C.OperatorPrincipal | null;
  ready: boolean;
  checking: boolean;
  platformAdministrator: boolean;
  error: unknown;
}): RegistryAccessState {
  if (access.mode !== "connected") return "sample";
  if (!access.authenticated || access.principal === null) return "revoked";
  if (
    access.error instanceof ReviewControlHttpError &&
    [401, 403, 404].includes(access.error.status)
  )
    return "revoked";
  if (access.ready && !access.error && !access.platformAdministrator) return "revoked";
  if (access.error || !access.ready) return "unavailable";
  return access.checking ? "checking" : "authorized";
}

function definitive(error: unknown): boolean {
  return (
    error instanceof ReviewControlRequestError ||
    (error instanceof ReviewControlHttpError &&
      [400, 401, 403, 404, 409, 413, 422].includes(error.status))
  );
}
export function registryErrorMessage(error: unknown): string {
  if (error instanceof ReviewControlHttpError) {
    if (error.status === 409)
      return "The registration control changed. Refresh its current version before submitting a new change.";
    if ([401, 403].includes(error.status))
      return "Current platform administrator access is required. Refresh access before continuing.";
    if (error.status === 404)
      return "This registration is no longer available in the requested scope.";
  }
  return error instanceof Error ? error.message : "The registry request could not be completed.";
}

// One controller belongs to one authenticated UI session. Its serialized intent survives
// uncertain replies; it never refreshes a change ID, actor, or expected version for a retry.
export class RegistryMutationController {
  private serialized: string | null = null;
  private closed = false;
  private busy = false;
  private authorized = true;
  constructor(
    private readonly adapter: ModelRuntimeRegistrationAdapter,
    private readonly update: (state: RegistryMutationState) => void,
  ) {}
  async submit(input: RegistryMutationIntent): Promise<C.ModelRuntimeStatusV1 | null> {
    if (this.closed || !this.authorized || this.busy || this.serialized !== null) return null;
    const actor = evaluationBatchActor(input.actor, "change model runtime registration");
    if (!actor)
      throw new ReviewControlRequestError(
        "change model runtime registration",
        "actor",
        "A signed-in administrator is required.",
      );
    const request =
      input.kind === "register"
        ? evaluationBatchRequest(
            C.ModelRuntimeRegisterRequestSchema,
            input.request,
            "register expected model runtime",
            C.getModelRuntimeRegisterRequestIssues,
            C.maximumModelRuntimeRegistryRequestUtf8Bytes,
          )
        : evaluationBatchRequest(
            C.ModelRuntimeControlRequestSchema,
            input.request,
            "change model runtime selection control",
            C.getModelRuntimeControlRequestIssues,
            C.maximumModelRuntimeRegistryRequestUtf8Bytes,
          );
    const registrationId =
      input.kind === "control"
        ? evaluationBatchRequest(
            C.ModelRuntimeControlV1Schema.properties.registrationId,
            input.registrationId,
            "change model runtime selection control",
          )
        : undefined;
    this.serialized = JSON.stringify({
      kind: input.kind,
      ...(registrationId === undefined ? {} : { registrationId }),
      request,
      actor,
    });
    return this.perform();
  }
  retry(): Promise<C.ModelRuntimeStatusV1 | null> {
    return this.perform();
  }
  setAuthorization(authorized: boolean): void {
    this.authorized = authorized;
  }
  close(): void {
    this.closed = true;
    this.serialized = null;
  }
  private async perform(): Promise<C.ModelRuntimeStatusV1 | null> {
    if (this.closed || !this.authorized || this.busy || this.serialized === null) return null;
    this.busy = true;
    this.update({ busy: true, uncertain: false, error: null, conflict: false });
    const intent = JSON.parse(this.serialized) as RegistryMutationIntent;
    try {
      const result =
        intent.kind === "register"
          ? await this.adapter.register(intent.request, intent.actor)
          : await this.adapter.changeControl(intent.registrationId, intent.request, intent.actor);
      if (this.closed) return null;
      this.serialized = null;
      this.update(initialRegistryMutationState);
      return result;
    } catch (error) {
      if (!this.closed) {
        const uncertain = !definitive(error);
        if (!uncertain) this.serialized = null;
        this.update({
          busy: false,
          uncertain,
          error: registryErrorMessage(error),
          conflict: error instanceof ReviewControlHttpError && error.status === 409,
        });
      }
      return null;
    } finally {
      this.busy = false;
    }
  }
}
