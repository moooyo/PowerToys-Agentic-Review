import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { chromium } from "playwright-core";
import {
  parseWebDriverRequest,
  runWebUiScenario,
  serializeWebDriverResult,
  serializeWebDriverStepCompleted,
  WebUiObservationProbeRequestSchema,
  WebUiObservationProbeResult,
  webDriverMaximumInputBytes,
} from "./web-driver.js";

// Worker launches this independent entry through ProcessHost. Chromium descendants therefore
// inherit the same Windows Job Object and are killed with the owned scenario process.
export async function runWebDriverEntry(): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("Managed browser execution cancelled."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  process.stderr.once("error", abort);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(
      () => process.stdin.destroy(new Error("Driver input deadline exceeded.")),
      10_000,
    );
    try {
      for await (const raw of process.stdin) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        size += chunk.byteLength;
        if (size > webDriverMaximumInputBytes) throw new RangeError("Driver input limit exceeded.");
        chunks.push(chunk);
      }
    } finally {
      clearTimeout(timeout);
    }
    const input: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)),
    );
    if (Value.Check(WebUiObservationProbeRequestSchema, input)) {
      process.stdout.write(`${JSON.stringify(WebUiObservationProbeResult)}\n`);
      return;
    }
    const request = parseWebDriverRequest(input);
    const result = await runWebUiScenario(request, {
      chromium,
      signal: controller.signal,
      onStepCompleted: (event) =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          process.stderr.write(`${serializeWebDriverStepCompleted(event)}\n`, (error) => {
            if (error !== null && error !== undefined) rejectWrite(error);
            else resolveWrite();
          });
        }),
    });
    process.stdout.write(`${serializeWebDriverResult(result)}\n`);
  } catch {
    process.stderr.write("Web driver input or execution protocol failed.\n");
    process.exitCode = 2;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    process.stderr.removeListener("error", abort);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await runWebDriverEntry();
}
