"""Assemble the offline interactive prototype without running application code."""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "prototype"


def read(name: str) -> str:
    return (SOURCE / name).read_text(encoding="utf-8")


styles = "\n".join(read(name) for name in (
    "prototype.css", "material3.css", "workflow.css", "outcome.css",
    "publication.css", "review.css", "material-controls.css", "material-fonts.css", "material-surfaces.css", "row-actions.css",
))
scripts = "\n".join(read(name) for name in (
    "operations.js", "publication.js", "followup.js", "material-assets.js", "material-navigation.js", "vendor/material-controls.bundle.js", "core.js",
))
page = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Agentic Review - Optimized UI / UX prototype</title>
<style>__STYLES__</style>
</head>
<body>
__SHELL__
<script>__SCRIPTS__</script>
</body>
</html>
"""
def inline_script(source: str) -> str:
    return re.sub(r"</script", r"<\\/script", source, flags=re.IGNORECASE)


page = page.replace("__STYLES__", styles)
page = page.replace("__SHELL__", read("shell.html")).replace("__SCRIPTS__", inline_script(scripts))
(ROOT / "index.html").write_text(page, encoding="utf-8")
(ROOT / "optimized.html").write_text(page, encoding="utf-8")
print(f"Published optimized interactive prototype: {ROOT / 'optimized.html'}")
