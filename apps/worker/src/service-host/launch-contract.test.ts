import { describe, expect, it } from "vitest";
import {
  isHostControlPipeSelector,
  parseServiceHostLaunchContract,
  SERVICE_HOST_CONTROL_PIPE_PREFIX,
  ServiceHostLaunchContractError,
} from "./launch-contract.js";

const pipe = `${SERVICE_HOST_CONTROL_PIPE_PREFIX}${"a".repeat(64)}`;

function argumentsFor(role: "control" | "executor"): string[] {
  return [
    `--service-role=${role}`,
    "--servicehost-arwx-stdio",
    `--servicehost-host-control-pipe=${pipe}`,
  ];
}

describe("ServiceHost launch contract", () => {
  it.each(["control", "executor"] as const)("accepts the exact fixed %s arguments", (role) => {
    expect(parseServiceHostLaunchContract(argumentsFor(role), role)).toEqual({
      role,
      arwxStandardIO: true,
      hostControlPipe: pipe,
    });
    expect(isHostControlPipeSelector(pipe)).toBe(true);
  });

  const invalidArguments = [
    [] as string[],
    argumentsFor("control").slice(0, 2),
    [...argumentsFor("control"), "--extra"],
    [
      argumentsFor("control")[1] ?? "",
      argumentsFor("control")[0] ?? "",
      argumentsFor("control")[2] ?? "",
    ],
    ["--service-role=other", ...argumentsFor("control").slice(1)],
    [
      argumentsFor("control")[0] ?? "",
      "--servicehost-arwx-stdio=true",
      argumentsFor("control")[2] ?? "",
    ],
  ];

  it.each(invalidArguments.map((value) => [value] as const))(
    "rejects missing, extra, or reordered arguments",
    (argumentsList) => {
      expect(() => parseServiceHostLaunchContract(argumentsList, "control")).toThrow(
        ServiceHostLaunchContractError,
      );
    },
  );

  it.each([
    "",
    `\\\\server\\pipe\\AgenticReview.ServiceHost.HostControl.v1.${"a".repeat(64)}`,
    `${SERVICE_HOST_CONTROL_PIPE_PREFIX}${"a".repeat(63)}`,
    `${SERVICE_HOST_CONTROL_PIPE_PREFIX}${"A".repeat(64)}`,
    `${SERVICE_HOST_CONTROL_PIPE_PREFIX}${"g".repeat(64)}`,
    `${SERVICE_HOST_CONTROL_PIPE_PREFIX}${"a".repeat(64)}\\suffix`,
  ])("rejects an arbitrary or noncanonical pipe selector: %s", (selector) => {
    expect(isHostControlPipeSelector(selector)).toBe(false);
    const argumentsList = argumentsFor("control");
    argumentsList[2] = `--servicehost-host-control-pipe=${selector}`;
    expect(() => parseServiceHostLaunchContract(argumentsList, "control")).toThrowError(
      expect.objectContaining({ code: "HOST_CONTROL_PIPE_INVALID" }),
    );
  });

  it("binds a role-specific bundle to its compiled role", () => {
    expect(() => parseServiceHostLaunchContract(argumentsFor("executor"), "control")).toThrowError(
      expect.objectContaining({ code: "ROLE_MISMATCH" }),
    );
  });
});
