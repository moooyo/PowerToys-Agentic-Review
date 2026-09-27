import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface WorkerBundleScript {
  copyWorkerRuntimeAssets(targetDirectory: string): Promise<void>;
  cleanOutputDirectory(target: string, expectedParent: string): Promise<void>;
}
const script: WorkerBundleScript = await import(
  new URL("../scripts/build-worker-bundles.mjs", import.meta.url).href
);
let temporaryRoots: string[] = [];
const pendingRuntimeChecks: Promise<void>[] = [];
afterEach(async () => {
  const ownedRoots = temporaryRoots;
  temporaryRoots = [];
  // A Vitest timeout does not cancel file copies; drain the original check before cleanup.
  // The test returns the original promise and remains responsible for reporting its failure.
  await Promise.allSettled(pendingRuntimeChecks.splice(0));
  for (const root of ownedRoots) {
    const name = relative(resolve(tmpdir()), resolve(root));
    if (
      name === "" ||
      name.includes(sep) ||
      isAbsolute(name) ||
      !name.startsWith("worker-runtime-bundle-")
    )
      throw new Error("Runtime test cleanup escaped its owned temporary directory.");
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
async function temporaryRoot(): Promise<string> {
  const ownedRoots = temporaryRoots;
  const root = await mkdtemp(join(tmpdir(), "worker-runtime-bundle-"));
  ownedRoots.push(root);
  return root;
}
async function contentManifest(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      expect(entry.isSymbolicLink()).toBe(false);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        expect((await lstat(path)).isFile()).toBe(true);
        files.set(
          relative(root, path),
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        );
      }
    }
  };
  await walk(root);
  return files;
}

describe("Worker runtime distribution", () => {
  it("ships the Windows probe and an independently importable complete Playwright package", () => {
    const check = (async () => {
      const root = await temporaryRoot();
      const output = join(root, "dist");
      await script.copyWorkerRuntimeAssets(output);
      const sourceEntry = fileURLToPath(new URL("./ui/windows-driver-entry.ps1", import.meta.url));
      expect(await readFile(join(output, "windows-driver-entry.ps1"))).toEqual(
        await readFile(sourceEntry),
      );
      const installedPackage = await realpath(
        dirname(fileURLToPath(import.meta.resolve("playwright-core/package.json"))),
      );
      const packagedRuntime = join(output, "node_modules", "playwright-core");
      expect(await contentManifest(packagedRuntime)).toEqual(
        await contentManifest(installedPackage),
      );
      const metadata = JSON.parse(await readFile(join(packagedRuntime, "package.json"), "utf8"));
      expect(metadata.name).toBe("playwright-core");
      expect(Object.keys(metadata.dependencies ?? {})).toEqual([]);
      const browserMetadata = JSON.parse(
        await readFile(join(packagedRuntime, "browsers.json"), "utf8"),
      );
      expect(
        browserMetadata.browsers.some((browser: { name: string }) => browser.name === "chromium"),
      ).toBe(true);
      const standalone = await import(pathToFileURL(join(packagedRuntime, "index.mjs")).href);
      expect(typeof standalone.chromium.launch).toBe("function");
      expect(typeof standalone.chromium.executablePath()).toBe("string");
    })();
    pendingRuntimeChecks.push(check);
    return check;
  }, 30_000);

  it("cleans only the fixed dist child while preserving sibling deployment data", async () => {
    const root = await temporaryRoot();
    const marker = join(root, "keep.txt");
    await writeFile(marker, "Keep existing deployment data.");
    const output = join(root, "dist");
    await script.cleanOutputDirectory(output, root);
    await writeFile(join(output, "obsolete.txt"), "Old generated output.");
    await script.cleanOutputDirectory(output, root);
    expect(await readdir(output)).toEqual([]);
    for (const invalid of [
      root,
      join(root, "other"),
      join(root, "dist", "nested"),
      resolve(root, "..", "dist"),
    ])
      await expect(script.cleanOutputDirectory(invalid, root)).rejects.toThrow(
        "outside the fixed dist directory",
      );
    expect(await readFile(marker, "utf8")).toBe("Keep existing deployment data.");
  });
});
