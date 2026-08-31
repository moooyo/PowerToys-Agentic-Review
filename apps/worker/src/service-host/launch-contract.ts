export const SERVICE_HOST_CONTROL_PIPE_PREFIX =
  "\\\\.\\pipe\\AgenticReview.ServiceHost.HostControl.v1." as const;

export type ServiceHostPayloadRole = "control" | "executor";

declare const hostControlPipeSelectorBrand: unique symbol;

export type HostControlPipeSelector = string & {
  readonly [hostControlPipeSelectorBrand]: true;
};

export interface ServiceHostLaunchContract {
  readonly role: ServiceHostPayloadRole;
  readonly arwxStandardIO: true;
  readonly hostControlPipe: HostControlPipeSelector;
}

export class ServiceHostLaunchContractError extends Error {
  public constructor(
    public readonly code: "ARGUMENTS_INVALID" | "HOST_CONTROL_PIPE_INVALID" | "ROLE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ServiceHostLaunchContractError";
  }
}

/** Parses the exact fixed argument list emitted by ServiceHost for one role-specific bundle. */
export function parseServiceHostLaunchContract(
  argumentsList: readonly string[],
  expectedRole: ServiceHostPayloadRole,
): Readonly<ServiceHostLaunchContract> {
  if (
    !Array.isArray(argumentsList) ||
    argumentsList.length !== 3 ||
    argumentsList.some((value) => typeof value !== "string")
  ) {
    throw launchError(
      "ARGUMENTS_INVALID",
      "ServiceHost payload requires exactly three fixed launch arguments.",
    );
  }

  const roleArgument = argumentsList[0];
  const arwxArgument = argumentsList[1];
  const pipeArgument = argumentsList[2];
  if (
    roleArgument === undefined ||
    arwxArgument !== "--servicehost-arwx-stdio" ||
    pipeArgument === undefined
  ) {
    throw launchError(
      "ARGUMENTS_INVALID",
      "ServiceHost payload launch arguments are missing or out of order.",
    );
  }

  const role = parseRoleArgument(roleArgument);
  if (role !== expectedRole) {
    throw launchError("ROLE_MISMATCH", "ServiceHost payload role does not match this bundle.");
  }
  const hostControlPipe = parsePipeArgument(pipeArgument);
  return Object.freeze({ role, arwxStandardIO: true, hostControlPipe });
}

export function isHostControlPipeSelector(value: unknown): value is HostControlPipeSelector {
  if (typeof value !== "string" || !value.startsWith(SERVICE_HOST_CONTROL_PIPE_PREFIX)) {
    return false;
  }
  const nonce = value.slice(SERVICE_HOST_CONTROL_PIPE_PREFIX.length);
  return nonce.length === 64 && /^[a-f0-9]{64}$/u.test(nonce);
}

function parseRoleArgument(value: string): ServiceHostPayloadRole {
  if (value === "--service-role=control") return "control";
  if (value === "--service-role=executor") return "executor";
  throw launchError("ARGUMENTS_INVALID", "ServiceHost payload role argument is invalid.");
}

function parsePipeArgument(value: string): HostControlPipeSelector {
  const prefix = "--servicehost-host-control-pipe=";
  if (!value.startsWith(prefix)) {
    throw launchError(
      "ARGUMENTS_INVALID",
      "ServiceHost payload HostControl selector argument is missing.",
    );
  }
  const selector = value.slice(prefix.length);
  if (!isHostControlPipeSelector(selector)) {
    throw launchError(
      "HOST_CONTROL_PIPE_INVALID",
      "ServiceHost HostControl selector must use the fixed per-launch 256-bit format.",
    );
  }
  return selector;
}

function launchError(
  code: ServiceHostLaunchContractError["code"],
  message: string,
): ServiceHostLaunchContractError {
  return new ServiceHostLaunchContractError(code, message);
}
