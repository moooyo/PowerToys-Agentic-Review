// Package existing workspace dependencies into the offline design artifact.
// This does not build, start, or verify the production application.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "../../..");
const require = createRequire(path.join(repository, "apps/dashboard/package.json"));
const { build } = await import(
  pathToFileURL(
    path.join(repository, "node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js"),
  ).href
);
const packages = ["react", "react-dom", "@mui/material", "@emotion/react", "@emotion/styled"];
const alias = Object.fromEntries(
  packages.map((name) => [name, path.dirname(require.resolve(name + "/package.json"))]),
);
await build({
  entryPoints: [path.join(directory, "prototype/material-controls.jsx")],
  outfile: path.join(directory, "prototype/vendor/material-controls.bundle.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "eof",
  charset: "ascii",
  define: { "process.env.NODE_ENV": '"production"' },
  alias,
  nodePaths: [path.join(repository, "apps/dashboard/node_modules")],
});
const licenseDirectory = path.join(directory, "prototype/vendor/material-licenses");
await mkdir(licenseDirectory, { recursive: true });
for (const [name, packageDirectory] of Object.entries(alias)) {
  for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    try {
      const license = await readFile(path.join(packageDirectory, file), "utf8");
      await writeFile(path.join(licenseDirectory, name.replaceAll("/", "-") + ".txt"), license);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
console.log("Packaged MUI controls and dependency license notices.");
