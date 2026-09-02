import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptsDirectory, "..");
const outputDirectory = resolve(packageDirectory, "dist");

if (dirname(outputDirectory) !== packageDirectory || basename(outputDirectory) !== "dist") {
  throw new Error("Refusing to clean an output directory outside the Server package.");
}

await rm(outputDirectory, { recursive: true, force: true });
