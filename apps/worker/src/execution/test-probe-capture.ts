import { createCanonicalResult } from "@agentic-review/codex";
import {
  isSafeUiObservationText,
  maximumTestProbeOutputUtf8Bytes,
  type ObservationValue,
  type ProbeObservationsV1,
  ProbeObservationsV1Schema,
  type TestProbeOutputDeclarationV1,
  TestProbeOutputDeclarationV1Schema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";

export interface CapturedTestProbeOutput {
  readonly checkId: string;
  readonly output: ProbeObservationsV1;
  readonly outputSha256: string;
}

export class TestProbeCaptureError extends Error {
  public readonly code = "TEST_PROBE_OUTPUT_INVALID";

  public constructor() {
    super("The test probe did not provide a complete valid observation document.");
    this.name = "TestProbeCaptureError";
  }
}

/** Detect unsafe original scalar values without replacing or shortening the measured value. */
export function containsUnsafeObservationValue(
  value: ObservationValue,
  sensitiveValues: readonly string[] = [],
): boolean {
  if (value.type === "string" && !isSafeUiObservationText(value.value)) return true;
  if (value.type === "number" && !Number.isFinite(value.value)) return true;
  const text = String(value.value);
  return sensitiveValues.some((secret) => secret.length > 0 && text.includes(secret));
}

/** Accept only complete stdout returned by a successfully settled managed process. */
export function captureTestProbeOutput(
  checkId: string,
  stdout: string,
  declaration: TestProbeOutputDeclarationV1,
  sensitiveValues: readonly string[] = [],
): CapturedTestProbeOutput {
  if (
    typeof stdout !== "string" ||
    !stdout.isWellFormed() ||
    Buffer.byteLength(stdout, "utf8") > maximumTestProbeOutputUtf8Bytes ||
    !Value.Check(TestProbeOutputDeclarationV1Schema, declaration)
  )
    throw new TestProbeCaptureError();
  const fields = new Map(declaration.fields.map((field) => [field.id, field.type]));
  if (fields.size !== declaration.fields.length) throw new TestProbeCaptureError();
  const output = new StrictProbeJsonParser(stdout).parse();
  if (!Value.Check(ProbeObservationsV1Schema, output)) throw new TestProbeCaptureError();
  const seen = new Set<string>();
  for (const observation of output.observations) {
    const expected = fields.get(observation.id);
    if (
      expected === undefined ||
      seen.has(observation.id) ||
      (observation.state === "observed" && observation.value.type !== expected)
    )
      throw new TestProbeCaptureError();
    seen.add(observation.id);
  }
  if (seen.size !== fields.size) throw new TestProbeCaptureError();
  return safeCapture(checkId, output, sensitiveValues);
}

/** Recheck earlier captures when later commands resolve additional sensitive values. */
export function sanitizeTestProbeCapture(
  capture: CapturedTestProbeOutput,
  sensitiveValues: readonly string[],
): CapturedTestProbeOutput {
  return safeCapture(capture.checkId, capture.output, sensitiveValues);
}

function safeCapture(
  checkId: string,
  output: ProbeObservationsV1,
  sensitiveValues: readonly string[],
): CapturedTestProbeOutput {
  const safe: ProbeObservationsV1 = {
    schemaVersion: "ProbeObservationsV1",
    observations: output.observations.map((observation) =>
      observation.state === "observed" &&
      !containsUnsafeObservationValue(observation.value, sensitiveValues)
        ? { id: observation.id, state: "observed", value: { ...observation.value } }
        : { id: observation.id, state: "unavailable" },
    ),
  };
  const canonical = createCanonicalResult(safe);
  return {
    checkId,
    output: JSON.parse(canonical.json) as ProbeObservationsV1,
    outputSha256: canonical.sha256,
  };
}

// JSON.parse alone discards duplicate keys, including keys written with different escapes.
// This bounded parser rejects them before creating the strictly validated protocol object.
class StrictProbeJsonParser {
  #position = 0;

  public constructor(private readonly text: string) {}

  public parse(): unknown {
    const value = this.#value(0);
    this.#whitespace();
    if (this.#position !== this.text.length) throw new TestProbeCaptureError();
    return value;
  }

  #value(depth: number): unknown {
    if (depth > 16) throw new TestProbeCaptureError();
    this.#whitespace();
    const character = this.text[this.#position];
    if (character === '"') return this.#string();
    if (character === "{") return this.#object(depth);
    if (character === "[") return this.#array(depth);
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (this.text.startsWith(literal, this.#position)) {
        this.#position += literal.length;
        return value;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.text.slice(this.#position),
    )?.[0];
    if (number === undefined) throw new TestProbeCaptureError();
    this.#position += number.length;
    const value = Number(number);
    if (!Number.isFinite(value)) throw new TestProbeCaptureError();
    return value;
  }

  #object(depth: number): Record<string, unknown> {
    this.#position += 1;
    const result: Record<string, unknown> = Object.create(null);
    this.#whitespace();
    if (this.#take("}")) return result;
    for (;;) {
      this.#whitespace();
      if (this.text[this.#position] !== '"') throw new TestProbeCaptureError();
      const key = this.#string();
      if (Object.hasOwn(result, key)) throw new TestProbeCaptureError();
      this.#whitespace();
      if (!this.#take(":")) throw new TestProbeCaptureError();
      result[key] = this.#value(depth + 1);
      this.#whitespace();
      if (this.#take("}")) return result;
      if (!this.#take(",")) throw new TestProbeCaptureError();
    }
  }

  #array(depth: number): unknown[] {
    this.#position += 1;
    const result: unknown[] = [];
    this.#whitespace();
    if (this.#take("]")) return result;
    for (;;) {
      result.push(this.#value(depth + 1));
      this.#whitespace();
      if (this.#take("]")) return result;
      if (!this.#take(",")) throw new TestProbeCaptureError();
    }
  }

  #string(): string {
    const start = this.#position;
    this.#position += 1;
    while (this.#position < this.text.length) {
      const character = this.text[this.#position];
      this.#position += 1;
      if (character === "\\") {
        this.#position += 1;
      } else if (character === '"') {
        let value: string;
        try {
          value = JSON.parse(this.text.slice(start, this.#position)) as string;
        } catch {
          throw new TestProbeCaptureError();
        }
        if (!value.isWellFormed() || value.includes("\0")) throw new TestProbeCaptureError();
        return value;
      }
    }
    throw new TestProbeCaptureError();
  }

  #whitespace(): void {
    while (/[ \t\r\n]/u.test(this.text[this.#position] ?? "!")) this.#position += 1;
  }

  #take(character: string): boolean {
    if (this.text[this.#position] !== character) return false;
    this.#position += 1;
    return true;
  }
}
