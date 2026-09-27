import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API as TypeScriptApi } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";

const serverBindingAuthoritySubpath = "@agentic-review/contracts/server-binding-authority-v1";
const serverBindingSignerHostFixtureBasename = "server-binding-signer-host-fixture-v1.mjs";
const serverBindingAuthorityConsumerAllowlist: readonly string[] = [];
const evidenceVerifierClientSuffix = "/apps/server/src/database/evidence-verification-client.ts";
const evidenceVerifierWorkerSuffix = "/apps/server/src/database/evidence-verification-worker.ts";
const windowsSupervisorSuffix = "/deploy/operations/windows-supervisor.mjs";
const reviewedSupervisorForkCall =
  'fork(entryPath,[],{cwd:config.dataDirectory,env:childEnvironment,execPath:config.nodeExecutable,execArgv:["--enable-source-maps","--import",pathToFileURL(bridgePath).href],stdio:["ignore","pipe","pipe","ipc"],windowsHide:true,})';
const reviewedSupervisorEntries =
  'Object.freeze({server:"apps/server/dist/main.js",worker:"apps/worker/dist/worker.mjs",})';
const reviewedEvidenceWorkerCall =
  'newWorker(newURL("./evidence-verification-worker.js",import.meta.url),{workerData:this.#root,resourceLimits:{maxOldGenerationSizeMb:128},})';
const reviewedEvidenceRootInitialization =
  "structuredClone(checkVerificationSchema(EvidenceVerificationRootSchema,options.storageRoot))";
const sensitiveServerBindingModuleConsumers = new Map<string, readonly string[]>([
  ["server-binding-state-v1", []],
  ["server-binding-persistence-v1", []],
  ["server-binding-coordinator-v1", []],
  ["server-binding-signer-host-client-v1", []],
  ["server-binding-signer-host-provider-v1", []],
  ["server-binding-signer-host-profile-v1", []],
  ["server-binding-signer-host-protocol-v1", []],
  ["server-binding-signer-v1", []],
  ["server-binding-signer-provider-v1", []],
  ["server-binding-trust-profile-v1", []],
]);
const retiredFileGroups = [
  ["apps/server/src/database", /^database-initialization(?:\.|$)/u],
  ["apps/server/dist/database", /^database-initialization(?:\.|$)/u],
  ["apps/server/src/database", /^migration-backup(?:\.|$)/u],
  ["apps/server/dist/database", /^migration-backup(?:\.|$)/u],
  ["apps/server/src/database", /^server-binding-persistence-v1(?:\.|$)/u],
  ["apps/server/src/enrollment", /^server-binding-/u],
  ["apps/server/testdata", /^server-binding-/u],
  ["native/service-host/internal/nodeenrollment", /\.go$/u],
  ["native/service-host/internal/serverbindingauthorityv1", /\.go$/u],
  ["packages/contracts/src", /^server-binding-authority-v1(?:\.|$)/u],
  ["packages/contracts/dist", /^server-binding-authority-v1(?:\.|$)/u],
  ["testdata", /^server-binding-authority-v1(?:\.|$)/u],
] as const;
const retiredDatabaseOperations = [
  "claimServerBindingAuthorizationV1",
  "commitServerBindingReceiptV1",
  "confirmServerBindingRecordV1",
  "createServerBindingAuthorizationV1",
  "initializeServerBindingIssuerV1",
  "readServerBindingActiveSnapshotV1",
  "readServerBindingRecoveryReceiptV1",
  "recheckServerBindingActiveSnapshotV1",
  "revokeServerBindingV1",
] as const;
const retiredDatabaseTables = [
  "server_binding_receipt_issuer",
  "server_binding_authorizations",
  "server_bindings",
  "server_binding_revocations",
] as const;
const retiredDatabaseBootstrapTokens = [
  ".agentic-review-allow-legacy-adoption",
  "agentic-review-database-initialization-v1",
  "adoptLegacyDatabase",
  "cleanupIncompleteMigrationBackups",
  "consumeLegacyAdoptionAuthorization",
  "createMigrationBackup",
] as const;
// These entry points and helpers are test-only programs, outside production compilation.
// Keep exact files here: adjacent deploy scripts must retain the production loader checks.
const testOnlyAcceptanceSourceFiles = new Set([
  "deploy/investigation-acceptance/prepare-public-issue.mjs",
  "deploy/investigation-acceptance/run-real-cli.mjs",
  "deploy/investigation-acceptance/run-publication.mjs",
  "deploy/investigation-acceptance/resume-real-cli.mjs",
  "deploy/investigation-acceptance/run.mjs",
  "deploy/investigation-acceptance/source-manifest.mjs",
  "deploy/worker/cli-workflow-acceptance/cleanup-verification.ts",
  "deploy/worker/cli-workflow-acceptance/git-fixture.ts",
  "deploy/worker/cli-workflow-acceptance/prepare-server.mjs",
  "deploy/worker/cli-workflow-acceptance/quality-corpus.ts",
  "deploy/worker/cli-workflow-acceptance/run.mjs",
  "deploy/worker/cli-workflow-acceptance/server.ts",
  "deploy/worker/cli-workflow-acceptance/worker.ts",
  "deploy/worker/publication-acceptance/plan.mjs",
  "deploy/worker/publication-acceptance/publisher.mjs",
  "deploy/worker/publication-acceptance/run.mjs",
  "deploy/worker/publication-acceptance/verify.mjs",
  "deploy/worker/issue-summary-acceptance/case.ts",
  "deploy/worker/issue-summary-acceptance/prepare-server.mjs",
  "deploy/worker/issue-summary-acceptance/probe/probe.mjs",
  "deploy/worker/issue-summary-acceptance/run.mjs",
  "deploy/worker/issue-summary-acceptance/server.ts",
  "deploy/worker/issue-summary-acceptance/worker.ts",
]);
// These tools only author offline design artifacts from installed dependencies.
// Keep them separate from acceptance programs and do not exempt their directory.
const designBuildSourceFiles = new Set([
  "docs/design/dashboard-review-2026-09-25/bundle-controls.mjs",
  "docs/design/dashboard-review-2026-09-25/generate-material-assets.mjs",
]);

describe("production source boundaries", () => {
  it("prunes the protected Worker directory before inspecting or traversing it", () => {
    const root = resolve(tmpdir(), "virtual-source-boundary-no-filesystem-access");
    const reads: string[] = [];
    const directory = (name: string) => ({ name, isDirectory: () => true, isFile: () => false });
    const paths = new Map<string, SourceDirectoryEntry[]>([
      ["", [directory("apps")]],
      ["apps", [directory("worker")]],
      [
        "apps/worker",
        [
          {
            name: ".tmp-ui-driver-V7AOfu",
            isDirectory: () => {
              throw new Error("Protected metadata must not be inspected.");
            },
            isFile: () => {
              throw new Error("Protected metadata must not be inspected.");
            },
          },
          directory("src"),
        ],
      ],
      ["apps/worker/src", [{ name: "main.ts", isDirectory: () => false, isFile: () => true }]],
    ]);
    const files = productionSourceFiles(root, (path) => {
      const key = relative(root, path).replaceAll("\\", "/");
      reads.push(key);
      const entries = paths.get(key);
      if (entries === undefined) throw new Error("Unexpected virtual directory traversal.");
      return entries;
    });
    expect(files).toEqual([join(root, "apps/worker/src/main.ts")]);
    expect(reads).toEqual(["", "apps", "apps/worker", "apps/worker/src"]);
  });
  it("excludes ignored artifacts while retaining actual source and build scripts", () => {
    const temporaryRoot = resolve(tmpdir());
    const fixturePrefix = "agentic-review-source-boundary-";
    const fixtureRoot = mkdtempSync(join(temporaryRoot, fixturePrefix));
    if (
      dirname(fixtureRoot) !== temporaryRoot ||
      !basename(fixtureRoot).startsWith(fixturePrefix)
    ) {
      throw new Error("Refusing to use a source-boundary fixture outside its temporary root.");
    }
    const includedPaths = [
      "apps/server/src/main.ts",
      "apps/server/src/artifacts/evidence-store.ts",
      "apps/server/src/artifacts/nested/artifacts/evidence-reader.ts",
      "apps/worker/scripts/build-worker-bundles.mjs",
      "packages/contracts/scripts/clean-build-output.mjs",
      "packages/contracts/src/index.ts",
      "deploy/verify.cjs",
      "deploy/worker/cli-workflow-acceptance/production-loader.mjs",
      "deploy/worker/publication-acceptance/unreviewed.mjs",
      "deploy/worker/issue-summary-acceptance/probe/production.mjs",
      "deploy/worker/publication-acceptance-old/run.mjs",
      "apps/worker/src/deploy/worker/cli-workflow-acceptance/run.mjs",
      "deploy/investigation-acceptance/unreviewed.mjs",
      "deploy/investigation-acceptance/nested/run.mjs",
      "deploy/investigation-acceptance-old/run.mjs",
      "apps/worker/src/deploy/investigation-acceptance/run.mjs",
      "deploy/operations/windows-supervisor.mjs",
      "deploy/operations/windows-shutdown-bridge.mjs",
      "deploy/operations/production-loader.mjs",
      "docs/design/dashboard-review-2026-09-25/production-loader.mjs",
      "docs/design/dashboard-review-2026-09-25/nested/bundle-controls.mjs",
      "docs/design/dashboard-review-2026-09-25-old/generate-material-assets.mjs",
      "apps/dashboard/src/docs/design/dashboard-review-2026-09-25/bundle-controls.mjs",
      "config/artifact-policy.ts",
    ];
    const excludedPaths = [
      "artifacts/local-e2e/config-isolation-probe.mjs",
      "artifacts/local-e2e/apps/server/src/artifacts/copied-evidence-store.ts",
      "packages/fixture/artifacts/generated-client.js",
      "apps/server/dist/main.js",
      "apps/server/node_modules/dependency/index.js",
      "apps/server/src/route.test.ts",
      "apps/server/src/fixture.testing.ts",
      "apps/dashboard/src/page.spec.tsx",
      "deploy/worker/cli-workflow-acceptance/cleanup-verification.test.ts",
      ...testOnlyAcceptanceSourceFiles,
      ...designBuildSourceFiles,
    ];
    try {
      for (const path of [...includedPaths, ...excludedPaths]) {
        const fileName = join(fixtureRoot, path);
        mkdirSync(dirname(fileName), { recursive: true });
        writeFileSync(fileName, 'eval("boundary fixture");', "utf8");
      }
      const sources = productionSourceFiles(fixtureRoot);
      expect(
        sources.map((fileName) => relative(fixtureRoot, fileName).replaceAll("\\", "/")),
      ).toEqual(includedPaths.toSorted());
      const inspections = inspectProductionModules(
        sources.map((fileName) => ({ fileName, source: readFileSync(fileName, "utf8") })),
      );
      for (const fileName of sources) {
        expect(inspections.get(fileName), fileName).toContain("eval runtime loader");
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects production imports and re-exports of exact test-only acceptance modules", () => {
    const root = resolve("test-fixtures");
    const fileName = join(root, "apps/worker/src/main.ts");
    const sources = [
      ...[...testOnlyAcceptanceSourceFiles].map((path) => {
        const specifier = relative(dirname(fileName), join(root, path)).replaceAll("\\", "/");
        return `import ${JSON.stringify(specifier)};`;
      }),
      'export * from "../../../deploy/worker/cli-workflow-acceptance/worker.js";',
      'type Fixture = import("../../../deploy/worker/cli-workflow-acceptance/quality-corpus.js").Fixture;',
      'export type { Fixture } from "../../../deploy/worker/cli-workflow-acceptance/quality-corpus";',
      'import "../../../deploy/worker/publication-acceptance/../publication-acceptance/run.mjs?entry=1";',
      'import "../../../deploy/worker/%70ublication-acceptance/run.mjs";',
      `import ${JSON.stringify(pathToFileURL(join(root, "deploy/worker/publication-acceptance/run.mjs")).href)};`,
      `import ${JSON.stringify(`${root.replaceAll("\\", "/")}/deploy/worker/publication-acceptance/../publication-acceptance/run.mjs`)};`,
      `import ${JSON.stringify(pathToFileURL(join(root, "deploy/worker/publication-acceptance/run.mjs")).href.replace("/publication-acceptance/run.mjs", "/publication-acceptance/../publication-acceptance/run.mjs"))};`,
    ].map((source, index) => ({
      fileName: join(dirname(fileName), `consumer-${index}.ts`),
      source,
    }));
    const inspections = inspectProductionModules(sources);
    for (const source of sources) {
      expect(inspections.get(source.fileName), source.source).toContain(
        "production import of a test-only acceptance module",
      );
    }
    const adjacentProduction = {
      fileName,
      source:
        'import "../../../deploy/worker/publication-acceptance/unreviewed.mjs"; import "../../../deploy/verify.cjs";',
    };
    expect(inspectProductionModules([adjacentProduction]).get(fileName)).toEqual([]);
    const dashboardSources = [
      'import "@/../../../deploy/worker/cli-workflow-acceptance/../cli-workflow-acceptance/server";',
      'export * from "@@/../../../../deploy/worker/issue-summary-acceptance/server.js";',
    ].map((source, index) => ({
      fileName: join(root, `apps/dashboard/src/consumer-${index}.tsx`),
      source,
    }));
    const dashboardInspections = inspectProductionModules(dashboardSources);
    for (const source of dashboardSources) {
      expect(dashboardInspections.get(source.fileName), source.source).toContain(
        "production import of a test-only acceptance module",
      );
    }
  });

  it("rejects production imports and re-exports of exact offline design build tools", () => {
    const root = resolve("design-build-boundary-fixtures");
    const sourceDirectory = join(root, "apps/dashboard/src");
    const sources = [
      ...[...designBuildSourceFiles].flatMap((path) => {
        const specifier = relative(sourceDirectory, join(root, path)).replaceAll("\\", "/");
        return [
          `import ${JSON.stringify(specifier)};`,
          `export * from ${JSON.stringify(specifier)};`,
          `type DesignTool = import(${JSON.stringify(specifier)}).DesignTool;`,
          `import ${JSON.stringify(pathToFileURL(join(root, path)).href)};`,
        ];
      }),
      'import "../../../docs/design/dashboard-review-2026-09-25/../dashboard-review-2026-09-25/bundle-controls.mjs?build=1";',
      'export * from "../../../docs/design/dashboard-review-2026-09-25/%67enerate-material-assets.mjs";',
      'import "@/../../../docs/design/dashboard-review-2026-09-25/bundle-controls";',
      'export * from "@@/../../../../docs/design/dashboard-review-2026-09-25/generate-material-assets.mjs";',
    ].map((source, index) => ({
      fileName: join(sourceDirectory, `consumer-${index}.tsx`),
      source,
    }));
    const inspections = inspectProductionModules(sources);
    for (const source of sources) {
      expect(inspections.get(source.fileName), source.source).toContain(
        "production import of an offline design build tool",
      );
    }
    const adjacentProduction = {
      fileName: join(sourceDirectory, "consumer.tsx"),
      source:
        'import "../../../docs/design/dashboard-review-2026-09-25/production-loader.mjs"; import "../../../docs/design/dashboard-review-2026-09-25/nested/bundle-controls.mjs";',
    };
    expect(inspectProductionModules([adjacentProduction]).get(adjacentProduction.fileName)).toEqual(
      [],
    );
  });

  it("retains the exact offline and loopback boundaries of opt-in investigation acceptance", () => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const expectedImports = new Map<string, readonly string[]>([
      [
        "prepare-public-issue.mjs",
        ['import(pathToFileURL(join(repoRoot,"packages","domain","dist","index.js")).href)'],
      ],
      [
        "run-real-cli.mjs",
        [
          'import(pathToFileURL(join(repo,"packages","contracts","dist","index.js")).href)',
          'import(pathToFileURL(join(repo,"packages","domain","dist","index.js")).href)',
          'import(pathToFileURL(join(repo,"apps","server","dist","investigation","store.js")).href)',
        ],
      ],
      [
        "run.mjs",
        [
          'import(pathToFileURL(join(repo,"packages","contracts","dist","index.js")).href)',
          'import(pathToFileURL(join(repo,"packages","domain","dist","index.js")).href)',
          'import(pathToFileURL(join(repo,"packages","contracts","dist","investigation-preview.js")).href)',
          'import(pathToFileURL(join(repo,"apps","server","dist","investigation","store.js")).href)',
        ],
      ],
      ["source-manifest.mjs", []],
      [
        "resume-real-cli.mjs",
        [
          'import(pathToFileURL(join(repo,"packages","contracts","dist","index.js")).href)',
          'import(pathToFileURL(join(repo,"packages","domain","dist","index.js")).href)',
        ],
      ],
    ]);
    const sources = [...expectedImports.keys()].map((name) => {
      const repositoryPath = `deploy/investigation-acceptance/${name}`;
      expect(testOnlyAcceptanceSourceFiles.has(repositoryPath)).toBe(true);
      const fileName = join(repositoryRoot, repositoryPath);
      return { fileName, source: readFileSync(fileName, "utf8") };
    });
    withVirtualSourceFiles(sources, (parsed) => {
      for (const source of sources) {
        const sourceFile = parsed.get(source.fileName);
        if (sourceFile === undefined) throw new Error("The reviewed acceptance source must parse.");
        const name = basename(source.fileName);
        const runner =
          name === "run.mjs" || name === "run-real-cli.mjs" || name === "resume-real-cli.mjs";
        const dynamicImports: string[] = [];
        const childImports: string[] = [];
        const moduleImports: string[] = [];
        const requireFactories: string[] = [];
        const requiredModules: string[] = [];
        const forks: string[] = [];
        const origins: string[] = [];
        const properties = new Map<string, string[]>();
        const text = (node: ts.Node): string =>
          compactNodeText(node, sourceFile).replace(/,(?=[)\]}])/gu, "");
        const visit = (node: ts.Node): void => {
          if (ts.isImportDeclaration(node) && ts.isStringLiteralLikeNode(node.moduleSpecifier)) {
            if (node.moduleSpecifier.text === "node:child_process")
              childImports.push(importedBindingSignature(node));
            if (node.moduleSpecifier.text === "node:module")
              moduleImports.push(importedBindingSignature(node));
            if (!runner)
              expect(["node:http", "node:https", "node:net"]).not.toContain(
                node.moduleSpecifier.text,
              );
          }
          if (ts.isCallExpression(node)) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
              dynamicImports.push(text(node));
            if (calledExpressionName(node.expression) === "fork") forks.push(text(node));
            if (calledExpressionName(node.expression) === "createrequire")
              requireFactories.push(text(node));
            if (calledExpressionName(node.expression) === "requireserver")
              requiredModules.push(text(node));
            if (!runner) expect(calledExpressionName(node.expression)).not.toBe("fetch");
          }
          if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left) &&
            node.left.text === "origin"
          )
            origins.push(text(node.right));
          if (ts.isPropertyAssignment(node)) {
            const key =
              ts.isIdentifier(node.name) || ts.isStringLiteralLikeNode(node.name)
                ? node.name.text
                : "";
            properties.set(key, [...(properties.get(key) ?? []), text(node.initializer)]);
          }
          node.forEachChild((child) => {
            visit(child);
            return undefined;
          });
        };
        visit(sourceFile);
        expect(dynamicImports.toSorted(), name).toEqual(
          [...(expectedImports.get(name) ?? [])].sort(),
        );
        expect(childImports, name).toEqual(
          runner
            ? ["execFile:execFile:value,fork:fork:value"]
            : name === "source-manifest.mjs"
              ? ["execFile:execFile:value"]
              : [],
        );
        expect(moduleImports, name).toEqual(runner ? ["createRequire:createRequire:value"] : []);
        expect(requireFactories, name).toEqual(
          runner ? ['createRequire(join(repo,"apps","server","package.json"))'] : [],
        );
        expect(requiredModules.toSorted(), name).toEqual(
          runner
            ? ['requireServer("@sinclair/typebox")', 'requireServer("@sinclair/typebox/value")']
            : [],
        );
        if (runner) {
          expect(forks, name).toEqual([
            'fork(entry,[],{cwd:repo,env:environment,windowsHide:true,stdio:["ignore","pipe","pipe","ipc"],execArgv:["--enable-source-maps","--import",pathToFileURL(join(here,"ipc-signals.mjs")).href]})',
          ]);
          expect(origins, name).toEqual(["`http://127.0.0.1:${port}`"]);
          expect(properties.get("INVESTIGATION_ENABLE_EXTERNAL_WRITES"), name).toEqual(['"false"']);
          expect(properties.get("INVESTIGATION_WORKER_ALLOWED_REPOSITORIES_JSON"), name).toEqual([
            '"[]"',
          ]);
          const executionModes = properties.get("executionMode") ?? [];
          expect(executionModes.length, name).toBeGreaterThan(0);
          expect(
            executionModes.every((mode) => mode === '"snapshot_only"'),
            name,
          ).toBe(true);
          for (const [variable, expected] of [
            ["serverEntry", 'join(repo,"apps","server","dist","main.js")'],
            ["workerEntry", 'join(repo,"apps","worker","dist","worker.mjs")'],
          ]) {
            const initializer = findUniqueVariableInitializer(sourceFile, variable!);
            expect(
              initializer === undefined ? undefined : text(initializer),
              `${name}: ${variable}`,
            ).toBe(expected);
          }
          const compact = text(sourceFile);
          if (name === "run-real-cli.mjs") {
            const workerPathInitializer = findUniqueVariableInitializer(sourceFile, "workerPath");
            expect(
              workerPathInitializer === undefined ? undefined : text(workerPathInitializer),
            ).toBe('args.get("--worker-path")');
            expect(properties.get("INVESTIGATION_WORKER_PATH")).toEqual(["workerPath"]);
            expect(compact).toContain(
              "workerPath===undefined?{}:{INVESTIGATION_WORKER_PATH:workerPath}",
            );
            expect(compact).toContain(String.raw`!/[\0\r\n]/u.test(workerPath)`);
          }
          expect(compact, name).toContain(
            name === "resume-real-cli.mjs"
              ? String.raw`!/\/action-intents|\/confirm|\/import-work-item|\/cancel/u.test(path)`
              : String.raw`!/\/action-intents|\/confirm|\/import-work-item/u.test(path)`,
          );
          if (name === "resume-real-cli.mjs") {
            expect(compact).toContain('args.get("--previous-processes-stopped"),"true"');
            expect(compact).toContain("newDatabaseSync(database,{readOnly:true})");
            expect(compact).toContain("newDatabaseSync(authDatabase,{readOnly:true})");
            expect(properties.get("INVESTIGATION_DATABASE_PATH")).toEqual(["database"]);
            expect(properties.get("INVESTIGATION_AUTH_DATABASE_PATH")).toEqual(["authDatabase"]);
            expect(compact).toContain('assert(!(method==="POST"&&path==="/api/tasks")');
            expect(compact).toContain("assert.equal(path,`/api/tasks/${taskId}/resume`)");
            expect(compact).toContain(
              "assert.deepEqual(queued.checkpoint.analysis,before.checkpoint.analysis)",
            );
            expect(compact).toContain(
              "assert.deepEqual(queued.checkpoint.runtime,before.checkpoint.runtime)",
            );
            expect(compact).toContain("assertReportHistory(original.task,original.reports)");
            expect(compact).toContain("assertReportHistory(after.task,after.reports)");
            expect(compact).toContain(
              'awaitreadOptionalOrdinaryFile(join(previousRun,"report.json"))',
            );
            expect(compact).not.toContain('awaitreadFile(join(previousRun,"report.json"))');
            expect(compact).toContain(
              'constdeliveryOnly=original.checkpoint.stopReason==="complete"',
            );
            expect(compact).toContain(
              "assert.equal(final.checkpoint.round,before.checkpoint.round)",
            );
            expect(compact).toContain(
              "assert.deepEqual(final.checkpoint.analysis,before.checkpoint.analysis)",
            );
            expect(compact).toContain(
              "assert.deepEqual(final.checkpoint.runtime,before.checkpoint.runtime)",
            );
            expect(compact).toContain(
              "assert.equal(final.checkpoint.consumed.tokens,before.checkpoint.consumed.tokens)",
            );
            expect(compact).toContain("assert.equal(receipt.realModel,false)");
            expect(source.source).not.toContain("INVESTIGATION_BOOTSTRAP_ADMIN_");
          }
          expect(compact, name).not.toContain("...process.env");
          expect(source.source, name).not.toMatch(/INVESTIGATION_GITHUB_(?:TOKEN|USER_ID)/u);
        } else {
          expect(forks, name).toEqual([]);
        }
      }
    });
  });

  it("keeps native publication opt-in with GET-only direct upstream access and a single confirmation reservation", () => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const fileName = join(repositoryRoot, "deploy/investigation-acceptance/run-publication.mjs");
    const source = readFileSync(fileName, "utf8");
    withVirtualSourceFiles([{ fileName, source }], (parsed) => {
      const sourceFile = parsed.get(fileName);
      if (sourceFile === undefined) throw new Error("The publication companion must parse.");
      const text = (node: ts.Node): string =>
        compactNodeText(node, sourceFile).replace(/,(?=[)\]}])/gu, "");
      const imports: string[] = [];
      const childImports: string[] = [];
      const forks: string[] = [];
      const origins: string[] = [];
      const gateValues: string[] = [];
      const fetchTargets: string[] = [];
      let consumptionReservations = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteralLikeNode(node.moduleSpecifier)) {
          if (node.moduleSpecifier.text === "node:child_process")
            childImports.push(importedBindingSignature(node));
          expect(node.moduleSpecifier.text).not.toBe("node:module");
        }
        if (ts.isCallExpression(node)) {
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword) imports.push(text(node));
          if (calledExpressionName(node.expression) === "fork") forks.push(text(node));
          if (calledExpressionName(node.expression) === "fetch") {
            const target = node.arguments[0];
            if (target === undefined)
              throw new Error("A publication fetch needs an explicit destination.");
            fetchTargets.push(text(target));
            if (text(target) === "`https://api.github.com${path}`") {
              expect(findAncestor(node, ts.isFunctionDeclaration)?.name?.text).toBe("githubGet");
              const options = node.arguments[1];
              if (options === undefined || !ts.isObjectLiteralExpression(options))
                throw new Error("The direct GitHub request must use reviewed literal options.");
              const method = options.properties.find(
                (property) => ts.isPropertyAssignment(property) && text(property.name) === "method",
              );
              expect(
                method !== undefined && ts.isPropertyAssignment(method)
                  ? text(method.initializer)
                  : undefined,
              ).toBe('"GET"');
            }
          }
          if (
            calledExpressionName(node.expression) === "writefile" &&
            node.arguments[0] !== undefined &&
            text(node.arguments[0]) === "consumptionPath"
          ) {
            consumptionReservations += 1;
            const options = node.arguments[2];
            expect(options === undefined ? undefined : text(options)).toBe(
              '{flag:"wx",mode:0o600}',
            );
          }
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left) &&
          node.left.text === "origin"
        )
          origins.push(text(node.right));
        if (
          ts.isPropertyAssignment(node) &&
          text(node.name) === "INVESTIGATION_ENABLE_EXTERNAL_WRITES"
        )
          gateValues.push(text(node.initializer));
        node.forEachChild((child) => {
          visit(child);
          return undefined;
        });
      };
      visit(sourceFile);
      expect(imports.toSorted()).toEqual([
        'import(pathToFileURL(join(repo,"apps","server","dist","investigation","store.js")).href)',
        'import(pathToFileURL(join(repo,"packages","domain","dist","index.js")).href)',
      ]);
      expect(childImports).toEqual(["fork:fork:value"]);
      expect(forks).toEqual([
        'fork(entry,[],{cwd:repo,env:environment,windowsHide:true,stdio:["ignore","pipe","pipe","ipc"],execArgv:["--enable-source-maps","--import",pathToFileURL(join(here,"ipc-signals.mjs")).href]})',
      ]);
      expect(origins).toEqual(["`http://127.0.0.1:${port}`"]);
      expect(gateValues).toEqual(['approvalValidated?"true":"false"']);
      expect(fetchTargets.toSorted()).toEqual([
        "`${origin}${path}`",
        "`${origin}/api/auth/session`",
        "`https://api.github.com${path}`",
      ]);
      expect(consumptionReservations).toBe(1);
      for (const [variable, expected] of [
        ["executeRequested", 'args.get("--execute")==="true"'],
        ["expectedGitHubUserId", "42196638"],
        ["serverEntry", 'join(repo,"apps","server","dist","main.js")'],
      ]) {
        const initializer = findUniqueVariableInitializer(sourceFile, variable!);
        expect(initializer === undefined ? undefined : text(initializer), variable).toBe(expected);
      }
      const compact = text(sourceFile);
      for (const guard of [
        "assert.equal(value.approvedDraftSha256,draftSha256)",
        "assert.equal(value.maximumPostAttemptsPerTarget,1)",
        "assert.equal(value.executionScope.maximumGitHubPostAttempts,2)",
        "assert.equal(operation.actionIntentPayload.body,fixedBody(number))",
        "assert(!allowExecute||(executeRequested&&approvalValidated&&executionConsumed))",
        "assert(executeRequested&&approvalValidated&&executionConsumed)",
        "assert(prepared&&!confirmDispatches.has(prepared.intent.id)&&!prepared.confirmAttempts)",
        "confirmDispatches.add(prepared.intent.id);prepared.confirmAttempts=1;awaitsaveState();",
      ])
        expect(compact, guard).toContain(guard);
      expect(compact).not.toContain("...process.env");
      expect(compact).not.toContain("INVESTIGATION_GITHUB_TOKEN:");
    });
  });

  // This integration case starts the native TypeScript API and inspects the entire repository.
  it("removes the retired Server binding island while preserving reviewed production surfaces", {
    timeout: 60_000,
  }, () => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const contractsPackage = JSON.parse(
      readFileSync(join(repositoryRoot, "packages", "contracts", "package.json"), "utf8"),
    ) as { readonly exports?: Readonly<Record<string, unknown>> };
    expect(contractsPackage.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    });
    for (const [directory, pattern] of retiredFileGroups) {
      expect(readMatchingFileNames(join(repositoryRoot, directory), pattern), directory).toEqual(
        [],
      );
    }
    const migrationsDirectory = join(repositoryRoot, "migrations");
    const migrations = readdirSync(migrationsDirectory)
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort();
    expect(migrations).toContain("0008_worker_token_auth_v1.sql");
    expect(migrations).not.toContain("0012_server_binding_persistence_v1.sql");
    expect(migrations).not.toContain("0013_worker_token_auth_v1.sql");
    for (const migration of migrations) {
      const source = readFileSync(join(migrationsDirectory, migration), "utf8");
      for (const table of retiredDatabaseTables) {
        expect(source.includes(table), `${migration}: ${table}`).toBe(false);
      }
    }

    const serverPackage = JSON.parse(
      readFileSync(join(repositoryRoot, "apps", "server", "package.json"), "utf8"),
    ) as Readonly<Record<string, unknown>>;
    const serverTsconfig = JSON.parse(
      readFileSync(join(repositoryRoot, "apps", "server", "tsconfig.json"), "utf8"),
    ) as { readonly compilerOptions?: Readonly<Record<string, unknown>> };
    const rootTsconfig = JSON.parse(
      readFileSync(join(repositoryRoot, "tsconfig.base.json"), "utf8"),
    ) as { readonly compilerOptions?: Readonly<Record<string, unknown>> };
    expect(serverPackage).not.toHaveProperty("imports");
    expect(serverPackage).not.toHaveProperty("exports");
    expect(serverTsconfig.compilerOptions ?? {}).not.toHaveProperty("paths");
    expect(rootTsconfig.compilerOptions ?? {}).not.toHaveProperty("paths");

    const productionSources = productionSourceFiles(repositoryRoot).map((fileName) => ({
      fileName,
      source: readFileSync(fileName, "utf8"),
    }));
    for (const operation of retiredDatabaseOperations) {
      expect(
        productionSources.some(({ source }) => source.includes(operation)),
        operation,
      ).toBe(false);
    }
    for (const table of retiredDatabaseTables) {
      expect(
        productionSources.some(({ source }) => source.includes(table)),
        table,
      ).toBe(false);
    }
    for (const token of retiredDatabaseBootstrapTokens) {
      expect(
        productionSources.some(({ source }) => source.includes(token)),
        token,
      ).toBe(false);
    }

    const inspections = inspectProductionModules(productionSources);
    const offenders: string[] = [];
    for (const { fileName } of productionSources) {
      const violations = inspections.get(fileName) ?? ["AST inspection result unavailable"];
      if (violations.length !== 0) {
        offenders.push(
          `${relative(repositoryRoot, fileName).replaceAll("\\", "/")}: ${violations.join(", ")}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("rejects runtime loader escapes and attempts to restore retired binding modules", () => {
    const mutations = [
      'import "../feature.test.js";',
      'import "../fixture.testing.js";',
      'import vm from "node:vm";',
      'await import("./hidden.js");',
      'require("./hidden.js");',
      'createRequire(import.meta.url)("./hidden.js");',
      'process.getBuiltinModule("node:fs");',
      'process.dlopen(module, "addon.node");',
      'Module._load("node:fs");',
      'eval("ignored");',
      'new Function("return 1");',
      'new Worker(new URL("./hidden.js", import.meta.url));',
      'spawn("node", ["hidden.js"]);',
      'spawnSync("node", ["hidden.js"]);',
      'execFile("node", ["hidden.js"]);',
      'fork("./hidden.js");',
      'import { parseServerBindingReceiptV1 } from "@agentic-review/contracts/server-binding-authority-v1";',
      'import "../enrollment/server-binding-coordinator-v1.js";',
      String.raw`await import("./server-binding-\\u0061uthority-v1.js");`,
      'const hidden = globalThis["Function"]; void hidden;',
      'const lookup = Reflect.get; Reflect.apply(lookup, Reflect, [process, "get" + "BuiltinModule"]);',
    ];
    const sources = mutations.map((source, index) => ({
      fileName: `mutation-${index}.ts`,
      source,
    }));
    const inspections = inspectProductionModules(sources);
    for (const mutation of sources) {
      expect(inspections.get(mutation.fileName)?.length ?? 0, mutation.source).toBeGreaterThan(0);
    }
  });

  it("permits only the exact reviewed Worker and child-process launch sites", () => {
    const allowed = [
      {
        fileName: resolve("test-fixtures/apps/server/src/database/database-client.ts"),
        source:
          'import { Worker } from "node:worker_threads"; class DatabaseClient { constructor(options) { const workerUrl = import.meta.url.endsWith(".ts") ? new URL("./database-worker.ts", import.meta.url) : new URL("./database-worker.js", import.meta.url); this.worker = new Worker(workerUrl, { workerData: options }); } }',
      },
      {
        fileName: resolve(`test-fixtures${evidenceVerifierClientSuffix}`),
        source:
          'import { Worker } from "node:worker_threads"; class EvidenceVerificationClient { constructor(options, transport) { this.#root = structuredClone(checkVerificationSchema(EvidenceVerificationRootSchema, options.storageRoot)); this.#transport = transport ?? new Worker(new URL("./evidence-verification-worker.js", import.meta.url), { workerData: this.#root, resourceLimits: { maxOldGenerationSizeMb: 128 }, }); } }',
      },
      {
        fileName: resolve(`test-fixtures${evidenceVerifierWorkerSuffix}`),
        source:
          'import { isMainThread, parentPort, workerData } from "node:worker_threads"; if (!isMainThread) { parentPort.postMessage(workerData); }',
      },
      {
        fileName: resolve("test-fixtures/apps/worker/scripts/build-worker-bundles.mjs"),
        source:
          'import { spawnSync } from "node:child_process"; function typecheckWorker() { const typeScriptPackage = fileURLToPath(import.meta.resolve("typescript/package.json")); const compiler = resolve(dirname(typeScriptPackage), "bin/tsc"); spawnSync(process.execPath, [compiler, "-p", "tsconfig.json", "--noEmit"], { cwd: workerRoot, encoding: "utf8", windowsHide: true, }); }',
      },
      {
        fileName: resolve("test-fixtures/apps/worker/src/execution/process-host-client.ts"),
        source:
          'import { type ChildProcessWithoutNullStreams, spawn as spawnChildProcess } from "node:child_process"; const defaultSpawnProcess = (executable, argumentsList, options) => spawnChildProcess(executable, [...argumentsList], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, detached: false, stdio: ["pipe", "pipe", "pipe"], });',
      },
    ];
    const allowedInspections = inspectProductionModules(allowed);
    for (const source of allowed) {
      expect(allowedInspections.get(source.fileName), source.fileName).toEqual([]);
    }

    const drift = [
      {
        fileName: "apps/server/src/database/database-client.ts",
        source:
          'import { Worker } from "node:worker_threads"; const W = Worker; new W(new URL("./hidden.js", import.meta.url));',
      },
      {
        fileName: "apps/worker/src/execution/process-host-client.ts",
        source:
          'import { spawn as spawnChildProcess } from "node:child_process"; spawnChildProcess.call(null, dynamicPath, [], {});',
      },
      {
        fileName: "apps/server/src/main.ts",
        source: 'import { spawn } from "node:child_process"; spawn("node", ["hidden.js"]);',
      },
    ];
    const driftInspections = inspectProductionModules(drift);
    for (const source of drift) {
      expect(driftInspections.get(source.fileName)?.length ?? 0, source.fileName).toBeGreaterThan(
        0,
      );
    }
  });

  it("rejects evidence verifier loader, binding, option and port import drift", () => {
    const client =
      'import { Worker } from "node:worker_threads"; class EvidenceVerificationClient { constructor(options, transport) { this.#root = structuredClone(checkVerificationSchema(EvidenceVerificationRootSchema, options.storageRoot)); this.#transport = transport ?? new Worker(new URL("./evidence-verification-worker.js", import.meta.url), { workerData: this.#root, resourceLimits: { maxOldGenerationSizeMb: 128 }, }); } }';
    const worker =
      'import { isMainThread, parentPort, workerData } from "node:worker_threads"; if (!isMainThread) { parentPort.postMessage(workerData); }';
    const mutations = [
      ...[
        client.replace('"./evidence-verification-worker.js"', "options.workerPath"),
        client.replace('"./evidence-verification-worker.js"', '"./different-worker.js"'),
        client.replace("import.meta.url)", "options.baseUrl)"),
        client.replace(
          "resourceLimits: { maxOldGenerationSizeMb: 128 },",
          "resourceLimits: { maxOldGenerationSizeMb: 128 }, eval: true,",
        ),
        client.replace(
          "resourceLimits: { maxOldGenerationSizeMb: 128 },",
          'resourceLimits: { maxOldGenerationSizeMb: 128 }, execArgv: ["--import", options.loader],',
        ),
        client.replace("maxOldGenerationSizeMb: 128", "maxOldGenerationSizeMb: options.heapLimit"),
        client.replace("workerData: this.#root", "workerData: options"),
        client.replace(
          "structuredClone(checkVerificationSchema(EvidenceVerificationRootSchema, options.storageRoot))",
          "options.storageRoot",
        ),
        client.replace("this.#transport = transport ??", "this.#transport = arbitraryTransport ??"),
        client.replace("class EvidenceVerificationClient", "class UnreviewedClient"),
        client.replace("constructor(options, transport)", "create(options, transport)"),
        client
          .replace("import { Worker }", "import { Worker as W }")
          .replace("new Worker(", "new W("),
        client.replace(
          "class EvidenceVerificationClient",
          "const escaped = Worker; class EvidenceVerificationClient",
        ),
        client.replace(
          "class EvidenceVerificationClient",
          "export { Worker }; class EvidenceVerificationClient",
        ),
        client.replace('import { Worker } from "node:worker_threads";', ""),
        client.replace(
          'import { Worker } from "node:worker_threads";',
          'import { Worker } from "node:worker_threads"; import { Worker } from "node:worker_threads";',
        ),
        client.replace('"node:worker_threads"', '"worker_threads"'),
        client
          .replace(
            "this.#transport = transport ?? new Worker",
            "const deferred = () => { this.#transport = transport ?? new Worker",
          )
          .replace("}); } }", "}); }; } }"),
        client.replace(
          "}); } }",
          '}); this.#transport = transport ?? new Worker(new URL("./evidence-verification-worker.js", import.meta.url), { workerData: this.#root, resourceLimits: { maxOldGenerationSizeMb: 128 }, }); } }',
        ),
      ].map((source, index) => ({
        fileName: resolve(`evidence-mutations/client-${index}${evidenceVerifierClientSuffix}`),
        source,
      })),
      ...[
        worker.replace(
          "isMainThread, parentPort, workerData",
          "isMainThread, parentPort, workerData, Worker",
        ),
        worker.replace("parentPort, workerData", "parentPort as port, workerData"),
        worker.replace("import { isMainThread, parentPort, workerData }", "import * as threads"),
        worker.replace('"node:worker_threads"', '"worker_threads"'),
        worker.replace(
          'import { isMainThread, parentPort, workerData } from "node:worker_threads";',
          "",
        ),
        `${worker} new Worker(new URL("./evidence-verification-worker.js", import.meta.url));`,
      ].map((source, index) => ({
        fileName: resolve(`evidence-mutations/worker-${index}${evidenceVerifierWorkerSuffix}`),
        source,
      })),
      {
        fileName: resolve("evidence-mutations/apps/server/src/database/unreviewed-client.ts"),
        source: client,
      },
    ];
    const inspections = inspectProductionModules(mutations);
    for (const mutation of mutations)
      expect(inspections.get(mutation.fileName)?.length ?? 0, mutation.source).toBeGreaterThan(0);
  });

  it("permits only the sealed production supervisor fork and rejects loader drift", () => {
    const fixture = `
      import { fork } from "node:child_process";
      const entries = Object.freeze({
        server: "apps/server/dist/main.js",
        worker: "apps/worker/dist/worker.mjs",
      });
      export async function runSupervisor(configurationPath) {
        const config = validateConfiguration(readJson(configurationPath));
        const entryPath = resolve(config.releaseDirectory, entries[config.role]);
        const bridgePath = resolve(config.releaseDirectory, "deploy/operations/windows-shutdown-bridge.mjs");
        let child;
        const launch = () => {
          child = fork(entryPath, [], {
            cwd: config.dataDirectory,
            env: childEnvironment,
            execPath: config.nodeExecutable,
            execArgv: ["--enable-source-maps", "--import", pathToFileURL(bridgePath).href],
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            windowsHide: true,
          });
        };
      }
    `;
    const repositoryRoot = resolve("supervisor-loader-fixtures/allowed");
    const allowed = {
      fileName: join(repositoryRoot, windowsSupervisorSuffix.slice(1)),
      repositoryRoot,
      source: fixture,
    };
    const guardedRoot = resolve("supervisor-loader-fixtures/guarded");
    const guarded = {
      fileName: join(guardedRoot, windowsSupervisorSuffix.slice(1)),
      repositoryRoot: guardedRoot,
      source: fixture
        .replace(
          "const launch = () => {",
          'const launch = () => { if (!save({ state: "starting", childPid: null })) return; try {',
        )
        .replace("        };", "          } catch { child = undefined; }\n        };"),
    };
    const formattedRoot = resolve("supervisor-loader-fixtures/formatted");
    const formatted = {
      fileName: join(formattedRoot, windowsSupervisorSuffix.slice(1)),
      repositoryRoot: formattedRoot,
      source: guarded.source.replace(
        '"deploy/operations/windows-shutdown-bridge.mjs");',
        '"deploy/operations/windows-shutdown-bridge.mjs",);',
      ),
    };
    const productionRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const productionFileName = join(productionRoot, windowsSupervisorSuffix.slice(1));
    const production = {
      fileName: productionFileName,
      repositoryRoot: productionRoot,
      source: readFileSync(productionFileName, "utf8"),
    };
    const allowedSources = [allowed, guarded, formatted, production];
    const allowedInspections = inspectProductionModules(allowedSources);
    for (const source of allowedSources) {
      expect(allowedInspections.get(source.fileName), source.source).toEqual([]);
    }
    const mutations = [
      fixture.replace('import { fork } from "node:child_process";', ""),
      fixture.replace('"node:child_process"', '"child_process"'),
      fixture.replace("import { fork }", "import * as childProcess"),
      fixture.replace("import { fork }", "import { fork, execFile }"),
      fixture
        .replace("import { fork }", "import { fork as launchProcess }")
        .replace("child = fork(", "child = launchProcess("),
      `import { fork } from "node:child_process"; ${fixture}`,
      `${fixture} export { fork };`,
      `${fixture} const escaped = fork;`,
      fixture.replace("child = fork(", "child = fork.call(null, "),
      fixture.replace("child = fork(", "child = childProcess.fork("),
      fixture.replace("child = fork(", "child = ordinaryStart("),
      fixture.replace("child = fork(", `child = ${reviewedSupervisorForkCall}; child = fork(`),
      fixture.replace("child = fork(", "return fork("),
      fixture.replace("fork(entryPath, []", 'fork("./unreviewed.mjs", []'),
      fixture.replace('"--enable-source-maps", "--import"', '"--eval", "--import"'),
      fixture.replace("pathToFileURL(bridgePath).href", "config.loader"),
      fixture.replace("execPath: config.nodeExecutable", "execPath: config.arbitraryExecutable"),
      fixture.replace("env: childEnvironment", "env: process.env"),
      fixture.replace("windowsHide: true", "windowsHide: false"),
      fixture.replace('"ignore", "pipe", "pipe", "ipc"', '"inherit", "inherit", "inherit"'),
      fixture.replace('worker: "apps/worker/dist/worker.mjs"', 'worker: "./unreviewed.mjs"'),
      fixture.replace("Object.freeze({", "Object.seal({"),
      fixture.replace("const entries =", "let entries ="),
      fixture.replace(
        "validateConfiguration(readJson(configurationPath))",
        "readJson(configurationPath)",
      ),
      fixture.replace("entries[config.role]", "config.entryPath"),
      fixture.replace("const entryPath =", "let entryPath ="),
      fixture.replace('"deploy/operations/windows-shutdown-bridge.mjs"', "config.bridgePath"),
      fixture.replace("const bridgePath =", "let bridgePath ="),
      fixture.replace("const launch = () =>", "const launch = (entryPath) =>"),
      fixture.replace("runSupervisor(configurationPath)", "arbitrarySupervisor(configurationPath)"),
      fixture.replace(
        "const launch = () => {",
        'const launch = () => { const bridgePath = "./other.mjs";',
      ),
      fixture
        .replace("const launch = () => {", "const launch = () => { const deferred = () => {")
        .replace("        };", "        }; };"),
    ].map((source, index) => {
      expect(source, `Supervisor mutation ${index} must change the fixture.`).not.toBe(fixture);
      const root = resolve(`supervisor-loader-fixtures/mutation-${index}`);
      return {
        fileName: join(root, windowsSupervisorSuffix.slice(1)),
        repositoryRoot: root,
        source,
      };
    });
    const adjacent = [
      "deploy/operations/adjacent.mjs",
      "deploy/operations/nested/windows-supervisor.mjs",
      "deploy/operations-old/windows-supervisor.mjs",
      "apps/worker/src/deploy/operations/windows-supervisor.mjs",
    ].map((path) => ({ fileName: join(repositoryRoot, path), repositoryRoot, source: fixture }));
    const inspections = inspectProductionModules([...mutations, ...adjacent]);
    for (const source of [...mutations, ...adjacent]) {
      expect(inspections.get(source.fileName)?.length ?? 0, source.source).toBeGreaterThan(0);
    }
  });
});

function readMatchingFileNames(directory: string, pattern: RegExp): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.Node & { readonly modifiers?: readonly ts.Node[] }).modifiers;
  return modifiers?.some((value) => value.kind === kind) ?? false;
}

interface AstSourceInput {
  readonly fileName: string;
  readonly source: string;
  readonly repositoryRoot?: string;
}

function inspectProductionModules(
  sources: readonly AstSourceInput[],
): ReadonlyMap<string, string[]> {
  return withVirtualSourceFiles(sources, (sourceFiles) => {
    const inspections = new Map<string, string[]>();
    for (const source of sources) {
      const sourceFile = sourceFiles.get(source.fileName);
      if (sourceFile === undefined) throw new Error(`Missing virtual AST for ${source.fileName}.`);
      inspections.set(
        source.fileName,
        inspectProductionSourceFile(sourceFile, source.fileName, source.repositoryRoot),
      );
    }
    return inspections;
  });
}

function isAllowedServerBindingAuthorityImport(node: ts.Node, normalizedFileName: string): boolean {
  return (
    ts.isStringLiteralLikeNode(node) &&
    node.text === serverBindingAuthoritySubpath &&
    ts.isImportDeclaration(node.parent) &&
    node.parent.moduleSpecifier === node &&
    serverBindingAuthorityConsumerAllowlist.some(
      (suffix) => normalizedFileName === suffix.slice(1) || normalizedFileName.endsWith(suffix),
    )
  );
}

function inspectProductionSourceFile(
  sourceFile: ts.SourceFile,
  originalFileName: string,
  repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url)),
): string[] {
  const violations = new Set<string>();
  const normalizedFileName = `/${relative(repositoryRoot, originalFileName)
    .replaceAll("\\", "/")
    .toLowerCase()}`;
  const loaderBindings = collectImportedLoaderBindings(sourceFile);
  const reflectGetAliases = collectReflectGetAliases(sourceFile);
  if (reflectGetAliases.size !== 0) {
    violations.add("Reflect.get loader-capable alias");
  }
  for (const violation of inspectSensitiveBindingExports(sourceFile)) {
    violations.add(violation);
  }
  const allowedLoaderBindingReferences = new Map<string, number>();
  let allowedWorkerCalls = 0;
  let allowedSpawnSyncCalls = 0;
  let allowedProcessHostSpawnCalls = 0;
  let allowedSupervisorForkCalls = 0;
  const inspectModuleSpecifier = (specifier: ts.Expression): void => {
    if (!ts.isStringLiteralLikeNode(specifier)) return;
    const candidates = [specifier.text, decodeStaticLiteral(specifier.getText(sourceFile))].map(
      (value) => value.replace(/^["'`]|["'`]$/gu, "").toLowerCase(),
    );
    if (
      candidates.some((value) => value.includes("server-binding-authority-v1")) &&
      !isAllowedServerBindingAuthorityImport(specifier, normalizedFileName)
    ) {
      violations.add("server binding authority import outside exact S1 allowlist");
    }
    for (const candidate of candidates) {
      const normalizedCandidate = candidate.replaceAll("\\", "/");
      if (
        /(?:^|\/)[^/]+\.(?:spec|test|testing)(?:\.[cm]?[jt]sx?)?(?:[?#].*)?$/u.test(
          normalizedCandidate,
        )
      ) {
        violations.add("production import of a test bridge");
      }
      if (
        isExcludedSourceImport(normalizedCandidate, originalFileName, testOnlyAcceptanceSourceFiles)
      ) {
        violations.add("production import of a test-only acceptance module");
      }
      if (isExcludedSourceImport(normalizedCandidate, originalFileName, designBuildSourceFiles)) {
        violations.add("production import of an offline design build tool");
      }
      const moduleName = sensitiveServerBindingModuleName(candidate);
      if (
        moduleName !== undefined &&
        !isAllowedSensitiveServerBindingConsumer(moduleName, normalizedFileName)
      ) {
        violations.add(`${moduleName} import outside exact S1 dependency allowlist`);
      }
    }
    if (
      candidates.some(
        (value) =>
          value === "module" ||
          value === "node:module" ||
          value === "vm" ||
          value.startsWith("node:vm"),
      )
    ) {
      violations.add("runtime loader module import");
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && findAncestor(node, ts.isImportDeclaration) === undefined) {
      const loaderKind = loaderBindings.get(node.text);
      if (loaderKind !== undefined) {
        if (isAllowedImportedLoaderReference(node, loaderKind, sourceFile, normalizedFileName)) {
          allowedLoaderBindingReferences.set(
            node.text,
            (allowedLoaderBindingReferences.get(node.text) ?? 0) + 1,
          );
        } else {
          violations.add(`${node.text} loader binding escaped its direct call target`);
        }
      }
    }
    const staticValue = staticStringValue(node);
    if (
      staticValue?.toLowerCase().includes("server-binding-authority-v1") === true &&
      !isAllowedServerBindingAuthorityImport(node, normalizedFileName)
    ) {
      violations.add("server binding authority sensitive literal outside exact S1 allowlist");
    }
    if (staticValue?.toLowerCase().includes(serverBindingSignerHostFixtureBasename) === true) {
      violations.add("production signer-host fixture reference");
    }
    if (staticValue?.toLowerCase().includes("--fixture-scenario=") === true) {
      violations.add("production signer-host fixture scenario selector");
    }
    if (ts.isIdentifier(node)) {
      const identifier = node.text.toLowerCase();
      if (
        identifier === "_load" ||
        identifier === "createrequire" ||
        identifier === "dlopen" ||
        identifier === "eval" ||
        identifier === "function" ||
        identifier === "getbuiltinmodule" ||
        identifier === "require"
      ) {
        violations.add(`${identifier} loader reference`);
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const memberName = staticStringValue(node.argumentExpression)?.toLowerCase();
      if (
        memberName !== undefined &&
        [
          "_load",
          "createrequire",
          "dlopen",
          "eval",
          "function",
          "getbuiltinmodule",
          "require",
        ].includes(memberName)
      ) {
        violations.add(`${memberName} computed loader reference`);
      }
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) inspectModuleSpecifier(node.moduleSpecifier);
    }
    if (ts.isImportDeclaration(node)) {
      inspectLoaderImport(node, normalizedFileName, violations);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLikeNode(node.argument.literal)
    ) {
      inspectModuleSpecifier(node.argument.literal);
    }
    if (ts.isImportEqualsDeclaration(node)) violations.add("import equals loader");
    if (ts.isCallExpression(node)) {
      if (ts.isImportExpression(node.expression)) violations.add("dynamic import loader");
      const name = calledExpressionName(node.expression);
      if (name === "get" && expressionReceiverName(node.expression) === "reflect") {
        const receiver = node.arguments[0];
        const memberName =
          node.arguments[1] === undefined
            ? undefined
            : staticStringValue(node.arguments[1])?.toLowerCase();
        if (
          (receiver !== undefined &&
            ts.isIdentifier(receiver) &&
            ["globalthis", "module", "process"].includes(receiver.text.toLowerCase())) ||
          (memberName !== undefined &&
            [
              "_load",
              "createrequire",
              "dlopen",
              "function",
              "getbuiltinmodule",
              "require",
            ].includes(memberName))
        ) {
          violations.add("Reflect.get runtime loader escape");
        }
      }
      if (
        name === "apply" &&
        expressionReceiverName(node.expression) === "reflect" &&
        node.arguments[0] !== undefined &&
        isReflectGetReference(node.arguments[0], reflectGetAliases)
      ) {
        violations.add("Reflect.apply loader lookup escape");
      }
      if (
        name === "createrequire" ||
        name === "dlopen" ||
        name === "eval" ||
        name === "getbuiltinmodule" ||
        name === "require"
      ) {
        violations.add(`${name} runtime loader`);
      }
      if (name === "function") violations.add("Function runtime loader");
      if (name === "_load" && expressionReceiverName(node.expression) === "module") {
        violations.add("Module._load runtime loader");
      }
      if (
        name === "execfile" ||
        name === "execfilesync" ||
        name === "fork" ||
        name === "importscripts" ||
        name === "spawn" ||
        name === "spawnsync"
      ) {
        if (isAllowedSpawnSyncCall(node, sourceFile, normalizedFileName)) {
          allowedSpawnSyncCalls += 1;
        } else if (isAllowedSupervisorForkCall(node, sourceFile, normalizedFileName)) {
          allowedSupervisorForkCalls += 1;
        } else {
          violations.add(`${name} process or script loader`);
        }
      }
      if (name === "spawnchildprocess") {
        if (isAllowedProcessHostSpawnCall(node, sourceFile, normalizedFileName)) {
          allowedProcessHostSpawnCalls += 1;
        } else {
          violations.add("spawnChildProcess loader outside exact allowlist");
        }
      }
    }
    if (ts.isNewExpression(node) && calledExpressionName(node.expression) === "worker") {
      if (isAllowedWorkerCall(node, sourceFile, normalizedFileName)) {
        allowedWorkerCalls += 1;
      } else {
        violations.add("Worker loader");
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text.toLowerCase() === "function"
    ) {
      violations.add("Function runtime loader");
    }
    node.forEachChild((child) => {
      visit(child);
      return undefined;
    });
  };
  visit(sourceFile);
  const expectedWorkerCalls =
    normalizedFileName.endsWith("/apps/server/src/database/database-client.ts") ||
    normalizedFileName.endsWith(evidenceVerifierClientSuffix)
      ? 1
      : 0;
  const expectedSpawnSyncCalls = normalizedFileName.endsWith(
    "/apps/worker/scripts/build-worker-bundles.mjs",
  )
    ? 1
    : 0;
  const expectedProcessHostSpawnCalls = normalizedFileName.endsWith(
    "/apps/worker/src/execution/process-host-client.ts",
  )
    ? 1
    : 0;
  const expectedSupervisorForkCalls = normalizedFileName === windowsSupervisorSuffix ? 1 : 0;
  if (
    allowedWorkerCalls !== expectedWorkerCalls ||
    allowedSpawnSyncCalls !== expectedSpawnSyncCalls ||
    allowedProcessHostSpawnCalls !== expectedProcessHostSpawnCalls ||
    allowedSupervisorForkCalls !== expectedSupervisorForkCalls
  ) {
    violations.add("exact loader allowlist call count mismatch");
  }
  for (const binding of loaderBindings.keys()) {
    if ((allowedLoaderBindingReferences.get(binding) ?? 0) !== 1) {
      violations.add(`${binding} loader binding reference count mismatch`);
    }
  }
  if (
    normalizedFileName.endsWith(evidenceVerifierClientSuffix) ||
    normalizedFileName.endsWith(evidenceVerifierWorkerSuffix)
  ) {
    const imports = sourceFile.statements.filter(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteralLikeNode(statement.moduleSpecifier) &&
        ["node:worker_threads", "worker_threads"].includes(
          statement.moduleSpecifier.text.toLowerCase(),
        ),
    );
    if (imports.length !== 1)
      violations.add("exact evidence verifier worker import count mismatch");
  }
  if (normalizedFileName === windowsSupervisorSuffix) {
    const imports = sourceFile.statements.filter(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteralLikeNode(statement.moduleSpecifier) &&
        ["node:child_process", "child_process"].includes(
          statement.moduleSpecifier.text.toLowerCase(),
        ),
    );
    if (imports.length !== 1)
      violations.add("exact supervisor child-process import count mismatch");
  }
  return [...violations].sort();
}

function isExcludedSourceImport(
  specifier: string,
  importingFileName: string,
  excludedSourceFiles: ReadonlySet<string>,
): boolean {
  let path = specifier.split(/[?#]/u, 1)[0] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {
    // Invalid percent encoding remains unmatched and fails ordinary module resolution.
  }
  if (path.startsWith(".")) path = resolve(dirname(importingFileName), path);
  path = posix.normalize(path.replaceAll("\\", "/")).toLowerCase();
  return [...excludedSourceFiles].some((sourcePath) =>
    [
      sourcePath,
      sourcePath.replace(/\.ts$/u, ".js"),
      sourcePath.replace(/\.(?:ts|mjs)$/u, ""),
    ].some((candidate) => path === candidate || path.endsWith(`/${candidate}`)),
  );
}

function sensitiveServerBindingModuleName(specifier: string): string | undefined {
  let normalized = specifier.replaceAll("\\", "/").toLowerCase();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Invalid percent encoding remains unmatched and is rejected by ordinary module resolution.
  }
  const suffixStart = normalized.search(/[?#]/u);
  if (suffixStart >= 0) normalized = normalized.slice(0, suffixStart);
  for (const moduleName of sensitiveServerBindingModuleConsumers.keys()) {
    if (
      normalized === moduleName ||
      normalized.endsWith(`/${moduleName}`) ||
      normalized.endsWith(`/${moduleName}.js`) ||
      normalized.endsWith(`/${moduleName}.ts`)
    ) {
      return moduleName;
    }
  }
  return undefined;
}

function isAllowedSensitiveServerBindingConsumer(
  moduleName: string,
  normalizedFileName: string,
): boolean {
  return (
    sensitiveServerBindingModuleConsumers
      .get(moduleName)
      ?.some(
        (suffix) => normalizedFileName === suffix.slice(1) || normalizedFileName.endsWith(suffix),
      ) ?? false
  );
}

function inspectSensitiveBindingExports(sourceFile: ts.SourceFile): string[] {
  const taintedBindings = collectSensitiveImportedBindings(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer !== undefined &&
            exposesSensitiveBinding(declaration.initializer, taintedBindings) &&
            !taintedBindings.has(declaration.name.text)
          ) {
            taintedBindings.add(declaration.name.text);
            changed = true;
          }
        }
      }
      if (
        ts.isExpressionStatement(statement) &&
        ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(statement.expression.left) &&
        exposesSensitiveBinding(statement.expression.right, taintedBindings) &&
        !taintedBindings.has(statement.expression.left.text)
      ) {
        taintedBindings.add(statement.expression.left.text);
        changed = true;
      }
    }
  }

  const violations: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLikeNode(statement.moduleSpecifier) &&
      (statement.moduleSpecifier.text.toLowerCase() === serverBindingAuthoritySubpath ||
        sensitiveServerBindingModuleName(statement.moduleSpecifier.text) !== undefined)
    ) {
      violations.push("sensitive module direct re-export");
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        if (taintedBindings.has(localName)) {
          violations.push(`${localName} sensitive imported binding re-export`);
        }
      }
    }
    if (
      ts.isExportAssignment(statement) &&
      exposesSensitiveBinding(statement.expression, taintedBindings)
    ) {
      violations.push("sensitive imported binding export assignment");
    }
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          declaration.initializer !== undefined &&
          exposesSensitiveBinding(declaration.initializer, taintedBindings)
        ) {
          violations.push("sensitive imported binding exported through a variable");
        }
      }
    }
    if (
      ts.isFunctionDeclaration(statement) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      statement.body !== undefined &&
      blockReturnsSensitiveBinding(statement.body, taintedBindings)
    ) {
      violations.push("sensitive imported binding returned by an exported function");
    }
    if (ts.isClassDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const member of statement.members) {
        if (
          ts.isPropertyDeclaration(member) &&
          member.initializer !== undefined &&
          exposesSensitiveBinding(member.initializer, taintedBindings)
        ) {
          violations.push("sensitive imported binding exported through a class field");
        }
        if (
          (ts.isMethodDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member) ||
            ts.isConstructorDeclaration(member) ||
            ts.isClassStaticBlockDeclaration(member)) &&
          member.body !== undefined &&
          blockReturnsSensitiveBinding(member.body, taintedBindings)
        ) {
          violations.push("sensitive imported binding returned by an exported class member");
        }
      }
    }
  }
  return violations;
}

function collectSensitiveImportedBindings(sourceFile: ts.SourceFile): Set<string> {
  const bindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLikeNode(statement.moduleSpecifier) ||
      statement.importClause === undefined
    ) {
      continue;
    }
    const moduleName = statement.moduleSpecifier.text.toLowerCase();
    if (
      moduleName !== serverBindingAuthoritySubpath &&
      sensitiveServerBindingModuleName(moduleName) === undefined
    ) {
      continue;
    }
    if (statement.importClause.name !== undefined) {
      bindings.add(statement.importClause.name.text);
    }
    const namedBindings = statement.importClause.namedBindings;
    if (namedBindings === undefined) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      bindings.add(namedBindings.name.text);
      continue;
    }
    for (const element of namedBindings.elements) bindings.add(element.name.text);
  }
  return bindings;
}

function collectReflectGetAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        isReflectGetReference(node.initializer, aliases) &&
        !aliases.has(node.name.text)
      ) {
        aliases.add(node.name.text);
        changed = true;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isReflectGetReference(node.right, aliases) &&
        !aliases.has(node.left.text)
      ) {
        aliases.add(node.left.text);
        changed = true;
      }
      node.forEachChild((child) => {
        visit(child);
        return undefined;
      });
    };
    visit(sourceFile);
  }
  return aliases;
}

function isReflectGetReference(expression: ts.Expression, aliases: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(expression)) return aliases.has(expression.text);
  if (ts.isParenthesizedExpression(expression)) {
    return isReflectGetReference(expression.expression, aliases);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text.toLowerCase() === "reflect" &&
      expression.name.text.toLowerCase() === "get"
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    return (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text.toLowerCase() === "reflect" &&
      staticStringValue(expression.argumentExpression)?.toLowerCase() === "get"
    );
  }
  return false;
}

function exposesSensitiveBinding(
  expression: ts.Expression,
  bindings: ReadonlySet<string>,
): boolean {
  if (ts.isIdentifier(expression)) return bindings.has(expression.text);
  if (ts.isParenthesizedExpression(expression)) {
    return exposesSensitiveBinding(expression.expression, bindings);
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertion(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return exposesSensitiveBinding(expression.expression, bindings);
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return exposesSensitiveBinding(expression.expression, bindings);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.some(
      (element) => !ts.isOmittedExpression(element) && exposesSensitiveBinding(element, bindings),
    );
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property))
        return ts.isIdentifier(property.name) && bindings.has(property.name.text);
      if (ts.isPropertyAssignment(property)) {
        return exposesSensitiveBinding(property.initializer, bindings);
      }
      if (ts.isSpreadAssignment(property))
        return exposesSensitiveBinding(property.expression, bindings);
      return false;
    });
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      exposesSensitiveBinding(expression.whenTrue, bindings) ||
      exposesSensitiveBinding(expression.whenFalse, bindings)
    );
  }
  if (ts.isArrowFunction(expression) && !ts.isBlock(expression.body)) {
    return exposesSensitiveBinding(expression.body, bindings);
  }
  if (ts.isArrowFunction(expression) && ts.isBlock(expression.body)) {
    return blockReturnsSensitiveBinding(expression.body, bindings);
  }
  return false;
}

function blockReturnsSensitiveBinding(block: ts.Block, bindings: ReadonlySet<string>): boolean {
  let escaped = false;
  const visit = (node: ts.Node): void => {
    if (escaped || (node !== block && isFunctionLikeNode(node))) return;
    if (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      exposesSensitiveBinding(node.expression, bindings)
    ) {
      escaped = true;
      return;
    }
    node.forEachChild((child) => {
      visit(child);
      return undefined;
    });
  };
  visit(block);
  return escaped;
}

function isFunctionLikeNode(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

type ImportedLoaderKind = "process-host-spawn" | "spawn-sync" | "supervisor-fork" | "worker";

function collectImportedLoaderBindings(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ImportedLoaderKind> {
  const bindings = new Map<string, ImportedLoaderKind>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLikeNode(statement.moduleSpecifier) ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    const moduleName = statement.moduleSpecifier.text.toLowerCase();
    for (const element of statement.importClause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName?.text ?? element.name.text).toLowerCase();
      if (
        (moduleName === "node:worker_threads" || moduleName === "worker_threads") &&
        imported === "worker"
      ) {
        bindings.set(element.name.text, "worker");
      }
      if (moduleName === "node:child_process" || moduleName === "child_process") {
        if (imported === "spawnsync") bindings.set(element.name.text, "spawn-sync");
        if (imported === "spawn") bindings.set(element.name.text, "process-host-spawn");
        if (imported === "fork") bindings.set(element.name.text, "supervisor-fork");
      }
    }
  }
  return bindings;
}

function isAllowedImportedLoaderReference(
  identifier: ts.Identifier,
  kind: ImportedLoaderKind,
  sourceFile: ts.SourceFile,
  normalizedFileName: string,
): boolean {
  const parent = identifier.parent;
  if (kind === "worker" && ts.isNewExpression(parent) && parent.expression === identifier) {
    return isAllowedWorkerCall(parent, sourceFile, normalizedFileName);
  }
  if (kind === "spawn-sync" && ts.isCallExpression(parent) && parent.expression === identifier) {
    return isAllowedSpawnSyncCall(parent, sourceFile, normalizedFileName);
  }
  if (
    kind === "process-host-spawn" &&
    ts.isCallExpression(parent) &&
    parent.expression === identifier
  ) {
    return isAllowedProcessHostSpawnCall(parent, sourceFile, normalizedFileName);
  }
  if (
    kind === "supervisor-fork" &&
    ts.isCallExpression(parent) &&
    parent.expression === identifier
  ) {
    return isAllowedSupervisorForkCall(parent, sourceFile, normalizedFileName);
  }
  return false;
}

function staticStringValue(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLikeNode(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticStringValue(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticStringValue(span.expression);
      if (expression === undefined) return undefined;
      value += `${expression}${span.literal.text}`;
    }
    return value;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "join" &&
    ts.isArrayLiteralExpression(node.expression.expression) &&
    (node.arguments.length === 0 ||
      (node.arguments.length === 1 && staticStringValue(node.arguments[0] as ts.Node) === ""))
  ) {
    const parts = node.expression.expression.elements.map((element) => staticStringValue(element));
    return parts.some((part) => part === undefined) ? undefined : parts.join("");
  }
  return undefined;
}

function inspectLoaderImport(
  declaration: ts.ImportDeclaration,
  normalizedFileName: string,
  violations: Set<string>,
): void {
  if (!ts.isStringLiteralLikeNode(declaration.moduleSpecifier)) return;
  const moduleName = declaration.moduleSpecifier.text.toLowerCase();
  if (moduleName === "node:child_process" || moduleName === "child_process") {
    const expected = normalizedFileName.endsWith("/apps/worker/scripts/build-worker-bundles.mjs")
      ? "spawnSync:spawnSync:value"
      : normalizedFileName.endsWith("/apps/worker/src/execution/process-host-client.ts")
        ? "ChildProcessWithoutNullStreams:ChildProcessWithoutNullStreams:type,spawn:spawnChildProcess:value"
        : normalizedFileName === windowsSupervisorSuffix
          ? "fork:fork:value"
          : undefined;
    if (
      expected === undefined ||
      importedBindingSignature(declaration) !== expected ||
      (normalizedFileName === windowsSupervisorSuffix &&
        declaration.moduleSpecifier.text !== "node:child_process")
    ) {
      violations.add("child_process import outside exact allowlist");
    }
  }
  if (moduleName === "node:worker_threads" || moduleName === "worker_threads") {
    const expected = normalizedFileName.endsWith("/apps/server/src/database/database-client.ts")
      ? "Worker:Worker:value"
      : normalizedFileName.endsWith("/apps/server/src/database/database-worker.ts")
        ? "parentPort:parentPort:value,workerData:workerData:value"
        : normalizedFileName.endsWith(evidenceVerifierClientSuffix)
          ? "Worker:Worker:value"
          : normalizedFileName.endsWith(evidenceVerifierWorkerSuffix)
            ? "isMainThread:isMainThread:value,parentPort:parentPort:value,workerData:workerData:value"
            : undefined;
    const evidenceModule =
      normalizedFileName.endsWith(evidenceVerifierClientSuffix) ||
      normalizedFileName.endsWith(evidenceVerifierWorkerSuffix);
    if (
      expected === undefined ||
      importedBindingSignature(declaration) !== expected ||
      (evidenceModule && declaration.moduleSpecifier.text !== "node:worker_threads")
    ) {
      violations.add("worker_threads import outside exact allowlist");
    }
  }
}

function importedBindingSignature(declaration: ts.ImportDeclaration): string {
  const clause = declaration.importClause;
  const phaseModifier = clause?.phaseModifier as ts.Node | ts.SyntaxKind | undefined;
  const phaseModifierKind = typeof phaseModifier === "number" ? phaseModifier : phaseModifier?.kind;
  if (
    clause === undefined ||
    clause.name !== undefined ||
    (phaseModifierKind !== undefined && phaseModifierKind !== ts.SyntaxKind.TypeKeyword) ||
    clause.namedBindings === undefined ||
    !ts.isNamedImports(clause.namedBindings)
  ) {
    return "invalid";
  }
  const clauseIsTypeOnly =
    (clause as ts.ImportClause & { readonly isTypeOnly?: boolean }).isTypeOnly ||
    phaseModifierKind === ts.SyntaxKind.TypeKeyword;
  return clause.namedBindings.elements
    .map((element) => {
      const imported = element.propertyName?.text ?? element.name.text;
      return `${imported}:${element.name.text}:${clauseIsTypeOnly || element.isTypeOnly ? "type" : "value"}`;
    })
    .sort()
    .join(",");
}

function isAllowedWorkerCall(
  expression: ts.NewExpression,
  sourceFile: ts.SourceFile,
  normalizedFileName: string,
): boolean {
  if (normalizedFileName.endsWith(evidenceVerifierClientSuffix)) {
    if (compactNodeText(expression, sourceFile) !== reviewedEvidenceWorkerCall) return false;
    const constructorDeclaration = findAncestor(expression, ts.isConstructorDeclaration);
    const containingClass =
      constructorDeclaration === undefined
        ? undefined
        : findAncestor(constructorDeclaration, ts.isClassDeclaration);
    if (
      constructorDeclaration === undefined ||
      containingClass?.name?.text !== "EvidenceVerificationClient"
    )
      return false;
    let current = expression.parent as ts.Node | undefined;
    while (current !== constructorDeclaration && current !== undefined) {
      if (isFunctionLikeNode(current)) return false;
      current = current.parent as ts.Node | undefined;
    }
    const fallback = expression.parent;
    const assignment = fallback.parent;
    if (
      !ts.isBinaryExpression(fallback) ||
      fallback.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
      fallback.right !== expression ||
      compactNodeText(fallback.left, sourceFile) !== "transport" ||
      !ts.isBinaryExpression(assignment) ||
      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      assignment.right !== fallback ||
      compactNodeText(assignment.left, sourceFile) !== "this.#transport"
    )
      return false;
    const rootInitializers: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        compactNodeText(node.left, sourceFile) === "this.#root"
      )
        rootInitializers.push(node.right);
      node.forEachChild((child) => {
        visit(child);
        return undefined;
      });
    };
    visit(constructorDeclaration);
    return (
      rootInitializers.length === 1 &&
      rootInitializers[0] !== undefined &&
      compactNodeText(rootInitializers[0], sourceFile).replace(/,\)$/u, ")") ===
        reviewedEvidenceRootInitialization
    );
  }
  if (
    normalizedFileName.endsWith("/apps/server/src/database/database-client.ts") &&
    compactNodeText(expression, sourceFile) === "newWorker(workerUrl,{workerData:options})"
  ) {
    const constructorDeclaration = findAncestor(expression, ts.isConstructorDeclaration);
    const containingClass =
      constructorDeclaration === undefined
        ? undefined
        : findAncestor(constructorDeclaration, ts.isClassDeclaration);
    const initializer =
      constructorDeclaration === undefined
        ? undefined
        : findUniqueVariableInitializer(constructorDeclaration, "workerUrl");
    return (
      constructorDeclaration !== undefined &&
      containingClass?.name?.text === "DatabaseClient" &&
      initializer !== undefined &&
      compactNodeText(initializer, sourceFile) ===
        'import.meta.url.endsWith(".ts")?newURL("./database-worker.ts",import.meta.url):newURL("./database-worker.js",import.meta.url)'
    );
  }
  return false;
}

function isAllowedSpawnSyncCall(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  normalizedFileName: string,
): boolean {
  if (
    !normalizedFileName.endsWith("/apps/worker/scripts/build-worker-bundles.mjs") ||
    calledExpressionName(expression.expression) !== "spawnsync" ||
    compactNodeText(expression, sourceFile) !==
      'spawnSync(process.execPath,[compiler,"-p","tsconfig.json","--noEmit"],{cwd:workerRoot,encoding:"utf8",windowsHide:true,})'
  ) {
    return false;
  }
  const functionDeclaration = findAncestor(expression, ts.isFunctionDeclaration);
  if (functionDeclaration?.name?.text !== "typecheckWorker") return false;
  const packageInitializer = findUniqueVariableInitializer(
    functionDeclaration,
    "typeScriptPackage",
  );
  const compilerInitializer = findUniqueVariableInitializer(functionDeclaration, "compiler");
  return (
    packageInitializer !== undefined &&
    compilerInitializer !== undefined &&
    compactNodeText(packageInitializer, sourceFile) ===
      'fileURLToPath(import.meta.resolve("typescript/package.json"))' &&
    compactNodeText(compilerInitializer, sourceFile) ===
      'resolve(dirname(typeScriptPackage),"bin/tsc")'
  );
}

function isAllowedProcessHostSpawnCall(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  normalizedFileName: string,
): boolean {
  if (
    !normalizedFileName.endsWith("/apps/worker/src/execution/process-host-client.ts") ||
    compactNodeText(expression, sourceFile) !==
      'spawnChildProcess(executable,[...argumentsList],{cwd:options.cwd,env:options.env,shell:false,windowsHide:true,detached:false,stdio:["pipe","pipe","pipe"],})'
  ) {
    return false;
  }
  const arrow = findAncestor(expression, ts.isArrowFunction);
  const declaration = arrow?.parent;
  return (
    arrow !== undefined &&
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === "defaultSpawnProcess" &&
    declaration.initializer === arrow &&
    compactNodeText(arrow, sourceFile) ===
      '(executable,argumentsList,options)=>spawnChildProcess(executable,[...argumentsList],{cwd:options.cwd,env:options.env,shell:false,windowsHide:true,detached:false,stdio:["pipe","pipe","pipe"],})'
  );
}

function isAllowedSupervisorForkCall(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  normalizedFileName: string,
): boolean {
  if (
    normalizedFileName !== windowsSupervisorSuffix ||
    compactNodeText(expression, sourceFile) !== reviewedSupervisorForkCall
  ) {
    return false;
  }
  const launch = findAncestor(expression, ts.isArrowFunction);
  const launchDeclaration = launch?.parent;
  const supervisor =
    launch === undefined ? undefined : findAncestor(launch, ts.isFunctionDeclaration);
  const assignment = expression.parent;
  if (
    launch === undefined ||
    launch.parameters.length !== 0 ||
    launchDeclaration === undefined ||
    !ts.isVariableDeclaration(launchDeclaration) ||
    !ts.isIdentifier(launchDeclaration.name) ||
    launchDeclaration.name.text !== "launch" ||
    launchDeclaration.initializer !== launch ||
    supervisor?.name?.text !== "runSupervisor" ||
    supervisor.parent !== sourceFile ||
    supervisor.body === undefined ||
    supervisor.parameters.length !== 1 ||
    compactNodeText(supervisor.parameters[0] as ts.Node, sourceFile) !== "configurationPath" ||
    launchDeclaration.parent.parent.parent !== supervisor.body ||
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    assignment.right !== expression ||
    compactNodeText(assignment.left, sourceFile) !== "child"
  ) {
    return false;
  }
  return (
    hasReviewedConstant(sourceFile, "entries", reviewedSupervisorEntries, sourceFile) &&
    hasReviewedConstant(
      supervisor.body,
      "config",
      "validateConfiguration(readJson(configurationPath))",
      sourceFile,
    ) &&
    hasReviewedConstant(
      supervisor.body,
      "entryPath",
      "resolve(config.releaseDirectory,entries[config.role])",
      sourceFile,
    ) &&
    hasReviewedConstant(
      supervisor.body,
      "bridgePath",
      'resolve(config.releaseDirectory,"deploy/operations/windows-shutdown-bridge.mjs")',
      sourceFile,
    )
  );
}

function hasReviewedConstant(
  root: ts.Node,
  name: string,
  initializer: string,
  sourceFile: ts.SourceFile,
): boolean {
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      declarations.push(node);
    }
    node.forEachChild((child) => {
      visit(child);
      return undefined;
    });
  };
  visit(root);
  const statement = declarations[0]?.parent.parent;
  return (
    declarations.length === 1 &&
    statement !== undefined &&
    ts.isVariableStatement(statement) &&
    statement.parent === root &&
    // Formatting a multiline call adds a semantically inert final argument comma.
    compactNodeText(statement, sourceFile).replace(/,\);$/u, ");") ===
      `const${name}=${initializer};`
  );
}

function compactNodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/gu, "");
}

function findAncestor<TNode extends ts.Node>(
  node: ts.Node,
  predicate: (candidate: ts.Node) => candidate is TNode,
): TNode | undefined {
  let current = node.parent as ts.Node | undefined;
  while (current !== undefined && current !== current.parent) {
    if (predicate(current)) return current;
    current = current.parent as ts.Node | undefined;
  }
  return undefined;
}

function findUniqueVariableInitializer(root: ts.Node, name: string): ts.Expression | undefined {
  const matches: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      matches.push(node.initializer);
    }
    node.forEachChild((child) => {
      visit(child);
      return undefined;
    });
  };
  visit(root);
  return matches.length === 1 ? matches[0] : undefined;
}

function withVirtualSourceFiles<T>(
  sources: readonly AstSourceInput[],
  inspect: (sourceFiles: ReadonlyMap<string, ts.SourceFile>) => T,
): T {
  const virtualRoot = resolve(process.cwd(), ".server-binding-authority-ast").replaceAll("\\", "/");
  const configPath = `${virtualRoot}/tsconfig.json`;
  const virtualPaths = sources.map(
    (source, index) => `${virtualRoot}/source-${index}${sourceFileExtension(source.fileName)}`,
  );
  const virtualFiles: Record<string, string> = {
    [configPath]: JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: false },
      files: virtualPaths,
    }),
  };
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const virtualPath = virtualPaths[index];
    if (source === undefined || virtualPath === undefined) {
      throw new Error("Virtual AST source indexing failed.");
    }
    virtualFiles[virtualPath] = source.source;
  }

  const api = new TypeScriptApi({
    cwd: virtualRoot,
    fs: createVirtualFileSystem(virtualFiles),
  });
  try {
    const snapshot = api.updateSnapshot({
      openFiles: virtualPaths,
      openProjects: [configPath],
    });
    try {
      const sourceFiles = new Map<string, ts.SourceFile>();
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const virtualPath = virtualPaths[index];
        if (source === undefined || virtualPath === undefined) {
          throw new Error("Virtual AST source indexing failed.");
        }
        const project = snapshot.getDefaultProjectForFile(virtualPath);
        const sourceFile = project?.program.getSourceFile(virtualPath);
        if (sourceFile === undefined)
          throw new Error(`TypeScript did not parse ${source.fileName}.`);
        sourceFiles.set(source.fileName, sourceFile);
      }
      return inspect(sourceFiles);
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

function sourceFileExtension(fileName: string): string {
  return fileName.toLowerCase().match(/\.(?:[cm]?[jt]s|[jt]sx)$/u)?.[0] ?? ".ts";
}

function calledExpressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text.toLowerCase();
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text.toLowerCase();
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLikeNode(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text.toLowerCase();
  }
  return undefined;
}

function expressionReceiverName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text.toLowerCase();
  }
  if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text.toLowerCase();
  }
  return undefined;
}

function decodeStaticLiteral(value: string): string {
  return value
    .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_match, hexadecimal: string) =>
      codePointForScan(hexadecimal),
    )
    .replace(/\\u([0-9a-f]{4})/giu, (_match, hexadecimal: string) => codePointForScan(hexadecimal))
    .replace(/\\x([0-9a-f]{2})/giu, (_match, hexadecimal: string) => codePointForScan(hexadecimal));
}

function codePointForScan(hexadecimal: string): string {
  const value = Number.parseInt(hexadecimal, 16);
  return Number.isSafeInteger(value) && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "invalid-code-point";
}

interface SourceDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}
function productionSourceFiles(
  root: string,
  readEntries: (directory: string) => readonly SourceDirectoryEntry[] = (directory) =>
    readdirSync(directory, { withFileTypes: true }),
): string[] {
  // Match .gitignore's generated artifacts exclusion and its explicit Server source exception.
  const artifactSourceRoot = "apps/server/src/artifacts";
  const skippedDirectories = new Set([
    ".git",
    ".turbo",
    ".umi",
    ".umi-production",
    "coverage",
    "dist",
    "node_modules",
  ]);
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readEntries(directory)) {
      const path = join(directory, entry.name);
      const repositoryPath = relative(root, path).replaceAll("\\", "/");
      // This user-protected directory must be excluded before any metadata or child reads.
      const protectedPath = "apps/worker/.tmp-ui-driver-v7aofu";
      const foldedPath = repositoryPath.toLowerCase();
      if (foldedPath === protectedPath || foldedPath.startsWith(`${protectedPath}/`)) continue;
      if (entry.isDirectory()) {
        if (skippedDirectories.has(entry.name)) continue;
        if (
          entry.name === "artifacts" &&
          repositoryPath !== artifactSourceRoot &&
          !repositoryPath.startsWith(`${artifactSourceRoot}/`)
        ) {
          continue;
        }
        visit(path);
        continue;
      }
      if (
        !entry.isFile() ||
        !/\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(entry.name) ||
        // Fixture modules are excluded from production compilation as well. Imports of these
        // files from a production module remain forbidden by the separate AST inspection.
        /\.(?:spec|test|testing)\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(entry.name) ||
        testOnlyAcceptanceSourceFiles.has(repositoryPath) ||
        designBuildSourceFiles.has(repositoryPath)
      ) {
        continue;
      }
      files.push(path);
    }
  };
  visit(root);
  return files.sort();
}
