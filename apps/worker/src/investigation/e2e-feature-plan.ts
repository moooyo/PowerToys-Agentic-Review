import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { E2eDesktopRequestSchema, parseE2eDesktopRequest } from "./e2e-desktop-driver.js";

const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });
const text = Type.String({ minLength: 1, maxLength: 4096, pattern: "\\S" });
export const E2eFeaturePlanSchema = Type.Object(
  {
    id,
    title: text,
    paths: Type.Array(text, { minItems: 1, uniqueItems: true, maxItems: 128 }),
    scenario: text,
    userVisible: Type.Boolean(),
    assertions: Type.Array(
      Type.Union([
        Type.Object(
          {
            id,
            kind: Type.Literal("ui"),
            description: text,
            selector: Type.Object(
              {
                automationId: Type.Optional(text),
                name: Type.Optional(text),
                controlType: Type.Optional(text),
                className: Type.Optional(text),
                index: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
              },
              { additionalProperties: false },
            ),
            assertion: E2eDesktopRequestSchema.properties.assertion,
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            id,
            kind: Type.Literal("process"),
            description: text,
            outputPath: text,
            host: Type.Optional(
              Type.Union([Type.Literal("direct"), Type.Literal("dotnet-vstest")]),
            ),
            arguments: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64 }),
            expectedExitCode: Type.Integer(),
            expectedOutputContains: text,
          },
          { additionalProperties: false },
        ),
      ]),
      { minItems: 1, maxItems: 64 },
    ),
  },
  { additionalProperties: false },
);
export type E2eFeaturePlan = Static<typeof E2eFeaturePlanSchema>;

export function parseE2eFeaturePlan(
  value: unknown,
  changedPaths: readonly string[],
): E2eFeaturePlan {
  if (!Value.Check(E2eFeaturePlanSchema, value))
    throw new Error(
      "The feature plan must include a stable ID, changed paths, scenario and complete assertion specifications.",
    );
  if (new Set(value.assertions.map((assertion) => assertion.id)).size !== value.assertions.length)
    throw new Error("Feature assertion IDs must be unique.");
  if (value.paths.some((path) => !changedPaths.includes(path)))
    throw new Error("Feature paths must identify actual changed files in this pinned PR.");
  if (value.userVisible && value.assertions.some((assertion) => assertion.kind !== "ui"))
    throw new Error(
      "User-visible feature acceptance requires UI assertions; a command exit code cannot prove UI behavior.",
    );
  for (const assertion of value.assertions) {
    if (
      assertion.kind === "ui" &&
      (assertion.assertion === undefined ||
        (!assertion.selector.name && !assertion.selector.automationId))
    )
      throw new Error(
        "A UI assertion must identify a specific named or automated control and its expected observation.",
      );
    if (assertion.kind === "ui")
      parseE2eDesktopRequest({
        schemaVersion: "E2eDesktopRequestV1",
        requestId: "validate-feature",
        action: "assert",
        ownedProcesses: [{ pid: 1, creationTimeFileTime: "1" }],
        target: { pid: 1, selector: assertion.selector },
        assertion: assertion.assertion,
      });
    if (
      assertion.kind === "process" &&
      (/^(?:[A-Za-z]:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(assertion.outputPath) ||
        !/\.(?:exe|dll)$/iu.test(assertion.outputPath))
    )
      throw new Error(
        "A process assertion must target a relative executable produced by the verified build.",
      );
    if (describeE2eAssertion(assertion).length > 16_384)
      throw new Error(
        "The registered assertion exceeds the report expectation length limit; use a focused observable assertion.",
      );
  }
  return structuredClone(value);
}

export function describeE2eAssertion(assertion: E2eFeaturePlan["assertions"][number]): string {
  return assertion.kind === "ui"
    ? `${assertion.description}: ${JSON.stringify({ selector: assertion.selector, assertion: assertion.assertion })}`
    : `${assertion.description}: exit ${assertion.expectedExitCode}; output contains ${JSON.stringify(assertion.expectedOutputContains)}`;
}
