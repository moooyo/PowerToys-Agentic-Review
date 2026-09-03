import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outputDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const buildInfoFile = fileURLToPath(
  new URL("../node_modules/.cache/tsconfig.tsbuildinfo", import.meta.url),
);

await Promise.all([
  rm(outputDirectory, { force: true, recursive: true }),
  rm(buildInfoFile, { force: true }),
]);
