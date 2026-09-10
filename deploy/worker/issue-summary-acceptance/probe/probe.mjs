import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const probeDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRevision = "7dfc03ebc7f10530681109f6a5aec982a5573936";
const sourcePrefix = "upstream:/";
const entryPath = "src/subtitle/youtubeSubtitleProcessing.js";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readVerified(relativePath, expectedHash, directory = probeDirectory) {
  const absolutePath = path.resolve(directory, relativePath);
  if (!absolutePath.startsWith(directory + path.sep)) {
    throw new Error(`Refusing a path outside its declared directory: ${relativePath}`);
  }
  const bytes = readFileSync(absolutePath);
  if (sha256(bytes) !== expectedHash) {
    throw new Error(`Artifact SHA-256 mismatch: ${relativePath}`);
  }
  return bytes;
}

function freezeRecursively(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRecursively(child);
    Object.freeze(value);
  }
  return value;
}

function stderrLog(...args) {
  const text = args
    .map((value) => {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");
  process.stderr.write(`[upstream] ${text}\n`);
}

function observation(id, value) {
  const type = typeof value;
  if (value === undefined || (type === "number" && !Number.isFinite(value))) {
    return { id, state: "unavailable" };
  }
  if (!["string", "number", "boolean"].includes(type)) {
    throw new Error(`Unsupported observation value: ${id}`);
  }
  return { id, state: "observed", value: { type, value } };
}

async function collect() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--checkout" || !args[1].trim()) {
    throw new Error("Usage: node --experimental-vm-modules probe.mjs --checkout <directory>");
  }
  const checkoutDirectory = path.resolve(args[1]);
  if (typeof vm.SourceTextModule !== "function") {
    throw new Error("Run Node with the explicit --experimental-vm-modules flag.");
  }

  const contract = JSON.parse(
    readFileSync(path.join(probeDirectory, "probe-contract.json"), "utf8"),
  );
  const manifest = JSON.parse(
    readVerified(contract.upstreamManifest.path, contract.upstreamManifest.sha256).toString("utf8"),
  );
  if (manifest.revision !== sourceRevision || manifest.files.length !== 17) {
    throw new Error("Unexpected source revision or import-closure file count.");
  }
  const fixture = JSON.parse(
    readVerified(contract.inputs[0].path, contract.inputs[0].sha256).toString("utf8"),
  );
  freezeRecursively(fixture);

  let networkAttempts = 0;
  function denyNetwork() {
    networkAttempts += 1;
    throw new Error("Network access is forbidden in the Issue #1064 probe.");
  }

  const context = vm.createContext(
    {
      console: Object.freeze({
        debug: stderrLog,
        log: stderrLog,
        info: stderrLog,
        warn: stderrLog,
        error: stderrLog,
      }),
      process: freezeRecursively({
        env: {
          NODE_ENV: "production",
          REACT_APP_NAME: "kiss-translator",
          REACT_APP_VERSION: "2.0.32",
          REACT_APP_HOMEPAGE: "https://example.invalid/issue-1064-probe",
          REACT_APP_RULESURL: "https://example.invalid/rules.json",
          REACT_APP_RULESURL_ON: "https://example.invalid/rules-on.json",
          REACT_APP_RULESURL_OFF: "https://example.invalid/rules-off.json",
        },
      }),
      fetch: denyNetwork,
      XMLHttpRequest: denyNetwork,
      WebSocket: denyNetwork,
      EventSource: denyNetwork,
    },
    {
      name: "issue-1064-unmodified-upstream",
      codeGeneration: { strings: false, wasm: false },
    },
  );

  const modules = new Map();
  for (const file of manifest.files) {
    if (
      !file.path.startsWith("src/") ||
      file.path.includes("\\") ||
      path.posix.normalize(file.path) !== file.path ||
      !file.path.endsWith(".js") ||
      modules.has(file.path)
    ) {
      throw new Error(`Invalid or duplicate source manifest path: ${file.path}`);
    }
    const sourceBytes = readVerified(file.path, file.sha256, checkoutDirectory);
    if (sourceBytes.length !== file.byteLength) {
      throw new Error(`Source byte length mismatch: ${file.path}`);
    }
    modules.set(
      file.path,
      new vm.SourceTextModule(sourceBytes.toString("utf8"), {
        context,
        identifier: `${sourcePrefix}${file.path}`,
        importModuleDynamically() {
          throw new Error("Dynamic imports are forbidden in this source closure.");
        },
      }),
    );
  }

  const entry = modules.get(entryPath);
  if (!entry) throw new Error("The real upstream entry module is missing.");
  await entry.link((specifier, referencingModule) => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      throw new Error(`Bare and built-in imports are forbidden: ${specifier}`);
    }
    const referringPath = referencingModule.identifier.slice(sourcePrefix.length);
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(referringPath), specifier),
    );
    const candidate = [resolved, `${resolved}.js`, `${resolved}/index.js`].find((item) =>
      modules.has(item),
    );
    if (!candidate) {
      throw new Error(`Import outside the frozen source closure: ${specifier}`);
    }
    return modules.get(candidate);
  });
  await entry.evaluate({ timeout: 5000 });

  const { prepareTimedTextEvents, runBuiltinSegmentation } = entry.namespace;
  if (
    typeof prepareTimedTextEvents !== "function" ||
    typeof runBuiltinSegmentation !== "function"
  ) {
    throw new Error("Required real upstream public exports are missing.");
  }

  function measure(events) {
    const prepared = prepareTimedTextEvents(events);
    const cues = runBuiltinSegmentation({
      events: prepared.events,
      flatEvents: prepared.flatEvents,
      fromLang: "ja",
      mode: "rule",
    });
    if (!Array.isArray(prepared.flatEvents) || !Array.isArray(cues)) {
      throw new Error("The upstream entry returned an unexpected output shape.");
    }
    return { flatEvents: prepared.flatEvents, cues };
  }

  const primary = measure(fixture.events);
  const spacedEvents = structuredClone(fixture.events);
  spacedEvents[0].segs[0].utf8 = spacedEvents[0].segs[0].utf8.replaceAll("\u3002", "\u3002 ");
  freezeRecursively(spacedEvents);
  const spacedControl = measure(spacedEvents);
  if (networkAttempts !== 0) {
    throw new Error("The upstream source attempted forbidden network access.");
  }

  const sourceStart = fixture.events[0].tStartMs;
  const lineBreak = fixture.events[1].tStartMs;
  const flatStart = primary.flatEvents.at(0)?.start;
  const flatEnd = primary.flatEvents.at(-1)?.end;
  const cueStart = primary.cues.at(0)?.start;
  const cueEnd = primary.cues.at(-1)?.end;
  const finiteDifference = (end, start) =>
    Number.isFinite(end) && Number.isFinite(start) ? end - start : undefined;
  const reachesLineBreak = (end) => (Number.isFinite(end) ? end >= lineBreak : undefined);

  const observations = [
    observation("source_revision", sourceRevision),
    observation("source_event_start_ms", sourceStart),
    observation("source_declared_duration_ms", fixture.events[0].dDurationMs),
    observation("source_line_break_ms", lineBreak),
    observation("source_line_break_gap_ms", lineBreak - sourceStart),
    observation("flat_event_count", primary.flatEvents.length),
    observation("flat_start_ms", flatStart),
    observation("flat_end_ms", flatEnd),
    observation("flat_duration_ms", finiteDifference(flatEnd, flatStart)),
    observation("flat_reaches_line_break", reachesLineBreak(flatEnd)),
    observation("rule_cue_count", primary.cues.length),
    observation("rule_cue_start_ms", cueStart),
    observation("rule_cue_end_ms", cueEnd),
    observation("rule_cue_duration_ms", finiteDifference(cueEnd, cueStart)),
    observation("rule_reaches_line_break", reachesLineBreak(cueEnd)),
    observation("flat_events_json", JSON.stringify(primary.flatEvents)),
    observation("rule_cues_json", JSON.stringify(primary.cues)),
    observation("flat_end_ms_spaced_control", spacedControl.flatEvents.at(-1)?.end),
    observation("rule_cue_end_ms_spaced_control", spacedControl.cues.at(-1)?.end),
  ];
  const declaredFields = new Map(
    contract.probeOutput.fields.map((field) => [field.id, field.type]),
  );
  if (
    declaredFields.size !== observations.length ||
    observations.some(
      (item) =>
        !declaredFields.has(item.id) ||
        (item.state === "observed" && declaredFields.get(item.id) !== item.value.type),
    )
  ) {
    throw new Error("The measured fields do not match the frozen probe declaration.");
  }
  return { schemaVersion: "ProbeObservationsV1", observations };
}

try {
  const output = await collect();
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`Issue #1064 probe could not collect observations: ${error.message}\n`);
  process.exitCode = 1;
}
