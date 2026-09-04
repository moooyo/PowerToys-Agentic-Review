import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { scanRuntimeLoaderSyntax } from "./verify-role-bundles.mjs";

const repositoryRoot = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
const workerSourceRoot = "apps/worker/src/";
const serverSourceRoot = "apps/server/src/";
const executionSourceRoot = `${workerSourceRoot}execution/`;
const contractsSourceRoot = "packages/contracts/src/";
const localProtocolSourceRoot = "packages/local-protocol/src/";
const executorRuntimePath = `${workerSourceRoot}service-host/executor-shadow-runtime.ts`;
const controlRuntimePath = `${workerSourceRoot}control/shadow-supervisor.ts`;
const legacyEntrypointPath = `${workerSourceRoot}main.ts`;
const dormantExecutorAttemptReducerPath = `${executionSourceRoot}executor-attempt-reducer.ts`;
const dormantResultArtifactUploadSessionPath = `${workerSourceRoot}control/result-artifact-upload-session.ts`;
const dormantArtifactHostControlV2ApiPath = `${workerSourceRoot}control/artifact-host-control-v2-api.ts`;
const dormantArtifactHostControlV2ProtocolPath = `${workerSourceRoot}service-host/artifact-host-control-v2-protocol.ts`;
const dormantArwxMinorOnePath = `${localProtocolSourceRoot}minor-1.ts`;
const dormantJobExecutionEnvelopeV2Path = `${contractsSourceRoot}job-envelope-v2.ts`;
const dormantRoleConfigV3LabPath = `${workerSourceRoot}service-host/role-config-v3-lab.ts`;
const dormantRuntimeBootstrapV2LabPath = `${workerSourceRoot}service-host/runtime-bootstrap-v2-lab.ts`;
const pinnedServerClaimProducerPath = `${serverSourceRoot}database/database-worker.ts`;
const dormantProductionExcludedPaths = new Set([
  dormantResultArtifactUploadSessionPath,
  dormantArtifactHostControlV2ApiPath,
  dormantArtifactHostControlV2ProtocolPath,
  dormantArwxMinorOnePath,
  dormantJobExecutionEnvelopeV2Path,
  dormantRoleConfigV3LabPath,
  dormantRuntimeBootstrapV2LabPath,
]);
const reviewedDormantLabExports = Object.freeze({
  [dormantRoleConfigV3LabPath]: Object.freeze(
    [
      "class:RoleConfigV3LabError",
      "type:ControlRoleConfigV3Lab",
      "type:ExecutorRoleConfigV3Lab",
      "type:ParsedRoleConfigV3Lab",
      "type:RoleConfigV3Lab",
      "type:RoleConfigV3LabRole",
      "value:ControlRoleConfigV3LabSchema",
      "value:ExecutorRoleConfigV3LabSchema",
      "value:ROLE_CONFIG_V3_LAB_ARWX_PROTOCOL_MAJOR",
      "value:ROLE_CONFIG_V3_LAB_ARWX_PROTOCOL_MINOR",
      "value:ROLE_CONFIG_V3_LAB_COMPLETION_MODE",
      "value:ROLE_CONFIG_V3_LAB_DISABLED_REASON_CODE",
      "value:ROLE_CONFIG_V3_LAB_FOUNDATION_VERSION",
      "value:ROLE_CONFIG_V3_LAB_HOST_CONTROL_OPERATIONS",
      "value:ROLE_CONFIG_V3_LAB_HOST_CONTROL_PROTOCOL_VERSION",
      "value:ROLE_CONFIG_V3_LAB_JOB_ENVELOPE_VERSION",
      "value:ROLE_CONFIG_V3_LAB_MAXIMUM_BYTES",
      "value:ROLE_CONFIG_V3_LAB_MISSING_PREREQUISITES",
      "value:ROLE_CONFIG_V3_LAB_PROFILE",
      "value:ROLE_CONFIG_V3_LAB_REQUIRED_RUNTIME_BOOTSTRAP_VERSION",
      "value:ROLE_CONFIG_V3_LAB_REQUIRED_WORKER_API_VERSION",
      "value:RoleConfigV3LabArwxSelectionSchema",
      "value:RoleConfigV3LabHostControlSelectionSchema",
      "value:createControlRoleConfigV3Lab",
      "value:createExecutorRoleConfigV3Lab",
      "value:isParsedRoleConfigV3Lab",
      "value:parseRoleConfigV3Lab",
    ].sort(),
  ),
  [dormantRuntimeBootstrapV2LabPath]: Object.freeze(
    [
      "class:RuntimeBootstrapV2LabError",
      "type:ParsedRuntimeBootstrapV2Lab",
      "type:RuntimeBootstrapV2Lab",
      "type:RuntimeBootstrapV2LabDisabledReadinessProjection",
      "type:RuntimeBootstrapV2LabFacts",
      "value:RUNTIME_BOOTSTRAP_V2_LAB_ARWX_MAXIMUM_FRAME_BYTES",
      "value:RUNTIME_BOOTSTRAP_V2_LAB_ARWX_MAXIMUM_QUEUED_BYTES",
      "value:RUNTIME_BOOTSTRAP_V2_LAB_ARWX_MINIMUM_QUEUED_BYTES",
      "value:RUNTIME_BOOTSTRAP_V2_LAB_ARWX_PROTOCOL_MAJOR",
      "value:RUNTIME_BOOTSTRAP_V2_LAB_ARWX_PROTOCOL_MINOR",
      "value:RUNTIME_BOOTSTRAP_V2_LAB_HOST_CONTROL_RPC_PROTOCOL_VERSION",
      "value:RUNTIME_BOOTSTRAP_V2_LAB_MAXIMUM_BYTES",
      "value:RUNTIME_BOOTSTRAP_V2_LAB_VERSION",
      "value:RuntimeBootstrapV2LabDisabledReadinessProjectionSchema",
      "value:RuntimeBootstrapV2LabSchema",
      "value:createRuntimeBootstrapV2Lab",
      "value:isParsedRuntimeBootstrapV2Lab",
      "value:parseRuntimeBootstrapV2Lab",
    ].sort(),
  ),
});
const reviewedDormantLabSourceSha256 = Object.freeze({
  [dormantRoleConfigV3LabPath]: "61094272098a838a5494f7dde68241363077e35bb33a6392837f516e59875ea0",
  [dormantRuntimeBootstrapV2LabPath]:
    "aba0abba97a67192065d7cc8f4997da416da10f7dbe07ca3d6feb114f2e7cac6",
});
const reviewedDormantVersionFoundationSourceSha256 = Object.freeze({
  [`${contractsSourceRoot}index.ts`]:
    "b5ec1e3a50525a2228979cf5b73afb423c804822c94f4dede91117e3d8f7944b",
  [`${contractsSourceRoot}job-envelope.ts`]:
    "ba50a125b17446d6a8d42b871fb7f324f67f9ad383ec0c5d039d79a3beea69d3",
  [`${localProtocolSourceRoot}framing.ts`]:
    "4f701c4e19bb1ebacaae8ad5f1e891029bd7a57feb35a9cc2a86d233019cc806",
  [`${localProtocolSourceRoot}index.ts`]:
    "1ba75fe66385d3867731de3f91d2071e38ad4e127ca82ed17717b39a1ac75841",
  [`${localProtocolSourceRoot}messages.ts`]:
    "343281b9d303183c693fadb67329cccb1ff01f7c45a73ff1b19ce8fe5937c043",
});
const reviewedRootBarrelExports = Object.freeze({
  [`${contractsSourceRoot}index.ts`]: Object.freeze([
    "./artifacts.js",
    "./common.js",
    "./dashboard.js",
    "./github.js",
    "./job-envelope.js",
    "./scheduling.js",
    "./states.js",
    "./worker.js",
  ]),
  [`${localProtocolSourceRoot}index.ts`]: Object.freeze([
    "./artifact-stream.js",
    "./canonical.js",
    "./capability.js",
    "./framing.js",
    "./handshake.js",
    "./messages.js",
    "./replay.js",
  ]),
});
const reviewedProductionSourceSha256 = Object.freeze({
  [executorRuntimePath]: "196c47f866270704cf23fc30a6c540c6bdbf61c82bbd2159527d9584ed831138",
  [controlRuntimePath]: "7f77b65f7336e108a80006a2b689ad2d8a6448aadf8a7138d0377f9fbe28e88a",
  [`${workerSourceRoot}service-host/runtime-bootstrap.ts`]:
    "5d5678e4f2588d0bebe066cfc5b9ae52641c7f8cddbe87a577f7ce06b8113404",
  [`${contractsSourceRoot}worker.ts`]:
    "aba5d6f2a19f24f6ed00687685c627f604781c5d8aa3bdfd753b320d1b2bb074",
  [`${workerSourceRoot}control/host-control-worker-api.ts`]:
    "30330b3954d0484ba95b6a6d70d74dcfb992aaeb08db689f56411a432d8c7189",
  [`${workerSourceRoot}execution/trusted-installation-manifest.ts`]:
    "00d80ae43e7a14e36aa50fa05215153b7b6c074c96b0a11aeb37a9f7f2b32321",
  [pinnedServerClaimProducerPath]:
    "b0d6eb99cfa1ccd45fbf2582bcaa2ab69205634f13c423e7a504abc99291763d",
});
const reviewedDormantExecutionSourceSha256 = Object.freeze({
  [dormantExecutorAttemptReducerPath]:
    "f2c1201b7699d1a0e150a10a1ed3fd5beaffb72318b67d08ffa00fcddc50a90f",
});
const reviewedTypeBoxBridgeTarget =
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/check/check.mjs";
const firstPartySourceRedirects = new Map([
  ["@agentic-review/contracts", `${contractsSourceRoot}index.ts`],
  ["@agentic-review/contracts/job-envelope-v2", dormantJobExecutionEnvelopeV2Path],
  ["@agentic-review/local-protocol", `${localProtocolSourceRoot}index.ts`],
  ["@agentic-review/local-protocol/minor-1", dormantArwxMinorOnePath],
  ["@agentic-review/worker/role-config-v3-lab", dormantRoleConfigV3LabPath],
  ["@agentic-review/worker/runtime-bootstrap-v2-lab", dormantRuntimeBootstrapV2LabPath],
]);
const allowedProductionModuleSpecifiers = new Set([
  "@sinclair/typebox",
  "@sinclair/typebox/value",
  "node:crypto",
  "node:net",
  "node:process",
  "node:stream",
  "node:util",
]);

const entrypointPolicies = Object.freeze({
  control: Object.freeze({
    path: `${workerSourceRoot}control-main.ts`,
    imports: Object.freeze([
      Object.freeze({ source: "node:process", specifiers: Object.freeze(["default:process"]) }),
      Object.freeze({
        source: "./control/shadow-supervisor.js",
        specifiers: Object.freeze([
          "named:installControlZeroSlotShadowSupervisor:installControlZeroSlotShadowSupervisor",
        ]),
      }),
      Object.freeze({
        source: "./service-host/host-control-client.js",
        specifiers: Object.freeze([
          "named:connectHostControl:connectHostControl",
          "named:isControlHostControlClient:isControlHostControlClient",
        ]),
      }),
      Object.freeze({
        source: "./service-host/role-entrypoint.js",
        specifiers: Object.freeze([
          "named:runServiceHostRoleEntrypoint:runServiceHostRoleEntrypoint",
        ]),
      }),
    ]),
    connector: "connectHostControl",
    connectionError: "Control connector received another role.",
    fatalLine:
      '{"component":"worker-control","level":"error","message":"Control payload failed closed during startup."}\n',
    runtimeInstaller: "installControlZeroSlotShadowSupervisor",
    sessionValidator: "isControlHostControlClient",
  }),
  executor: Object.freeze({
    path: `${workerSourceRoot}executor-main.ts`,
    imports: Object.freeze([
      Object.freeze({ source: "node:process", specifiers: Object.freeze(["default:process"]) }),
      Object.freeze({
        source: "./service-host/executor-host-control-session.js",
        specifiers: Object.freeze([
          "named:connectExecutorHostControl:connectExecutorHostControl",
          "named:isExecutorHostControlSession:isExecutorHostControlSession",
        ]),
      }),
      Object.freeze({
        source: "./service-host/executor-shadow-runtime.js",
        specifiers: Object.freeze([
          "named:installExecutorShadowRuntime:installExecutorShadowRuntime",
        ]),
      }),
      Object.freeze({
        source: "./service-host/role-entrypoint.js",
        specifiers: Object.freeze([
          "named:runServiceHostRoleEntrypoint:runServiceHostRoleEntrypoint",
        ]),
      }),
    ]),
    connector: "connectExecutorHostControl",
    connectionError: "Executor connector received another role.",
    fatalLine:
      '{"component":"worker-executor","level":"error","message":"Executor payload failed closed during startup."}\n',
    runtimeInstaller: "installExecutorShadowRuntime",
    sessionValidator: "isExecutorHostControlSession",
  }),
});

export function verifyZeroExecutionProductionArchitecture(sourceOverrides = {}) {
  const readSource = productionSourceReader(sourceOverrides);
  verifyDormantVersionFoundations(readSource);
  verifyDormantLabAPISurfaces(readSource);
  const dormantReducerSource = readSource(dormantExecutorAttemptReducerPath);
  verifyReviewedDormantExecutionSource(dormantExecutorAttemptReducerPath, dormantReducerSource);
  verifyDormantExecutorAttemptReducer(dormantReducerSource);
  for (const entrypoint of [
    legacyEntrypointPath,
    entrypointPolicies.control.path,
    entrypointPolicies.executor.path,
  ]) {
    verifyDormantSourceExclusion(entrypoint, readSource);
  }
  for (const [role, policy] of Object.entries(entrypointPolicies)) {
    verifyEntrypoint(role, policy, readSource(policy.path));
    verifyProductionImportGraph(policy.path, readSource);
  }
  for (const [sourcePath] of Object.entries(reviewedProductionSourceSha256)) {
    verifyReviewedProductionSource(sourcePath, readSource(sourcePath));
  }
  const executorSource = readSource(executorRuntimePath);
  const controlSource = readSource(controlRuntimePath);
  verifyPlainLocalSession(executorSource, controlSource);
}

export function verifyDormantLabAPISurfaceForTest(sourcePath, source) {
  if (!Object.hasOwn(reviewedDormantLabExports, sourcePath) || typeof source !== "string") {
    throw new TypeError("Dormant lab API review requires an exact source path and text.");
  }
  verifyDormantLabAPISurface(sourcePath, source);
}

export function verifyDormantLabSourceForTest(sourcePath, source) {
  if (!Object.hasOwn(reviewedDormantLabSourceSha256, sourcePath) || typeof source !== "string") {
    throw new TypeError("Dormant lab source review requires an exact source path and text.");
  }
  verifyReviewedDormantLabSource(sourcePath, source);
}

function verifyDormantLabAPISurfaces(readSource) {
  for (const sourcePath of Object.keys(reviewedDormantLabExports)) {
    const source = readSource(sourcePath);
    verifyReviewedDormantLabSource(sourcePath, source);
    verifyDormantLabAPISurface(sourcePath, source);
  }
}

function verifyReviewedDormantLabSource(sourcePath, source) {
  const normalized = source.replaceAll("\r\n", "\n");
  if (normalized.includes("\r") || normalized.includes("\uFEFF")) {
    throw new Error(`${sourcePath} is outside its reviewed dormant lab source form.`);
  }
  const actual = createHash("sha256").update(normalized, "utf8").digest("hex");
  if (actual !== reviewedDormantLabSourceSha256[sourcePath]) {
    throw new Error(`${sourcePath} differs from its reviewed dormant lab source.`);
  }
}

function verifyDormantLabAPISurface(sourcePath, source) {
  const sourceFile = parseTypeScript(source, sourcePath);
  const actual = [];
  for (const statement of sourceFile.program.body) {
    if (statement.type !== "ExportNamedDeclaration") {
      if (statement.type.includes("Export")) {
        throw new Error(`${sourcePath} contains an unreviewed dormant lab export form.`);
      }
      continue;
    }
    if (
      statement.source !== null ||
      statement.specifiers.length !== 0 ||
      statement.declaration === null
    ) {
      throw new Error(`${sourcePath} contains an unreviewed dormant lab export form.`);
    }
    const declaration = statement.declaration;
    if (declaration.type === "VariableDeclaration" && declaration.kind === "const") {
      for (const binding of declaration.declarations) {
        if (binding.id.type !== "Identifier") {
          throw new Error(`${sourcePath} contains a non-identifier exported constant.`);
        }
        actual.push(`value:${binding.id.name}`);
      }
      continue;
    }
    if (declaration.type === "FunctionDeclaration" && declaration.id !== null) {
      actual.push(`value:${declaration.id.name}`);
      continue;
    }
    if (declaration.type === "ClassDeclaration" && declaration.id !== null) {
      actual.push(`class:${declaration.id.name}`);
      continue;
    }
    if (
      (declaration.type === "TSTypeAliasDeclaration" ||
        declaration.type === "TSInterfaceDeclaration") &&
      declaration.id !== null
    ) {
      actual.push(`type:${declaration.id.name}`);
      continue;
    }
    throw new Error(`${sourcePath} contains an unreviewed dormant lab declaration.`);
  }
  actual.sort();
  if (JSON.stringify(actual) !== JSON.stringify(reviewedDormantLabExports[sourcePath])) {
    throw new Error(`${sourcePath} exports an unreviewed dormant lab API surface.`);
  }
}

function verifyDormantVersionFoundations(readSource) {
  for (const [sourcePath, expected] of Object.entries(
    reviewedDormantVersionFoundationSourceSha256,
  )) {
    const source = readSource(sourcePath);
    const normalized = source.replaceAll("\r\n", "\n");
    if (normalized.includes("\r") || normalized.includes("\uFEFF")) {
      throw new Error(`${sourcePath} is outside its reviewed dormant-foundation source form.`);
    }
    const actual = createHash("sha256").update(normalized, "utf8").digest("hex");
    if (actual !== expected) {
      throw new Error(`${sourcePath} differs from its reviewed dormant-foundation source.`);
    }
  }
  for (const [sourcePath, expected] of Object.entries(reviewedRootBarrelExports)) {
    const sourceFile = parseTypeScript(readSource(sourcePath), sourcePath);
    const actual = sourceFile.program.body.map((statement) => {
      if (
        statement.type !== "ExportAllDeclaration" ||
        statement.source?.type !== "StringLiteral" ||
        statement.exportKind === "type" ||
        (statement.attributes?.length ?? 0) !== 0 ||
        (statement.assertions?.length ?? 0) !== 0
      ) {
        throw new Error(`${sourcePath} contains an unreviewed root-barrel declaration.`);
      }
      return statement.source.value;
    });
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${sourcePath} root-barrel exports differ from dormant-foundation policy.`);
    }
  }
}

export function verifyDormantSourceExclusionForTest(entrypoint, sourceOverrides = {}) {
  if (
    entrypoint !== legacyEntrypointPath &&
    entrypoint !== entrypointPolicies.control.path &&
    entrypoint !== entrypointPolicies.executor.path
  ) {
    throw new TypeError("Dormant-source exclusion requires a production entrypoint.");
  }
  verifyDormantSourceExclusion(entrypoint, productionSourceReader(sourceOverrides));
}

function verifyDormantSourceExclusion(entrypoint, readSource) {
  const pending = [entrypoint];
  const visited = new Set();
  while (pending.length !== 0) {
    const sourcePath = pending.pop();
    if (sourcePath === undefined || visited.has(sourcePath)) continue;
    if (dormantProductionExcludedPaths.has(sourcePath)) {
      throw new Error(`Production import graph reaches dormant source: ${sourcePath}`);
    }
    visited.add(sourcePath);
    const source = readSource(sourcePath);
    scanRuntimeLoaderSyntax(source, sourcePath);
    const sourceFile = parseTypeScript(source, sourcePath);
    const runtimeLoads = collectSyntax(sourceFile.program, (node) =>
      node.type === "ImportExpression" ||
      (node.type === "CallExpression" &&
        (node.callee?.type === "Import" || isIdentifier(node.callee, "require"))) ||
      node.type === "TSImportType" ||
      node.type === "TSImportEqualsDeclaration"
        ? node
        : undefined,
    );
    if (runtimeLoads.length !== 0) {
      throw new Error(`Production import graph contains a runtime loader at ${sourcePath}.`);
    }
    for (const specifier of staticModuleSpecifiers(sourceFile.program)) {
      if (!specifier.startsWith(".")) {
        const redirect = firstPartySourceRedirects.get(specifier);
        if (redirect !== undefined) pending.push(redirect);
        continue;
      }
      const target = resolveTypeScriptImport(sourcePath, specifier);
      if (target !== undefined) pending.push(target);
    }
  }
}

function verifyReviewedDormantExecutionSource(sourcePath, source) {
  if (source.includes("\uFEFF")) {
    throw new Error(`${sourcePath} contains a byte-order mark outside the reviewed source form.`);
  }
  const normalized = source.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    throw new Error(
      `${sourcePath} contains an isolated carriage return outside the reviewed form.`,
    );
  }
  const actual = createHash("sha256").update(normalized, "utf8").digest("hex");
  if (actual !== reviewedDormantExecutionSourceSha256[sourcePath]) {
    throw new Error(
      `${sourcePath} differs from its reviewed dormant source; review the complete file and update its pinned SHA-256 with the guard tests.`,
    );
  }
}

export function verifyDormantExecutorAttemptReducer(source) {
  scanRuntimeLoaderSyntax(source, dormantExecutorAttemptReducerPath);
  const sourceFile = parseTypeScript(source, dormantExecutorAttemptReducerPath);
  const forbiddenGlobals = new Set([
    "AbortController",
    "AbortSignal",
    "Bun",
    "Buffer",
    "Date",
    "Deno",
    "Function",
    "Math",
    "Module",
    "Promise",
    "Reflect",
    "SharedArrayBuffer",
    "WebSocket",
    "WebAssembly",
    "clearImmediate",
    "clearInterval",
    "clearTimeout",
    "console",
    "crypto",
    "eval",
    "fetch",
    "global",
    "globalThis",
    "localStorage",
    "module",
    "navigator",
    "performance",
    "process",
    "queueMicrotask",
    "require",
    "sessionStorage",
    "setImmediate",
    "setInterval",
    "setTimeout",
  ]);
  const forbiddenMemberNames = new Set([
    "Function",
    "_linkedBinding",
    "_load",
    "binding",
    "constructor",
    "dlopen",
    "getBuiltinModule",
    "process",
    "require",
  ]);
  for (const statement of sourceFile.program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (
      statement.type === "ImportDeclaration" ||
      ((statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") &&
        statement.source !== null)
    ) {
      throw new Error("Dormant Executor attempt reducer must not import or re-export a module.");
    }
    const allowedDirectDeclaration =
      (statement.type === "VariableDeclaration" &&
        statement.kind === "const" &&
        statement.declarations.every((binding) => binding.init?.type === "RegExpLiteral")) ||
      (statement.type === "FunctionDeclaration" && !statement.async && !statement.generator) ||
      statement.type === "TSTypeAliasDeclaration";
    const allowedExportDeclaration =
      statement.type === "ExportNamedDeclaration" &&
      statement.source === null &&
      statement.specifiers.length === 0 &&
      (declaration?.type === "TSInterfaceDeclaration" ||
        declaration?.type === "TSTypeAliasDeclaration" ||
        isDormantReducerErrorClass(declaration) ||
        (declaration?.type === "FunctionDeclaration" &&
          !declaration.async &&
          !declaration.generator &&
          (declaration.id?.name === "createExecutorAttemptState" ||
            declaration.id?.name === "reduceExecutorAttempt")));
    if (!allowedDirectDeclaration && !allowedExportDeclaration) {
      throw new Error(
        "Dormant Executor attempt reducer has an unreviewed module-level declaration or effect.",
      );
    }
  }
  for (const { node } of collectSyntaxRecords(sourceFile.program)) {
    if (
      node.type === "ImportExpression" ||
      (node.type === "CallExpression" && node.callee?.type === "Import") ||
      node.type === "TSImportType" ||
      node.type === "TSImportEqualsDeclaration" ||
      node.type === "AwaitExpression" ||
      node.type === "YieldExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression" ||
      node.type === "TSFunctionType" ||
      node.type === "TSCallSignatureDeclaration" ||
      node.type === "TSConstructSignatureDeclaration" ||
      node.type === "TSMethodSignature" ||
      node.type === "ObjectMethod" ||
      node.type === "StaticBlock" ||
      ((node.type === "ClassMethod" ||
        node.type === "ClassPrivateMethod" ||
        node.type === "ClassProperty" ||
        node.type === "ClassPrivateProperty") &&
        node.static) ||
      (node.type === "VariableDeclaration" && node.kind !== "const") ||
      ((node.type === "FunctionDeclaration" ||
        node.type === "ClassMethod" ||
        node.type === "ClassPrivateMethod" ||
        node.type === "ObjectMethod") &&
        (node.async || node.generator)) ||
      (node.type === "NewExpression" &&
        !isIdentifier(node.callee, "ExecutorAttemptReducerError")) ||
      (node.type === "MemberExpression" &&
        ((node.computed &&
          node.property?.type === "StringLiteral" &&
          forbiddenMemberNames.has(node.property.value)) ||
          (!node.computed &&
            node.property?.type === "Identifier" &&
            node.property.name === "constructor"))) ||
      (node.type === "Identifier" && forbiddenGlobals.has(node.name))
    ) {
      throw new Error(
        "Dormant Executor attempt reducer contains an import, callback, async construct, authority-adjacent global, or side-effect surface.",
      );
    }
  }
}

function isDormantReducerErrorClass(declaration) {
  const member = declaration?.type === "ClassDeclaration" ? declaration.body.body[0] : undefined;
  return (
    declaration?.type === "ClassDeclaration" &&
    declaration.id?.name === "ExecutorAttemptReducerError" &&
    isIdentifier(declaration.superClass, "Error") &&
    (declaration.decorators?.length ?? 0) === 0 &&
    declaration.body.body.length === 1 &&
    member?.type === "ClassMethod" &&
    member.kind === "constructor" &&
    !member.static &&
    !member.async &&
    !member.generator &&
    (member.decorators?.length ?? 0) === 0
  );
}

function verifyReviewedProductionSource(sourcePath, source) {
  if (source.includes("\uFEFF")) {
    throw new Error(`${sourcePath} contains a byte-order mark outside the reviewed source form.`);
  }
  const normalized = source.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    throw new Error(
      `${sourcePath} contains an isolated carriage return outside the reviewed form.`,
    );
  }
  const actual = createHash("sha256").update(normalized, "utf8").digest("hex");
  if (actual !== reviewedProductionSourceSha256[sourcePath]) {
    throw new Error(
      `${sourcePath} differs from its reviewed zero-execution source; review the complete file and update its pinned SHA-256 with the guard tests.`,
    );
  }
}

function verifyEntrypoint(role, policy, source) {
  const sourceFile = parseTypeScript(source, policy.path);
  const imports = sourceFile.program.body
    .filter((node) => node.type === "ImportDeclaration")
    .map(importShape);
  if (JSON.stringify(imports) !== JSON.stringify(policy.imports)) {
    throw new Error(`${role} production entrypoint imports differ from zero-execution policy.`);
  }

  const runCalls = collectSyntax(sourceFile.program, (node) =>
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "runServiceHostRoleEntrypoint"
      ? node
      : undefined,
  );
  const run = runCalls[0];
  if (
    runCalls.length !== 1 ||
    run.arguments.length !== 2 ||
    run.arguments[0]?.type !== "StringLiteral" ||
    run.arguments[0].value !== role ||
    run.arguments[1]?.type !== "ObjectExpression"
  ) {
    throw new Error(`${role} production entrypoint invocation differs from zero-execution policy.`);
  }
  const properties = exactObjectProperties(run.arguments[1], `${role} production dependencies`);
  if (
    properties.size !== 3 ||
    properties.get("installRuntime")?.type !== "Identifier" ||
    properties.get("installRuntime").name !== policy.runtimeInstaller ||
    properties.get("validateRuntimeSession")?.type !== "Identifier" ||
    properties.get("validateRuntimeSession").name !== policy.sessionValidator ||
    properties.get("connect")?.type !== "ArrowFunctionExpression"
  ) {
    throw new Error(`${role} production runtime target differs from zero-execution policy.`);
  }
  verifyEntrypointProgramShape(role, policy, sourceFile.program, run, properties.get("connect"));
}

function verifyEntrypointProgramShape(role, policy, program, run, connect) {
  const finalStatement = program.body.at(-1);
  const awaited =
    finalStatement?.type === "ExpressionStatement" ? finalStatement.expression : undefined;
  const caught = awaited?.type === "AwaitExpression" ? awaited.argument : undefined;
  const catchHandler = caught?.type === "CallExpression" ? caught.arguments[0] : undefined;
  if (
    (program.directives?.length ?? 0) !== 0 ||
    program.interpreter !== null ||
    program.body.length !== policy.imports.length + 1 ||
    !program.body.slice(0, -1).every((node) => node.type === "ImportDeclaration") ||
    caught?.type !== "CallExpression" ||
    !isDirectMember(caught.callee, "catch") ||
    caught.callee.object !== run ||
    caught.arguments.length !== 1 ||
    catchHandler?.type !== "ArrowFunctionExpression" ||
    catchHandler.async ||
    catchHandler.params.length !== 0 ||
    catchHandler.body.type !== "BlockStatement" ||
    catchHandler.body.body.length !== 2
  ) {
    throw new Error(`${role} production entrypoint program shape changed.`);
  }
  verifyEntrypointConnector(role, policy, connect);
  verifyEntrypointFailure(role, policy, catchHandler.body.body);
}

function verifyEntrypointConnector(role, policy, connect) {
  const [options, signal] = connect.params;
  const [roleGuard, connection] = connect.body.body;
  const guard = roleGuard?.type === "IfStatement" ? roleGuard.test : undefined;
  const failure = roleGuard?.type === "IfStatement" ? roleGuard.consequent : undefined;
  const failureValue = failure?.type === "ThrowStatement" ? failure.argument : undefined;
  const returned = connection?.type === "ReturnStatement" ? connection.argument : undefined;
  const call = returned?.type === "AwaitExpression" ? returned.argument : undefined;
  if (
    !connect.async ||
    connect.params.length !== 2 ||
    !isIdentifier(options, "options") ||
    !isIdentifier(signal, "signal") ||
    connect.body.type !== "BlockStatement" ||
    connect.body.body.length !== 2 ||
    roleGuard.alternate !== null ||
    guard?.type !== "BinaryExpression" ||
    guard.operator !== "!==" ||
    !isNamedMember(guard.left, "options", "role") ||
    guard.right?.type !== "StringLiteral" ||
    guard.right.value !== role ||
    failureValue?.type !== "NewExpression" ||
    !isIdentifier(failureValue.callee, "Error") ||
    failureValue.arguments.length !== 1 ||
    failureValue.arguments[0]?.type !== "StringLiteral" ||
    failureValue.arguments[0].value !== policy.connectionError ||
    call?.type !== "CallExpression" ||
    !isIdentifier(call.callee, policy.connector) ||
    call.arguments.length !== 2 ||
    !isIdentifier(call.arguments[0], "options") ||
    !isIdentifier(call.arguments[1], "signal")
  ) {
    throw new Error(`${role} production connector shape changed.`);
  }
}

function verifyEntrypointFailure(role, policy, statements) {
  const write =
    statements[0]?.type === "ExpressionStatement" ? statements[0].expression : undefined;
  const writeTarget = write?.type === "CallExpression" ? write.callee : undefined;
  const exit = statements[1]?.type === "ExpressionStatement" ? statements[1].expression : undefined;
  if (
    write?.type !== "CallExpression" ||
    !isDirectMember(writeTarget, "write") ||
    !isNamedMember(writeTarget.object, "process", "stderr") ||
    write.arguments.length !== 1 ||
    write.arguments[0]?.type !== "StringLiteral" ||
    write.arguments[0].value !== policy.fatalLine ||
    exit?.type !== "AssignmentExpression" ||
    exit.operator !== "=" ||
    !isNamedMember(exit.left, "process", "exitCode") ||
    exit.right?.type !== "NumericLiteral" ||
    exit.right.value !== 1
  ) {
    throw new Error(`${role} production failure closure changed.`);
  }
}

function verifyProductionImportGraph(entrypoint, readSource) {
  const pending = [entrypoint];
  const visited = new Set();
  while (pending.length !== 0) {
    const sourcePath = pending.pop();
    if (sourcePath === undefined || visited.has(sourcePath)) continue;
    if (sourcePath.startsWith(executionSourceRoot)) {
      throw new Error(`Zero-execution production graph reaches forbidden source: ${sourcePath}`);
    }
    visited.add(sourcePath);
    const source = readSource(sourcePath);
    scanRuntimeLoaderSyntax(source, sourcePath);
    const sourceFile = parseTypeScript(source, sourcePath);
    for (const dynamicImport of collectSyntax(sourceFile.program, (node) =>
      node.type === "ImportExpression" ||
      (node.type === "CallExpression" &&
        (node.callee?.type === "Import" || isIdentifier(node.callee, "require"))) ||
      node.type === "TSImportType" ||
      node.type === "TSImportEqualsDeclaration"
        ? node
        : undefined,
    )) {
      throw new Error(
        `Zero-execution production graph contains an unsupported import at ${sourcePath}:${dynamicImport.loc?.start.line ?? 0}.`,
      );
    }
    for (const specifier of staticModuleSpecifiers(sourceFile.program)) {
      if (!specifier.startsWith(".")) {
        const redirect = firstPartySourceRedirects.get(specifier);
        if (redirect !== undefined) {
          pending.push(redirect);
          continue;
        }
        if (!allowedProductionModuleSpecifiers.has(specifier)) {
          throw new Error(
            `Zero-execution production graph contains an unreviewed module import: ${sourcePath} -> ${specifier}`,
          );
        }
        continue;
      }
      const target = resolveTypeScriptImport(sourcePath, specifier);
      if (target === undefined) continue;
      pending.push(target);
    }
  }
}

function verifyPlainLocalSession(executorSource, controlSource) {
  const executor = parseTypeScript(executorSource, executorRuntimePath);
  verifyExactImportBindings(executor.program, "@agentic-review/local-protocol", [
    "type:DeepReadonly:DeepReadonly",
    "type:DrainedMessage:DrainedMessage",
    "type:DrainMessage:DrainMessage",
    "type:EstablishedLocalSession:EstablishedLocalSession",
    "value:establishLocalSession:establishLocalSession",
    "type:HelloAckMessage:HelloAckMessage",
    "type:HelloMessage:HelloMessage",
    "value:LOCAL_PROTOCOL_NIL_CORRELATION_ID:LOCAL_PROTOCOL_NIL_CORRELATION_ID",
    "value:LocalMessageType:LocalMessageType",
    "type:ReadyMessage:ReadyMessage",
    "value:validateLocalMessagePayload:validateLocalMessagePayload",
    "value:validateReadyForEstablishedSession:validateReadyForEstablishedSession",
  ]);
  verifyLocalMessageTypeReferences(executor.program, {
    Drain: 2,
    Drained: 1,
    Hello: 1,
    HelloAck: 2,
    Ready: 1,
  });
  verifyExactMessagePublications(executor.program, [
    ["send", "private:arwx", "HelloAck"],
    ["send", "private:arwx", "Ready"],
    ["sendFinal", "identifier:dispatch", "Drained"],
  ]);
  verifyPrivateTransportReferences(executor.program);
  verifyPlainSessionCalls(executor.program, executorSource, "Executor");

  const control = parseTypeScript(controlSource, controlRuntimePath);
  verifyExactImportBindings(control.program, "@agentic-review/local-protocol", [
    "type:DeepReadonly:DeepReadonly",
    "type:DrainedMessage:DrainedMessage",
    "type:EstablishedLocalSession:EstablishedLocalSession",
    "value:establishLocalSession:establishLocalSession",
    "type:HelloAckMessage:HelloAckMessage",
    "type:HelloMessage:HelloMessage",
    "value:LOCAL_PROTOCOL_NIL_CORRELATION_ID:LOCAL_PROTOCOL_NIL_CORRELATION_ID",
    "value:LocalMessageType:LocalMessageType",
    "type:ReadyMessage:ReadyMessage",
    "value:validateReadyForEstablishedSession:validateReadyForEstablishedSession",
  ]);
  verifyLocalMessageTypeReferences(control.program, {
    Drain: 1,
    Drained: 1,
    Hello: 1,
    HelloAck: 1,
    Ready: 1,
  });
  verifyExactMessagePublications(control.program, [
    ["send", "private:arwx", "Hello"],
    ["sendFinal", "private:arwx", "Drain"],
  ]);
  verifyPrivateTransportReferences(control.program);
  verifyPlainSessionCalls(control.program, controlSource, "Control");
}

function verifyPlainSessionCalls(program, source, role) {
  const calls = collectSyntax(program, (node) =>
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    (node.callee.name === "establishLocalSession" ||
      node.callee.name === "validateReadyForEstablishedSession")
      ? node.callee.name
      : undefined,
  );
  if (
    calls.filter((name) => name === "establishLocalSession").length !== 1 ||
    calls.filter((name) => name === "validateReadyForEstablishedSession").length !== 1
  ) {
    throw new Error(`${role} must establish and validate exactly one plain local session.`);
  }
  for (const forbidden of [
    "ControlProof",
    "signLocalDigest",
    "localAuthorityKeyId",
    "localAuthorityPublicKey",
    "awaiting_control_proof",
    "HANDSHAKE_PROOF_INVALID",
  ]) {
    if (source.includes(forbidden)) {
      throw new Error(`${role} local session retains forbidden cryptographic state: ${forbidden}`);
    }
  }
  const requiredFragments =
    role === "Executor"
      ? [
          "session = establishLocalSession(hello, helloAck);",
          "validateReadyForEstablishedSession(readyCandidate, session)",
          "ready: false",
          "availableSlots: 0",
          'reasonCode: "EXECUTION_DISABLED"',
        ]
      : [
          "session = establishLocalSession(this.#hello, helloAck);",
          "validateReadyForEstablishedSession(readyValue, session)",
          "ready.ready !== false",
          "ready.availableSlots !== 0",
          "ready.reasonCode !== executionDisabledReason",
        ];
  for (const fragment of requiredFragments) {
    if (!source.includes(fragment)) {
      throw new Error(`${role} local session validation changed: ${fragment}`);
    }
  }
}

function verifyExactImportBindings(program, source, expected) {
  const declarations = program.body.filter(
    (node) => node.type === "ImportDeclaration" && node.source.value === source,
  );
  const declaration = declarations[0];
  if (
    declarations.length !== 1 ||
    declaration.importKind === "type" ||
    (declaration.attributes?.length ?? 0) !== 0 ||
    (declaration.assertions?.length ?? 0) !== 0
  ) {
    throw new Error(`Production import bindings for ${source} changed.`);
  }
  const actual = declaration.specifiers.map((specifier) => {
    if (
      specifier.type !== "ImportSpecifier" ||
      specifier.imported?.type !== "Identifier" ||
      specifier.local?.type !== "Identifier"
    ) {
      return "unsupported";
    }
    const kind = specifier.importKind === "type" ? "type" : "value";
    return `${kind}:${specifier.imported.name}:${specifier.local.name}`;
  });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Production import bindings for ${source} changed.`);
  }
}

function verifyLocalMessageTypeReferences(program, expectedCounts) {
  const counts = new Map();
  for (const { node, parent } of collectSyntaxRecords(program)) {
    if (!isIdentifier(node, "LocalMessageType") || parent?.type === "ImportSpecifier") continue;
    if (
      parent?.type !== "MemberExpression" ||
      parent.object !== node ||
      parent.computed ||
      parent.property?.type !== "Identifier" ||
      !Object.hasOwn(expectedCounts, parent.property.name)
    ) {
      throw new Error("Production LocalMessageType is aliased or uses a computed member.");
    }
    counts.set(parent.property.name, (counts.get(parent.property.name) ?? 0) + 1);
  }
  const actual = Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  );
  const expected = Object.fromEntries(
    Object.entries(expectedCounts).sort(([left], [right]) => left.localeCompare(right)),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Production LocalMessageType reference closure changed.");
  }
}

function verifyExactMessagePublications(program, expected) {
  const publications = collectSyntax(program, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.callee?.type !== "MemberExpression" ||
      node.callee.computed ||
      node.callee.property?.type !== "Identifier" ||
      (node.callee.property.name !== "send" && node.callee.property.name !== "sendFinal")
    ) {
      return undefined;
    }
    const message = node.arguments[0];
    if (message?.type !== "ObjectExpression") {
      throw new Error("Production message publication does not use an exact object.");
    }
    const fields = exactObjectProperties(message, "Production message publication");
    const messageType = fields.get("messageType");
    if (
      messageType?.type !== "MemberExpression" ||
      messageType.computed ||
      !isIdentifier(messageType.object, "LocalMessageType") ||
      messageType.property?.type !== "Identifier"
    ) {
      throw new Error("Production message publication uses an unreviewed message type.");
    }
    return {
      call: node,
      descriptor: [
        node.callee.property.name,
        publicationReceiver(node.callee.object),
        messageType.property.name,
      ],
      messageType: messageType.property.name,
    };
  });
  if (
    JSON.stringify(publications.map(({ descriptor }) => descriptor)) !== JSON.stringify(expected)
  ) {
    throw new Error("Production message publication closure changed.");
  }
  return new Map(publications.map(({ call, messageType }) => [messageType, call]));
}

function publicationReceiver(node) {
  if (isThisPrivateMember(node, "arwx")) return "private:arwx";
  if (node?.type === "Identifier") return `identifier:${node.name}`;
  return "unsupported";
}

function verifyPrivateTransportReferences(program) {
  const records = collectSyntaxRecords(program);
  const parentByNode = new Map(records.map(({ node, parent }) => [node, parent]));
  for (const { node, parent } of records) {
    if (!isThisPrivateMember(node, "arwx")) continue;
    if (parent?.type === "AssignmentExpression" && parent.left === node) continue;
    if (parent?.type !== "MemberExpression" || parent.object !== node || parent.computed) {
      throw new Error("Production ARWX transport is aliased or uses a computed member.");
    }
    if (
      parent.property?.type === "Identifier" &&
      (parent.property.name === "send" || parent.property.name === "sendFinal")
    ) {
      const call = parentByNode.get(parent);
      if (call?.type !== "CallExpression" || call.callee !== parent) {
        throw new Error("Production ARWX publication method is extracted from its owner.");
      }
    }
  }
}

function productionSourceReader(overrides) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("Zero-execution source overrides must be an object.");
  }
  for (const [path, source] of Object.entries(overrides)) {
    if (!canonicalPinSource(path) || typeof source !== "string") {
      throw new TypeError("Zero-execution source override is invalid.");
    }
  }
  return (path) => {
    if (!canonicalPinSource(path)) {
      throw new Error(`Zero-execution architecture requested a noncanonical source: ${path}`);
    }
    if (Object.hasOwn(overrides, path)) return overrides[path];
    const absolute = realpathSync(resolve(repositoryRoot, path));
    const repositoryRelative = relative(repositoryRoot, absolute);
    if (
      repositoryRelative === "" ||
      repositoryRelative === ".." ||
      repositoryRelative.startsWith(`..${sep}`) ||
      isAbsolute(repositoryRelative) ||
      repositoryRelative.replaceAll("\\", "/") !== path
    ) {
      throw new Error(`Reviewed source path escapes the repository: ${path}`);
    }
    return readFileSync(absolute, "utf8");
  };
}

function canonicalRepositorySource(path) {
  return (
    typeof path === "string" &&
    [workerSourceRoot, contractsSourceRoot, localProtocolSourceRoot].some((root) =>
      path.startsWith(root),
    ) &&
    path.endsWith(".ts") &&
    !path.includes("\\") &&
    posix.normalize(path) === path
  );
}

function canonicalPinSource(path) {
  return path === pinnedServerClaimProducerPath || canonicalRepositorySource(path);
}

function resolveTypeScriptImport(importer, specifier) {
  const resolved = posix.normalize(posix.join(posix.dirname(importer), specifier));
  if (resolved === reviewedTypeBoxBridgeTarget) return undefined;
  const sourcePath =
    resolved.endsWith(".js") || resolved.endsWith(".mjs")
      ? `${resolved.slice(0, resolved.lastIndexOf("."))}.ts`
      : resolved;
  if (!canonicalRepositorySource(sourcePath)) {
    throw new Error(
      `Production relative import escapes reviewed source: ${importer} -> ${resolved}`,
    );
  }
  if (resolved.endsWith(".js") || resolved.endsWith(".mjs")) {
    return sourcePath;
  }
  if (resolved.endsWith(".ts")) return resolved;
  throw new Error(
    `Production import omits a supported source extension: ${importer} -> ${specifier}`,
  );
}

function parseTypeScript(source, sourceName) {
  try {
    return parse(source, { sourceType: "module", plugins: ["typescript"] });
  } catch {
    throw new Error(`${sourceName} could not be parsed for zero-execution architecture review.`);
  }
}

function importShape(declaration) {
  if (
    declaration.importKind === "type" ||
    (declaration.attributes?.length ?? 0) !== 0 ||
    (declaration.assertions?.length ?? 0) !== 0
  ) {
    throw new Error("Production entrypoint uses an unsupported import form.");
  }
  const specifiers = declaration.specifiers.map((specifier) => {
    if (specifier.type === "ImportDefaultSpecifier") return `default:${specifier.local.name}`;
    if (
      specifier.type === "ImportSpecifier" &&
      specifier.importKind !== "type" &&
      specifier.imported.type === "Identifier"
    ) {
      return `named:${specifier.imported.name}:${specifier.local.name}`;
    }
    throw new Error("Production entrypoint uses an unsupported import binding.");
  });
  return { source: declaration.source.value, specifiers };
}

function staticModuleSpecifiers(program) {
  const result = [];
  for (const node of program.body) {
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source?.type === "StringLiteral"
    ) {
      result.push(node.source.value);
    }
  }
  return result;
}

function exactObjectProperties(object, description) {
  const result = new Map();
  for (const property of object.properties) {
    if (
      property.type !== "ObjectProperty" ||
      property.computed ||
      property.method ||
      property.shorthand ||
      property.key.type !== "Identifier" ||
      result.has(property.key.name)
    ) {
      throw new Error(`${description} contains an unsupported or duplicate property.`);
    }
    result.set(property.key.name, property.value);
  }
  return result;
}

function collectSyntax(root, select) {
  return collectSyntaxRecords(root)
    .map(({ node }) => select(node))
    .filter((value) => value !== undefined);
}

function collectSyntaxRecords(root) {
  const records = [];
  const visit = (node, parent) => {
    if (node === null || typeof node !== "object") return;
    records.push({ node, parent });
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child, node);
      } else {
        visit(value, node);
      }
    }
  };
  visit(root, undefined);
  return records;
}

function privateName(node) {
  return node?.type === "PrivateName" && node.id?.type === "Identifier" ? node.id.name : undefined;
}

function isIdentifier(node, name) {
  return node?.type === "Identifier" && node.name === name;
}

function isDirectMember(node, property) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.property?.type === "Identifier" &&
    node.property.name === property
  );
}

function isNamedMember(node, object, property) {
  return isDirectMember(node, property) && isIdentifier(node.object, object);
}

function isThisPrivateMember(node, property) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object?.type === "ThisExpression" &&
    privateName(node.property) === property
  );
}
