// Assemble static design documents only. This does not build the application.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFile(path.join(directory, name), "utf8");
const [shell, css, operations, core] = await Promise.all(
  ["shell.html", "prototype.css", "operations.js", "core.js"].map(read),
);
const fragment = `${shell}\n<style>\n${css}\n</style>\n<script>\n${operations}\n${core}\n</script>\n`;
await writeFile(path.join(directory, "prototype.fragment.html"), fragment);
await writeFile(
  path.join(directory, "index.html"),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<meta name="color-scheme" content="light dark">\n<title>Agentic Review · Interactive design prototype</title>\n<style>body{margin:0;padding:20px;background:light-dark(#f8f9fc,#10141b)}#ar-prototype{max-width:1440px;margin:0 auto}@media(max-width:620px){body{padding:8px}}</style>\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`,
);
console.log(`Wrote index.html and prototype.fragment.html (${Buffer.byteLength(fragment)} bytes).`);
