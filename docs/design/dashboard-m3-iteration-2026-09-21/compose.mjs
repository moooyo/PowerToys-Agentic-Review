// Assemble static design documents only. This does not build the application.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const directory = path.dirname(fileURLToPath(import.meta.url));
const read = name => readFile(path.join(directory,name),'utf8');
const [shell, css, m3, workflow, outcome, publicationCss, operations, publication, followup, core, icons] = await Promise.all(['shell.html','prototype.css','material3.css','workflow.css','outcome.css','publication.css','operations.js','publication.js','followup.js','core.js','vendor/lucide.min.js'].map(read));
const fragment = `${shell}\n<style>\n${css}\n${m3}\n${workflow}\n${outcome}\n${publicationCss}\n</style>\n<script>\n${operations}\n${publication}\n${followup}\n${core}\n</script>\n`;
await writeFile(path.join(directory,'prototype.fragment.html'),fragment);
await writeFile(path.join(directory,'index.html'),`<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<meta name="color-scheme" content="light dark">\n<title>Agentic Review · Material 3 design prototype</title>\n<style>body{margin:0;padding:16px;background:light-dark(#faf9fd,#10141b)}#ar-m3-prototype{max-width:1440px;margin:0 auto}@media(max-width:620px){body{padding:8px}}</style>\n<script>${icons}</script>\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`);
console.log(`Wrote index.html and prototype.fragment.html (${Buffer.byteLength(fragment)} bytes).`);
