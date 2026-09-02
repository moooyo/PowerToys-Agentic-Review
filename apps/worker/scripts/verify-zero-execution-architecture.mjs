import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { scanRuntimeLoaderSyntax } from "./verify-role-bundles.mjs";

const repositoryRoot = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
const workerSourceRoot = "apps/worker/src/";
const executionSourceRoot = `${workerSourceRoot}execution/`;
const contractsSourceRoot = "packages/contracts/src/";
const localProtocolSourceRoot = "packages/local-protocol/src/";
const executorRuntimePath = `${workerSourceRoot}service-host/executor-shadow-runtime.ts`;
const controlRuntimePath = `${workerSourceRoot}control/shadow-supervisor.ts`;
const legacyEntrypointPath = `${workerSourceRoot}main.ts`;
const dormantExecutorAttemptReducerPath = `${executionSourceRoot}executor-attempt-reducer.ts`;
const dormantResultArtifactUploadSessionPath = `${workerSourceRoot}control/result-artifact-upload-session.ts`;
const reviewedProductionSourceSha256 = Object.freeze({
  [executorRuntimePath]: "ad7435ddf526263c6d337de2601cadbb2c3964fbb7cdc00d1d77549f728b8ff1",
  [controlRuntimePath]: "6b795bc2d5d5d46ecf3581fe50f2590e730f4bdf49b20f09d8347c03f7e8c005",
});
const reviewedDormantExecutionSourceSha256 = Object.freeze({
  [dormantExecutorAttemptReducerPath]:
    "f2c1201b7699d1a0e150a10a1ed3fd5beaffb72318b67d08ffa00fcddc50a90f",
});
const reviewedTypeBoxBridgeTarget =
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox/build/esm/value/check/check.mjs";
const firstPartySourceRedirects = new Map([
  ["@agentic-review/contracts", `${contractsSourceRoot}worker.ts`],
  ["@agentic-review/local-protocol", `${localProtocolSourceRoot}index.ts`],
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
  const dormantReducerSource = readSource(dormantExecutorAttemptReducerPath);
  verifyReviewedDormantExecutionSource(dormantExecutorAttemptReducerPath, dormantReducerSource);
  verifyDormantExecutorAttemptReducer(dormantReducerSource);
  for (const entrypoint of [
    legacyEntrypointPath,
    entrypointPolicies.control.path,
    entrypointPolicies.executor.path,
  ]) {
    verifyDormantUploadSessionExclusion(entrypoint, readSource);
  }
  for (const [role, policy] of Object.entries(entrypointPolicies)) {
    verifyEntrypoint(role, policy, readSource(policy.path));
    verifyProductionImportGraph(policy.path, readSource);
  }
  const executorSource = readSource(executorRuntimePath);
  const controlSource = readSource(controlRuntimePath);
  verifyReviewedProductionSource(executorRuntimePath, executorSource);
  verifyReviewedProductionSource(controlRuntimePath, controlSource);
  verifyAuthenticatedDisabledReady(executorSource, controlSource);
}

function verifyDormantUploadSessionExclusion(entrypoint, readSource) {
  const pending = [entrypoint];
  const visited = new Set();
  while (pending.length !== 0) {
    const sourcePath = pending.pop();
    if (sourcePath === undefined || visited.has(sourcePath)) continue;
    if (sourcePath === dormantResultArtifactUploadSessionPath) {
      throw new Error(
        `Production import graph reaches dormant result artifact upload source: ${sourcePath}`,
      );
    }
    visited.add(sourcePath);
    const source = readSource(sourcePath);
    scanRuntimeLoaderSyntax(source, sourcePath);
    const sourceFile = parseTypeScript(source, sourcePath);
    const runtimeLoads = collectSyntax(sourceFile.program, (node) =>
      node.type === "ImportExpression" ||
      (node.type === "CallExpression" &&
        (node.callee?.type === "Import" || isIdentifier(node.callee, "require")))
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

function verifyAuthenticatedDisabledReady(executorSource, controlSource) {
  const sourceFile = parseTypeScript(executorSource, executorRuntimePath);
  verifyExactImportBindings(sourceFile.program, "@agentic-review/local-protocol", [
    "type:ControlProofMessage:ControlProofMessage",
    "value:createHandshakeTranscriptV1:createHandshakeTranscriptV1",
    "type:DeepReadonly:DeepReadonly",
    "type:DrainedMessage:DrainedMessage",
    "type:DrainMessage:DrainMessage",
    "type:HelloAckMessage:HelloAckMessage",
    "type:HelloMessage:HelloMessage",
    "value:LOCAL_PROTOCOL_NIL_CORRELATION_ID:LOCAL_PROTOCOL_NIL_CORRELATION_ID",
    "value:LocalMessageType:LocalMessageType",
    "type:ReadyMessage:ReadyMessage",
    "value:validateLocalMessagePayload:validateLocalMessagePayload",
    "value:validateReadyAfterHandshakeProofV1:validateReadyAfterHandshakeProofV1",
    "value:verifyControlProofMessageV1:verifyControlProofMessageV1",
  ]);
  verifyLocalMessageTypeReferences(sourceFile.program, {
    ControlProof: 1,
    Drain: 2,
    Drained: 1,
    Hello: 1,
    HelloAck: 2,
    Ready: 1,
  });
  const executorPublications = verifyExactMessagePublications(sourceFile.program, [
    ["send", "private:arwx", "HelloAck"],
    ["send", "private:arwx", "Ready"],
    ["sendFinal", "identifier:dispatch", "Drained"],
  ]);
  verifyPrivateTransportReferences(sourceFile.program);
  verifyExecutorProofDispatch(sourceFile.program);
  const methods = collectSyntax(sourceFile.program, (node) =>
    node.type === "ClassPrivateMethod" && privateName(node.key) === "handleControlProof"
      ? node
      : undefined,
  );
  const method = methods[0];
  if (
    methods.length !== 1 ||
    !method.async ||
    method.generator ||
    method.params.length !== 1 ||
    !isIdentifier(method.params[0], "message") ||
    (method.body.directives?.length ?? 0) !== 0 ||
    method.body.body.length !== 11
  ) {
    throw new Error("Executor disabled Ready must have one private Control-proof handler.");
  }

  const [
    messageGuard,
    helloStatement,
    helloAckStatement,
    proofStatement,
    verifiedStatement,
    proofTry,
    closeGuard,
    readyCandidateStatement,
    readyStatement,
    sendStatement,
    phaseStatement,
  ] = method.body.body;
  if (
    !isExactMessageTypeGuard(messageGuard, "ControlProof") ||
    !isExactConstCall(helloStatement, "hello", "required", [
      isThisPrivateMemberNamed("hello"),
      isStringNamed("Control Hello"),
    ]) ||
    !isExactConstCall(helloAckStatement, "helloAck", "required", [
      isThisPrivateMemberNamed("helloAck"),
      isStringNamed("Executor HelloAck"),
    ]) ||
    !isExactConstCall(proofStatement, "proof", "normalizePayload", [
      isIdentifierNamed("message"),
    ]) ||
    verifiedStatement?.type !== "VariableDeclaration" ||
    verifiedStatement.kind !== "let" ||
    verifiedStatement.declarations.length !== 1 ||
    !isIdentifier(verifiedStatement.declarations[0]?.id, "verified") ||
    verifiedStatement.declarations[0].init !== null ||
    !isExactCloseGuard(closeGuard)
  ) {
    throw new Error("Executor Control-proof handler statement sequence changed.");
  }

  const records = collectSyntaxRecords(method.body);
  const proofAssignment =
    proofTry?.type === "TryStatement" && proofTry.block.body.length === 1
      ? proofTry.block.body[0]
      : undefined;
  const assigned =
    proofAssignment?.type === "ExpressionStatement" ? proofAssignment.expression : undefined;
  const verifyCall = assigned?.type === "AssignmentExpression" ? assigned.right : undefined;
  const proofFailure = proofTry?.type === "TryStatement" ? proofTry.handler : undefined;
  const failureStatement = proofFailure?.body.body[0];
  const failureCall =
    failureStatement?.type === "ThrowStatement" ? failureStatement.argument : undefined;
  const authorityKey = verifyCall?.type === "CallExpression" ? verifyCall.arguments[1] : undefined;
  const verifyOptions =
    verifyCall?.type === "CallExpression" && verifyCall.arguments[2]?.type === "ObjectExpression"
      ? exactObjectProperties(verifyCall.arguments[2], "Executor proof verification")
      : undefined;
  if (
    proofTry?.type !== "TryStatement" ||
    proofTry.finalizer !== null ||
    proofTry.block.body.length !== 1 ||
    assigned?.type !== "AssignmentExpression" ||
    assigned.operator !== "=" ||
    !isIdentifier(assigned.left, "verified") ||
    verifyCall?.type !== "CallExpression" ||
    !isIdentifier(verifyCall.callee, "verifyControlProofMessageV1") ||
    verifyCall.arguments.length !== 3 ||
    !isIdentifier(verifyCall.arguments[0], "proof") ||
    authorityKey?.type !== "CallExpression" ||
    !isIdentifier(authorityKey.callee, "required") ||
    authorityKey.arguments.length !== 2 ||
    !isThisPrivatePropertyChain(
      authorityKey.arguments[0],
      "bootstrap",
      "localAuthorityPublicKey",
    ) ||
    authorityKey.arguments[1]?.type !== "StringLiteral" ||
    authorityKey.arguments[1].value !== "pinned Executor public key" ||
    verifyOptions?.size !== 3 ||
    !isThisPrivatePropertyChain(
      verifyOptions.get("expectedKeyId"),
      "bootstrap",
      "roleConfig",
      "localAuthorityKeyId",
    ) ||
    !isIdentifier(verifyOptions.get("expectedHello"), "hello") ||
    !isIdentifier(verifyOptions.get("expectedHelloAck"), "helloAck") ||
    proofFailure?.type !== "CatchClause" ||
    !isIdentifier(proofFailure.param, "error") ||
    proofFailure.body.body.length !== 1 ||
    failureCall?.type !== "CallExpression" ||
    !isIdentifier(failureCall.callee, "runtimeError") ||
    failureCall.arguments.length !== 3 ||
    failureCall.arguments[0]?.type !== "StringLiteral" ||
    failureCall.arguments[0].value !== "HANDSHAKE_PROOF_INVALID" ||
    failureCall.arguments[1]?.type !== "StringLiteral" ||
    failureCall.arguments[1].value !== "Control handshake proof is invalid." ||
    !isIdentifier(failureCall.arguments[2], "error")
  ) {
    throw new Error("Executor Ready is not preceded by one authenticated Control-proof result.");
  }

  const readyCandidateDeclaration = singleDeclaration(
    readyCandidateStatement,
    "const",
    "readyCandidate",
  );
  if (readyCandidateDeclaration?.init?.type !== "ObjectExpression") {
    throw new Error("Executor disabled Ready candidate declaration changed.");
  }
  const readyFields = exactObjectProperties(
    readyCandidateDeclaration.init,
    "Executor disabled Ready",
  );
  if (
    readyFields.size !== 15 ||
    !isNamedMember(readyFields.get("protocolMajor"), "helloAck", "protocolMajor") ||
    !isNamedMember(readyFields.get("protocolMinor"), "helloAck", "protocolMinor") ||
    !isNamedMember(readyFields.get("workerNodeId"), "helloAck", "workerNodeId") ||
    !isNamedMember(readyFields.get("workerInstanceId"), "helloAck", "workerInstanceId") ||
    !isNamedMember(readyFields.get("executorBootId"), "helloAck", "executorBootId") ||
    !isNamedMember(readyFields.get("sessionId"), "helloAck", "sessionId") ||
    !isNamedMember(readyFields.get("controlNonce"), "helloAck", "controlNonce") ||
    !isNamedMember(readyFields.get("executorNonce"), "helloAck", "executorNonce") ||
    !isNamedMember(
      readyFields.get("executorManifestSha256"),
      "helloAck",
      "executorManifestSha256",
    ) ||
    !isNamedMember(readyFields.get("executorPolicySha256"), "helloAck", "executorPolicySha256") ||
    !isNamedMember(
      readyFields.get("executorPreflightSha256"),
      "helloAck",
      "executorPreflightSha256",
    ) ||
    readyFields.get("isolationMode")?.type !== "StringLiteral" ||
    readyFields.get("isolationMode").value !== "split-service-v1" ||
    readyFields.get("ready")?.type !== "BooleanLiteral" ||
    readyFields.get("ready").value !== false ||
    readyFields.get("availableSlots")?.type !== "NumericLiteral" ||
    readyFields.get("availableSlots").value !== 0 ||
    readyFields.get("reasonCode")?.type !== "StringLiteral" ||
    readyFields.get("reasonCode").value !== "EXECUTION_DISABLED"
  ) {
    throw new Error("Executor Ready is not the exact disabled zero-slot attestation.");
  }

  const readyDeclaration = singleDeclaration(readyStatement, "const", "ready");
  const validationCall = readyDeclaration?.init;
  if (
    validationCall?.type !== "CallExpression" ||
    !isIdentifier(validationCall.callee, "validateReadyAfterHandshakeProofV1") ||
    validationCall.arguments.length !== 2 ||
    !isIdentifier(validationCall.arguments[0], "readyCandidate") ||
    !isIdentifier(validationCall.arguments[1], "verified")
  ) {
    throw new Error("Executor disabled Ready is not bound to the verified handshake proof.");
  }

  const awaited =
    sendStatement?.type === "ExpressionStatement" ? sendStatement.expression : undefined;
  const send = awaited?.type === "AwaitExpression" ? awaited.argument : undefined;
  const sendFields =
    send?.type === "CallExpression" && send.arguments[0]?.type === "ObjectExpression"
      ? exactObjectProperties(send.arguments[0], "Executor Ready send")
      : undefined;
  const phaseAssignment =
    phaseStatement?.type === "ExpressionStatement" ? phaseStatement.expression : undefined;
  if (
    send?.type !== "CallExpression" ||
    !isDirectMember(send.callee, "send") ||
    !isThisPrivateMember(send.callee.object, "arwx") ||
    send.arguments.length !== 1 ||
    sendFields?.size !== 3 ||
    !isNamedMember(sendFields.get("messageType"), "LocalMessageType", "Ready") ||
    !isIdentifier(sendFields.get("correlationId"), "LOCAL_PROTOCOL_NIL_CORRELATION_ID") ||
    !isIdentifier(sendFields.get("payload"), "ready") ||
    phaseAssignment?.type !== "AssignmentExpression" ||
    phaseAssignment.operator !== "=" ||
    !isThisPrivateMember(phaseAssignment.left, "phase") ||
    phaseAssignment.right?.type !== "StringLiteral" ||
    phaseAssignment.right.value !== "ready_disabled"
  ) {
    throw new Error("Executor disabled Ready publication is not ordered after authentication.");
  }

  const readyMembers = collectSyntax(sourceFile.program, (node) =>
    isNamedMember(node, "LocalMessageType", "Ready") ? node : undefined,
  );
  if (
    readyMembers.length !== 1 ||
    readyMembers[0] !== sendFields.get("messageType") ||
    executorPublications.get("Ready") !== send
  ) {
    throw new Error("Executor has another Ready publication path.");
  }

  const namedCalls = (name) =>
    records.filter(({ node }) => node.type === "CallExpression" && isIdentifier(node.callee, name));
  const sendCalls = records.filter(
    ({ node }) => node.type === "CallExpression" && isDirectMember(node.callee, "send"),
  );
  if (
    namedCalls("verifyControlProofMessageV1").length !== 1 ||
    namedCalls("validateReadyAfterHandshakeProofV1").length !== 1 ||
    sendCalls.length !== 1 ||
    collectSyntax(method.body, (node) => (node.type === "ReturnStatement" ? node : undefined))
      .length !== 0 ||
    bindingWriteCount(records, "hello") !== 1 ||
    bindingWriteCount(records, "helloAck") !== 1 ||
    bindingWriteCount(records, "proof") !== 1 ||
    bindingWriteCount(records, "verified") !== 2 ||
    bindingWriteCount(records, "readyCandidate") !== 1 ||
    bindingWriteCount(records, "ready") !== 1
  ) {
    throw new Error("Executor disabled Ready bindings or control flow changed.");
  }

  verifyControlDisabledReadyAcceptance(controlSource);
}

function verifyControlDisabledReadyAcceptance(source) {
  const sourceFile = parseTypeScript(source, controlRuntimePath);
  verifyExactImportBindings(sourceFile.program, "@agentic-review/local-protocol", [
    "type:ControlProofMessage:ControlProofMessage",
    "value:createControlProofMessageV1:createControlProofMessageV1",
    "value:createHandshakeTranscriptSigningDigest:createHandshakeTranscriptSigningDigest",
    "value:createHandshakeTranscriptV1:createHandshakeTranscriptV1",
    "value:createSignedHandshakeProofV1:createSignedHandshakeProofV1",
    "type:DeepReadonly:DeepReadonly",
    "type:DrainedMessage:DrainedMessage",
    "type:HelloAckMessage:HelloAckMessage",
    "type:HelloMessage:HelloMessage",
    "value:LOCAL_PROTOCOL_NIL_CORRELATION_ID:LOCAL_PROTOCOL_NIL_CORRELATION_ID",
    "value:LocalMessageType:LocalMessageType",
    "type:ReadyMessage:ReadyMessage",
  ]);
  verifyLocalMessageTypeReferences(sourceFile.program, {
    ControlProof: 1,
    Drain: 1,
    Drained: 1,
    Hello: 1,
    HelloAck: 1,
    Ready: 1,
  });
  verifyExactMessagePublications(sourceFile.program, [
    ["send", "private:arwx", "Hello"],
    ["send", "private:arwx", "ControlProof"],
    ["sendFinal", "private:arwx", "Drain"],
  ]);
  verifyPrivateTransportReferences(sourceFile.program);
  const sourceRecords = collectSyntaxRecords(sourceFile.program);
  const constants = sourceRecords.filter(
    ({ node }) =>
      node.type === "VariableDeclarator" && isIdentifier(node.id, "executionDisabledReason"),
  );
  const constant = constants[0];
  if (
    constants.length !== 1 ||
    constant.parent?.type !== "VariableDeclaration" ||
    constant.parent.kind !== "const" ||
    constant.parent.declarations.length !== 1 ||
    constant.node.init?.type !== "TSAsExpression" ||
    constant.node.init.expression?.type !== "StringLiteral" ||
    constant.node.init.expression.value !== "EXECUTION_DISABLED" ||
    bindingWriteCount(sourceRecords, "executionDisabledReason") !== 1 ||
    bindingWriteCount(sourceRecords, "validateControlReady") !== 1
  ) {
    throw new Error("Control disabled Ready reason constant changed.");
  }
  const functions = collectSyntax(sourceFile.program, (node) =>
    node.type === "FunctionDeclaration" && node.id?.name === "validateControlReady"
      ? node
      : undefined,
  );
  const validator = functions[0];
  if (
    functions.length !== 1 ||
    validator.async ||
    validator.generator ||
    validator.params.length !== 2 ||
    !isIdentifier(validator.params[0], "ready") ||
    !isIdentifier(validator.params[1], "context") ||
    (validator.body.directives?.length ?? 0) !== 0 ||
    validator.body.body.length !== 4
  ) {
    throw new Error("Control disabled Ready validator changed.");
  }

  const [helloAckStatement, proofStatement, rejection, accepted] = validator.body.body;
  const helloAck = singleDeclaration(helloAckStatement, "const", "helloAck");
  const proof = singleDeclaration(proofStatement, "const", "proof");
  const rejectionStatements =
    rejection?.type === "IfStatement" && rejection.consequent?.type === "BlockStatement"
      ? rejection.consequent.body
      : undefined;
  const rejectionCall =
    rejectionStatements?.[0]?.type === "ThrowStatement"
      ? rejectionStatements[0].argument
      : undefined;
  const acceptedCall = accepted?.type === "ReturnStatement" ? accepted.argument : undefined;
  const acceptedArgument =
    acceptedCall?.type === "CallExpression" ? acceptedCall.arguments[0] : undefined;
  if (
    !isNamedMember(helloAck?.init, "context", "helloAck") ||
    !isNamedMember(proof?.init, "context", "proof") ||
    rejection?.type !== "IfStatement" ||
    rejection.alternate !== null ||
    rejection.consequent?.type !== "BlockStatement" ||
    rejectionStatements?.length !== 1 ||
    rejectionCall?.type !== "CallExpression" ||
    !isIdentifier(rejectionCall.callee, "shadowError") ||
    rejectionCall.arguments.length !== 2 ||
    rejectionCall.arguments[0]?.type !== "StringLiteral" ||
    rejectionCall.arguments[0].value !== "CONTROL_SHADOW_HANDSHAKE_INVALID" ||
    rejectionCall.arguments[1]?.type !== "StringLiteral" ||
    rejectionCall.arguments[1].value !==
      "Executor Ready does not match the Control-signed zero-slot handshake." ||
    acceptedCall?.type !== "CallExpression" ||
    !isNamedMember(acceptedCall.callee, "Object", "freeze") ||
    acceptedCall.arguments.length !== 1 ||
    acceptedArgument?.type !== "ObjectExpression" ||
    acceptedArgument.properties.length !== 1 ||
    acceptedArgument.properties[0]?.type !== "SpreadElement" ||
    !isIdentifier(acceptedArgument.properties[0].argument, "ready")
  ) {
    throw new Error("Control disabled Ready rejection or return order changed.");
  }

  const comparisons = flattenLogicalOr(rejection.test);
  const expectedComparisons = [
    ["ready", "protocolMajor", "helloAck", "protocolMajor"],
    ["ready", "protocolMinor", "helloAck", "protocolMinor"],
    ["ready", "workerNodeId", "helloAck", "workerNodeId"],
    ["ready", "workerInstanceId", "helloAck", "workerInstanceId"],
    ["ready", "executorBootId", "helloAck", "executorBootId"],
    ["ready", "sessionId", "helloAck", "sessionId"],
    ["ready", "controlNonce", "helloAck", "controlNonce"],
    ["ready", "executorNonce", "helloAck", "executorNonce"],
    ["ready", "executorManifestSha256", "helloAck", "executorManifestSha256"],
    ["ready", "executorPolicySha256", "helloAck", "executorPolicySha256"],
    ["ready", "executorPreflightSha256", "helloAck", "executorPreflightSha256"],
    ["ready", "workerNodeId", "proof", "workerNodeId"],
    ["ready", "workerInstanceId", "proof", "workerInstanceId"],
    ["ready", "executorBootId", "proof", "executorBootId"],
    ["ready", "sessionId", "proof", "sessionId"],
  ];
  if (
    comparisons.length !== 19 ||
    !expectedComparisons.every(([leftObject, leftProperty, rightObject, rightProperty], index) =>
      isExactMemberInequality(
        comparisons[index],
        leftObject,
        leftProperty,
        rightObject,
        rightProperty,
      ),
    ) ||
    !isExactRightInequality(
      comparisons[15],
      "ready",
      "isolationMode",
      isStringNamed("split-service-v1"),
    ) ||
    !isExactRightInequality(comparisons[16], "ready", "ready", (node) => isBoolean(node, false)) ||
    !isExactRightInequality(comparisons[17], "ready", "availableSlots", (node) =>
      isNumber(node, 0),
    ) ||
    !isExactRightInequality(
      comparisons[18],
      "ready",
      "reasonCode",
      isIdentifierNamed("executionDisabledReason"),
    )
  ) {
    throw new Error("Control no longer enforces the exact disabled Ready fields.");
  }
  verifyControlReadyCallChain(sourceFile.program);
}

function verifyExecutorProofDispatch(program) {
  const handles = collectSyntax(program, (node) =>
    node.type === "ClassMethod" && !node.computed && isIdentifier(node.key, "handle")
      ? node
      : undefined,
  );
  const handle = handles[0];
  const tryStatement = handle?.body.body[0];
  const branch = tryStatement?.type === "TryStatement" ? tryStatement.block.body[3] : undefined;
  const returned =
    branch?.type === "IfStatement" && branch.consequent?.type === "BlockStatement"
      ? branch.consequent.body[0]
      : undefined;
  const awaited = returned?.type === "ReturnStatement" ? returned.argument : undefined;
  const call = awaited?.type === "AwaitExpression" ? awaited.argument : undefined;
  const calls = collectSyntax(program, (node) =>
    node.type === "CallExpression" && isThisPrivateMember(node.callee, "handleControlProof")
      ? node
      : undefined,
  );
  const references = collectSyntax(program, (node) =>
    isThisPrivateMember(node, "handleControlProof") ? node : undefined,
  );
  if (
    handles.length !== 1 ||
    handle.accessibility !== "public" ||
    !handle.async ||
    handle.generator ||
    handle.body.body.length !== 1 ||
    tryStatement?.type !== "TryStatement" ||
    tryStatement.block.body.length !== 6 ||
    branch?.type !== "IfStatement" ||
    branch.alternate !== null ||
    branch.test?.type !== "BinaryExpression" ||
    branch.test.operator !== "===" ||
    !isThisPrivateMember(branch.test.left, "phase") ||
    branch.test.right?.type !== "StringLiteral" ||
    branch.test.right.value !== "awaiting_control_proof" ||
    branch.consequent?.type !== "BlockStatement" ||
    branch.consequent.body.length !== 1 ||
    call?.type !== "CallExpression" ||
    !isThisPrivateMember(call.callee, "handleControlProof") ||
    call.arguments.length !== 1 ||
    !isIdentifier(call.arguments[0], "message") ||
    calls.length !== 1 ||
    calls[0] !== call ||
    references.length !== 1 ||
    references[0] !== call.callee
  ) {
    throw new Error("Executor public dispatch no longer uniquely reaches Control-proof handling.");
  }
}

function verifyControlReadyCallChain(program) {
  const handles = collectSyntax(program, (node) =>
    node.type === "ClassMethod" && !node.computed && isIdentifier(node.key, "handle")
      ? node
      : undefined,
  );
  const handle = handles[0];
  const tryStatement = handle?.body.body[1];
  const branch = tryStatement?.type === "TryStatement" ? tryStatement.block.body[1] : undefined;
  const branchStatements =
    branch?.type === "IfStatement" && branch.consequent?.type === "BlockStatement"
      ? branch.consequent.body
      : undefined;
  const acceptExpression =
    branchStatements?.[0]?.type === "ExpressionStatement"
      ? branchStatements[0].expression
      : undefined;
  const acceptCall = acceptExpression?.type === "CallExpression" ? acceptExpression : undefined;
  const acceptCalls = collectSyntax(program, (node) =>
    node.type === "CallExpression" && isThisPrivateMember(node.callee, "acceptReady")
      ? node
      : undefined,
  );
  const acceptReferences = collectSyntax(program, (node) =>
    isThisPrivateMember(node, "acceptReady") ? node : undefined,
  );
  const readyMembers = collectSyntax(program, (node) =>
    isNamedMember(node, "LocalMessageType", "Ready") ? node : undefined,
  );

  const acceptMethods = collectSyntax(program, (node) =>
    node.type === "ClassPrivateMethod" && privateName(node.key) === "acceptReady"
      ? node
      : undefined,
  );
  const acceptMethod = acceptMethods[0];
  const statements = acceptMethod?.body.body;
  const signedHandshake = singleDeclaration(statements?.[0], "const", "signedHandshake");
  const signedGuard = statements?.[1];
  const guardTerms = signedGuard?.type === "IfStatement" ? flattenLogicalOr(signedGuard.test) : [];
  const guardStatements =
    signedGuard?.type === "IfStatement" && signedGuard.consequent?.type === "BlockStatement"
      ? signedGuard.consequent.body
      : undefined;
  const readyDeclaration = singleDeclaration(statements?.[2], "const", "ready");
  const validateCall = readyDeclaration?.init;
  const readyAssignment = expressionAssignment(statements?.[3]);
  const phaseAssignment = expressionAssignment(statements?.[4]);
  const resolveExpression =
    statements?.[5]?.type === "ExpressionStatement" ? statements[5].expression : undefined;
  const validateCalls = collectSyntax(program, (node) =>
    node.type === "CallExpression" && isIdentifier(node.callee, "validateControlReady")
      ? node
      : undefined,
  );
  if (
    handles.length !== 1 ||
    handle.accessibility !== "public" ||
    !handle.async ||
    handle.body.body.length !== 2 ||
    tryStatement?.type !== "TryStatement" ||
    tryStatement.block.body.length !== 4 ||
    branch?.type !== "IfStatement" ||
    branch.alternate !== null ||
    branch.test?.type !== "BinaryExpression" ||
    branch.test.operator !== "===" ||
    !isNamedMember(branch.test.left, "message", "messageType") ||
    !isNamedMember(branch.test.right, "LocalMessageType", "Ready") ||
    branchStatements?.length !== 2 ||
    acceptCall?.type !== "CallExpression" ||
    !isThisPrivateMember(acceptCall.callee, "acceptReady") ||
    acceptCall.arguments.length !== 1 ||
    !isNamedMember(unwrapTypeAssertions(acceptCall.arguments[0]), "message", "payload") ||
    branchStatements[1]?.type !== "ReturnStatement" ||
    branchStatements[1].argument !== null ||
    acceptCalls.length !== 1 ||
    acceptCalls[0] !== acceptCall ||
    acceptReferences.length !== 1 ||
    acceptReferences[0] !== acceptCall.callee ||
    readyMembers.length !== 1 ||
    readyMembers[0] !== branch.test.right ||
    acceptMethods.length !== 1 ||
    acceptMethod.async ||
    acceptMethod.generator ||
    acceptMethod.params.length !== 1 ||
    !isIdentifier(acceptMethod.params[0], "readyValue") ||
    (acceptMethod.body.directives?.length ?? 0) !== 0 ||
    statements.length !== 6 ||
    !isThisPrivateMember(signedHandshake?.init, "signedHandshake") ||
    signedGuard?.type !== "IfStatement" ||
    signedGuard.alternate !== null ||
    guardTerms.length !== 2 ||
    guardTerms[0]?.type !== "BinaryExpression" ||
    guardTerms[0].operator !== "!==" ||
    !isThisPrivateMember(guardTerms[0].left, "phase") ||
    guardTerms[0].right?.type !== "StringLiteral" ||
    guardTerms[0].right.value !== "proof-sent" ||
    guardTerms[1]?.type !== "BinaryExpression" ||
    guardTerms[1].operator !== "===" ||
    !isIdentifier(guardTerms[1].left, "signedHandshake") ||
    !isIdentifier(guardTerms[1].right, "undefined") ||
    guardStatements?.length !== 1 ||
    !isExactShadowErrorThrow(
      guardStatements[0],
      "CONTROL_SHADOW_HANDSHAKE_INVALID",
      "Control received Ready before completing its signed handshake.",
    ) ||
    validateCall?.type !== "CallExpression" ||
    !isIdentifier(validateCall.callee, "validateControlReady") ||
    validateCall.arguments.length !== 2 ||
    !isIdentifier(validateCall.arguments[0], "readyValue") ||
    !isIdentifier(validateCall.arguments[1], "signedHandshake") ||
    validateCalls.length !== 1 ||
    validateCalls[0] !== validateCall ||
    readyAssignment?.operator !== "=" ||
    !isThisPrivateMember(readyAssignment.left, "readyMessage") ||
    !isIdentifier(readyAssignment.right, "ready") ||
    phaseAssignment?.operator !== "=" ||
    !isThisPrivateMember(phaseAssignment.left, "phase") ||
    phaseAssignment.right?.type !== "StringLiteral" ||
    phaseAssignment.right.value !== "ready" ||
    resolveExpression?.type !== "CallExpression" ||
    !isDirectMember(resolveExpression.callee, "resolve") ||
    !isThisPrivateMember(resolveExpression.callee.object, "ready") ||
    resolveExpression.arguments.length !== 1 ||
    !isIdentifier(resolveExpression.arguments[0], "ready")
  ) {
    throw new Error("Control public dispatch no longer commits the validated disabled Ready.");
  }
}

function isExactMessageTypeGuard(statement, messageType) {
  const test = statement?.type === "IfStatement" ? statement.test : undefined;
  const statements =
    statement?.type === "IfStatement" && statement.consequent?.type === "BlockStatement"
      ? statement.consequent.body
      : undefined;
  const thrown = statements?.[0]?.type === "ThrowStatement" ? statements[0].argument : undefined;
  return (
    statement?.type === "IfStatement" &&
    statement.alternate === null &&
    test?.type === "BinaryExpression" &&
    test.operator === "!==" &&
    isNamedMember(test.left, "message", "messageType") &&
    isNamedMember(test.right, "LocalMessageType", messageType) &&
    statements?.length === 1 &&
    thrown?.type === "CallExpression" &&
    isIdentifier(thrown.callee, "runtimeError") &&
    thrown.arguments.length === 2 &&
    thrown.arguments[0]?.type === "StringLiteral" &&
    thrown.arguments[0].value === "HANDSHAKE_ORDER_INVALID" &&
    thrown.arguments[1]?.type === "StringLiteral" &&
    thrown.arguments[1].value === "Executor shadow runtime requires ControlProof after HelloAck."
  );
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

function expressionAssignment(statement) {
  const expression = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  return expression?.type === "AssignmentExpression" ? expression : undefined;
}

function unwrapTypeAssertions(expression) {
  let current = expression;
  while (
    current?.type === "TSAsExpression" ||
    current?.type === "TSTypeAssertion" ||
    current?.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current;
}

function isExactShadowErrorThrow(statement, code, message) {
  const call = statement?.type === "ThrowStatement" ? statement.argument : undefined;
  return (
    call?.type === "CallExpression" &&
    isIdentifier(call.callee, "shadowError") &&
    call.arguments.length === 2 &&
    call.arguments[0]?.type === "StringLiteral" &&
    call.arguments[0].value === code &&
    call.arguments[1]?.type === "StringLiteral" &&
    call.arguments[1].value === message
  );
}

function isExactCloseGuard(statement) {
  const statements =
    statement?.type === "IfStatement" && statement.consequent?.type === "BlockStatement"
      ? statement.consequent.body
      : undefined;
  const thrown = statements?.[0]?.type === "ThrowStatement" ? statements[0].argument : undefined;
  return (
    statement?.type === "IfStatement" &&
    statement.alternate === null &&
    isThisPrivateMember(statement.test, "closeRequested") &&
    statements?.length === 1 &&
    thrown?.type === "CallExpression" &&
    isIdentifier(thrown.callee, "runtimeError") &&
    thrown.arguments.length === 2 &&
    thrown.arguments[0]?.type === "StringLiteral" &&
    thrown.arguments[0].value === "RUNTIME_CLOSING" &&
    thrown.arguments[1]?.type === "StringLiteral" &&
    thrown.arguments[1].value === "Executor shadow runtime closed before Ready publication."
  );
}

function isExactConstCall(statement, binding, callee, argumentPredicates) {
  const declaration = singleDeclaration(statement, "const", binding);
  const call = declaration?.init;
  return (
    call?.type === "CallExpression" &&
    isIdentifier(call.callee, callee) &&
    call.arguments.length === argumentPredicates.length &&
    argumentPredicates.every((predicate, index) => predicate(call.arguments[index]))
  );
}

function singleDeclaration(statement, kind, binding) {
  if (
    statement?.type !== "VariableDeclaration" ||
    statement.kind !== kind ||
    statement.declarations.length !== 1 ||
    !isIdentifier(statement.declarations[0]?.id, binding)
  ) {
    return undefined;
  }
  return statement.declarations[0];
}

function bindingWriteCount(records, binding) {
  return records.filter(({ node }) => {
    if (node.type === "FunctionDeclaration") return isIdentifier(node.id, binding);
    if (node.type === "VariableDeclarator") return patternBindsName(node.id, binding);
    if (node.type === "AssignmentExpression") return patternBindsName(node.left, binding);
    if (node.type === "UpdateExpression") return isIdentifier(node.argument, binding);
    if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
      return patternBindsName(node.left, binding);
    }
    return false;
  }).length;
}

function patternBindsName(pattern, binding) {
  if (isIdentifier(pattern, binding)) return true;
  if (pattern?.type === "RestElement") return patternBindsName(pattern.argument, binding);
  if (pattern?.type === "AssignmentPattern") return patternBindsName(pattern.left, binding);
  if (pattern?.type === "ArrayPattern") {
    return pattern.elements.some((element) => patternBindsName(element, binding));
  }
  if (pattern?.type === "ObjectPattern") {
    return pattern.properties.some((property) =>
      property.type === "RestElement"
        ? patternBindsName(property.argument, binding)
        : patternBindsName(property.value, binding),
    );
  }
  return false;
}

function flattenLogicalOr(expression) {
  if (expression?.type !== "LogicalExpression" || expression.operator !== "||") {
    return [expression];
  }
  return [...flattenLogicalOr(expression.left), ...flattenLogicalOr(expression.right)];
}

function isExactMemberInequality(expression, leftObject, leftProperty, rightObject, rightProperty) {
  return (
    expression?.type === "BinaryExpression" &&
    expression.operator === "!==" &&
    isNamedMember(expression.left, leftObject, leftProperty) &&
    isNamedMember(expression.right, rightObject, rightProperty)
  );
}

function isExactRightInequality(expression, leftObject, leftProperty, rightPredicate) {
  return (
    expression?.type === "BinaryExpression" &&
    expression.operator === "!==" &&
    isNamedMember(expression.left, leftObject, leftProperty) &&
    rightPredicate(expression.right)
  );
}

function isIdentifierNamed(name) {
  return (node) => isIdentifier(node, name);
}

function isStringNamed(value) {
  return (node) => node?.type === "StringLiteral" && node.value === value;
}

function isThisPrivateMemberNamed(name) {
  return (node) => isThisPrivateMember(node, name);
}

function isThisPrivatePropertyChain(node, privateRoot, ...properties) {
  let current = node;
  for (let index = properties.length - 1; index >= 0; index -= 1) {
    if (!isDirectMember(current, properties[index])) return false;
    current = current.object;
  }
  return isThisPrivateMember(current, privateRoot);
}

function productionSourceReader(overrides) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("Zero-execution source overrides must be an object.");
  }
  for (const [path, source] of Object.entries(overrides)) {
    if (!canonicalRepositorySource(path) || typeof source !== "string") {
      throw new TypeError("Zero-execution source override is invalid.");
    }
  }
  return (path) => {
    if (!canonicalRepositorySource(path)) {
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

function isBoolean(node, value) {
  return node?.type === "BooleanLiteral" && node.value === value;
}

function isNumber(node, value) {
  return node?.type === "NumericLiteral" && node.value === value;
}
