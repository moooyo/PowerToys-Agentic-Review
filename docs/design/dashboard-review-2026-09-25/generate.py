"""Publish source-derived review documents. This does not run the application."""

from __future__ import annotations

import html
import json
import re
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASELINE = "91021df"
DATE = "2026-09-25"
COLORS = {
    "blue": ("#DCE6FF", "#173D79"),
    "green": ("#E6F1EA", "#25634E"),
    "amber": ("#FFF0D4", "#775000"),
    "red": ("#FCEAE9", "#B3261E"),
    "neutral": ("#EDF0F7", "#505966"),
}


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def wrap(value: str, width: float, size: int = 16) -> list[str]:
    return textwrap.wrap(value, max(12, int(width / (size * 0.57)))) or [""]


def rect(x: float, y: float, w: float, h: float, fill: str = "#FFFFFF",
         stroke: str = "#D4DAE5", r: int = 12) -> str:
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}"/>'


def txt(x: float, y: float, content: str | list[str], size: int = 16,
        color: str = "#1B1D24", weight: int = 400, gap: int = 23) -> str:
    lines = [content] if isinstance(content, str) else content
    return (f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" font-weight="{weight}">'
            + "".join(f'<tspan x="{x}" dy="{0 if i == 0 else gap}">{esc(line)}</tspan>'
                      for i, line in enumerate(lines)) + "</text>")


def link(target: str, label: str, contents: str) -> str:
    return (f'<a href="#screen={esc(target)}" aria-label="{esc(label)}" tabindex="0">'
            f'<title>{esc(label)}</title>{contents}</a>')


def start(width: int, height: int, title: str, description: str) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
            f'viewBox="0 0 {width} {height}" role="group" aria-label="{esc(title)}" '
            'style="font-family:Segoe UI,Arial,sans-serif">'
            f'<title>{esc(title)}</title><desc>{esc(description)}</desc>'
            '<style>svg a{cursor:pointer}svg a:hover rect{stroke:#345EAD;stroke-width:2}'
            'svg a:focus{outline:none}svg a:focus-visible rect{stroke:#345EAD;stroke-width:4}'
            'svg text{pointer-events:none}</style>'
            + rect(0, 0, width, height, "#FAF9FD", "#D4DAE5", 0))


def chip(x: float, y: float, text: str, tone: str = "blue") -> str:
    bg, fg = COLORS.get(tone, COLORS["neutral"])
    width = min(450, max(88, len(text) * 7.7 + 28))
    return rect(x, y, width, 30, bg, bg, 15) + txt(x + 14, y + 20, text, 13, fg, 600)


def panel(x: int, y: int, w: int, data: dict, form: bool = False) -> tuple[str, int]:
    heading = wrap(data["title"], w - 40, 19)
    cursor = y + 30 + (len(heading) - 1) * 25
    content = txt(x + 20, y + 30, heading, 19, weight=600, gap=25)
    cursor += 22
    for line in data.get("lines", []):
        lines = wrap(line, w - (64 if form else 40), 15)
        if form:
            h = max(44, 20 + len(lines) * 22)
            content += rect(x + 20, cursor - 5, w - 40, h, "#FAF9FD", "#D4DAE5", 6)
            content += txt(x + 32, cursor + 18, lines, 15, gap=22)
            cursor += h + 10
        else:
            content += txt(x + 20, cursor + 8, lines, 15, "#505966", gap=22)
            cursor += len(lines) * 22 + 16
    h = max(120, cursor - y + 10)
    tone = data.get("tone", "neutral")
    bg, _ = COLORS.get(tone, COLORS["neutral"])
    return rect(x, y, w, h) + rect(x, y, 5, h, bg, bg, 2) + content, h


def table(x: int, y: int, w: int, columns: list[str], rows: list[dict]) -> tuple[str, int]:
    columns = columns or ["Record", "Status", "Next step"]
    count = len(columns)
    first = 0.39 if count > 2 else 0.55
    widths = [w * first] + [w * (1 - first) / max(1, count - 1)] * (count - 1)
    widths = [w] if count == 1 else widths
    cursor_x = x
    result = rect(x, y, w, 44, "#EDF0F7", "#D4DAE5", 8)
    for col, cw in zip(columns, widths):
        result += txt(cursor_x + 16, y + 28, wrap(col, cw - 32, 13), 13, "#505966", 600, 16)
        cursor_x += cw
    cursor_y = y + 44
    for row in rows:
        cells = row.get("cells", [])
        wrapped = [wrap(str(cells[i]) if i < len(cells) else "", cw - 32, 15)
                   for i, cw in enumerate(widths)]
        height = max(66, 26 + max(map(len, wrapped)) * 21)
        body = rect(x, cursor_y, w, height, "#FFFFFF", "#D4DAE5", 0)
        cursor_x = x
        for i, (lines, cw) in enumerate(zip(wrapped, widths)):
            body += txt(cursor_x + 16, cursor_y + 26, lines, 15,
                        "#173D79" if i == 0 and row.get("target") else "#505966",
                        600 if i == 0 else 400, 21)
            cursor_x += cw
        result += link(row["target"], "Open " + cells[0], body) if row.get("target") else body
        cursor_y += height
    return result, cursor_y - y


def controls(x: int, y: int, w: int, items: list[dict]) -> tuple[str, int]:
    result = ""
    cursor_x, cursor_y = x, y
    for item in items:
        width = max(130, min(w, 40 + len(item["label"]) * 8.0))
        if cursor_x + width > x + w:
            cursor_x = x
            cursor_y += 60
        primary = item.get("kind") == "primary"
        danger = item.get("kind") == "danger"
        bg = "#345EAD" if primary else "#FCEAE9" if danger else "#FFFFFF"
        fg = "#FFFFFF" if primary else "#B3261E" if danger else "#345EAD"
        body = rect(cursor_x, cursor_y, width, 46, bg, "#345EAD" if primary else "#737D8C", 23)
        body += txt(cursor_x + 20, cursor_y + 29, item["label"], 15, fg, 600)
        result += link(item["target"], item["label"] + " - view prototype state", body)
        cursor_x += width + 12
    return result, cursor_y - y + 46 if items else 0


def screen_svg(screen: dict) -> str:
    parts = []
    x, w = 116, 1052
    # The shell retains the current application's four navigation groups.
    parts += [rect(0, 0, 84, 1600, "#F3F4FA", "#F3F4FA", 0),
              rect(18, 20, 48, 48, "#345EAD", "#345EAD", 16),
              txt(29, 50, "AR", 19, "#FFFFFF", 600)]
    for index, (label, target, short) in enumerate([
        ("Review", "pull-requests", "R"), ("Tasks", "tasks", "T"),
        ("Activity", "comments", "A"), ("Workspace", "repositories", "W"),
    ]):
        y = 102 + index * 85
        active = label == screen["group"] or (label == "Review" and screen["group"] == "Publication")
        body = rect(12, y, 60, 62, "#DFE6F4" if active else "#F3F4FA", "#F3F4FA", 18)
        body += txt(35, y + 25, short, 19, "#173D79", 600)
        body += txt(42 - len(label) * 3, y + 48, label, 11, "#505966")
        parts.append(link(target, label, body))
    parts += [rect(84, 0, 1116, 76, "#FFFFFF", "#D4DAE5", 0),
              txt(116, 32, "Agentic Review", 19, weight=600),
              txt(116, 55, "Review workspace", 13, "#505966"),
              rect(455, 17, 354, 42, "#F3F4FA", "#D4DAE5", 22),
              txt(473, 43, "Repository / Illustrative scope", 14, "#505966"),
              txt(886, 43, "Search", 14, "#505966"),
              link("account", "My account", rect(1098, 17, 46, 42, "#DCE6FF", "#DCE6FF", 21)
                   + txt(1110, 43, "RV", 15, "#173D79", 600))]
    is_auth = screen["id"] in ("sign-in", "session-expired")
    is_dialog = screen["id"] in ("account-editor", "unsaved-changes")
    if is_auth:
        x, w = 280, 640
        parts = [txt(40, 42, "Agentic Review", 20, "#345EAD", 600)]
    elif is_dialog:
        x, w = 236, 846
        parts.append(rect(84, 76, 1116, 1800, "#E7EBF4", "#E7EBF4", 0))
    content_start = len(parts)
    parts.append(txt(x, 114, screen["group"].upper() + " / " + screen["id"], 12, "#505966", 600))
    title_lines = wrap(screen["title"], w - 30, 28)
    parts.append(txt(x, 155, title_lines, 28, gap=34))
    y = 172 + (len(title_lines) - 1) * 34
    badge = screen.get("badge", {"text": "Illustrative state", "tone": "neutral"})
    parts.append(chip(x, y, badge["text"], badge.get("tone", "neutral")))
    y += 50
    if screen.get("tabs"):
        cursor_x = x
        active_tab = screen.get("activeTab", {
            "publication-select": "Select findings", "publication-compose": "Compose",
            "webhooks": "Webhook events", "workers": "Workers", "accounts": "Accounts",
            "repository-intake": "Intake", "repository-replies": "Replies", "repository-conflict": "Intake",
        }.get(screen["id"], screen["tabs"][0]))
        parts.append(rect(x, y, w, 42, "#F3F4FA", "#F3F4FA", 10))
        for label in screen["tabs"]:
            width = max(90, len(label) * 8 + 34)
            parts.append(txt(cursor_x + 16, y + 27, label, 14,
                             "#345EAD" if label == active_tab else "#505966", 600 if label == active_tab else 400))
            if label == active_tab:
                parts.append(rect(cursor_x + 12, y + 39, width - 24, 3, "#345EAD", "#345EAD", 1))
            cursor_x += width
        y += 62
    if screen.get("rows"):
        content, height = table(x, y, w, screen.get("columns", []), screen["rows"])
        parts.append(content)
        y += height + 24
    panels = screen.get("panels", [])
    form = screen["layout"] in ("form", "compose")
    if screen["layout"] == "report" and len(panels) > 1:
        content, left_h = panel(x, y, 300, panels[0])
        parts.append(content)
        right_y = y
        for data in panels[1:]:
            content, height = panel(x + 320, right_y, w - 320, data)
            parts.append(content)
            right_y += height + 16
        y = max(y + left_h, right_y - 16) + 24
    elif len(panels) >= 2 and screen["layout"] not in ("form", "compose", "preview", "state"):
        first_width = 644
        content, left_h = panel(x, y, first_width, panels[0])
        parts.append(content)
        right_y = y
        for data in panels[1:]:
            content, height = panel(x + first_width + 20, right_y, w - first_width - 20, data)
            parts.append(content)
            right_y += height + 16
        y = max(y + left_h, right_y - 16) + 24
    else:
        for data in panels:
            content, height = panel(x, y, w, data, form)
            parts.append(content)
            y += height + 16
        y += 8
    content, height = controls(x, y, w, screen.get("controls", []))
    parts.append(content)
    y += height + 34
    footer = wrap("SOURCE-DERIVED WIREFRAME / ILLUSTRATIVE CONTENT / LINKED CONTROLS OPEN ANOTHER REVIEW STATE", w, 11)
    parts.append(txt(x, y, footer, 11, "#505966", gap=16))
    height = max(740, y + 28 + (len(footer) - 1) * 16)
    # Clip the rail background to the document canvas without hiding content.
    if not is_auth:
        parts[0] = rect(0, 0, 84, height, "#F3F4FA", "#F3F4FA", 0)
    if is_auth or is_dialog:
        if is_dialog:
            parts[content_start - 1] = rect(84, 76, 1116, height - 76, "#E7EBF4", "#E7EBF4", 0)
        parts.insert(content_start, rect(x - 24, 85, w + 48, height - 102, "#FFFFFF", "#D4DAE5", 24))
    return start(1200, height, screen["title"], screen["summary"]) + "".join(parts) + "</svg>"


def flow_svg(journey: dict, screen_map: dict, standalone: bool = False) -> str:
    width = 1080
    steps = journey["steps"]
    height = 168 + len(steps) * 126 + len(journey.get("branches", [])) * 90
    content = start(width, height, journey["title"], journey["summary"])
    content += txt(34, 34, "REVIEW JOURNEY / " + journey["id"].upper(), 12, "#505966", 600)
    content += txt(34, 72, journey["title"], 28)
    content += txt(34, 104, wrap(journey["summary"], 995, 15), 15, "#505966", gap=21)
    for index, step in enumerate(steps):
        y = 150 + index * 126
        card = rect(34, y, 1006, 99)
        card += rect(50, y + 20, 42, 42, "#DCE6FF", "#DCE6FF", 21)
        card += txt(62, y + 47, str(index + 1).zfill(2), 16, "#173D79", 600)
        card += txt(112, y + 30, step["label"], 19, weight=600)
        card += txt(112, y + 57, wrap(step.get("note", ""), 888, 14), 14, "#505966", gap=20)
        content += link(step["screen"], screen_map[step["screen"]]["title"], card)
        if index < len(steps) - 1:
            content += f'<path d="M 70 {y + 100} v 19 l -4 -4 m 4 4 l 4 -4" fill="none" stroke="#737D8C" stroke-width="2"/>'
    y = 150 + len(steps) * 126
    for branch in journey.get("branches", []):
        label = "Branch: " + branch["label"]
        route = screen_map[branch["from"]]["title"] + " -> " + screen_map[branch["to"]]["title"]
        content += link(branch["to"], label, rect(34, y, 1006, 76, "#FFF0D4", "#E3CFA3", 12)
                        + txt(52, y + 23, route, 13, "#775000", 600)
                        + txt(52, y + 47, wrap(label, 960, 14), 14, "#775000", 400, 20))
        y += 90
    content += "</svg>"
    return content.replace('href="#screen=', 'href="../atlas.html#screen=') if standalone else content


def overview_svg(screen_map: dict, standalone: bool = False) -> str:
    rows = [
        ("REVIEW", "Understand a source and decide what happens next", ["pull-requests", "pr-detail", "report-detail", "publication-compose", "publication-preview", "action-receipt"]),
        ("INVESTIGATE", "Follow progress and recover an interrupted investigation", ["issues", "bug-detail", "followup", "task-detail", "task-interrupted", "reports"]),
        ("OPERATE", "Inspect delivery, intake, workers and access", ["comments", "webhooks", "workers", "repositories", "accounts", "account"]),
    ]
    result = start(1320, 784, "Dashboard interaction map", "Three review lanes. Click a screen to inspect its wireframe and outgoing transitions.")
    result += txt(32, 40, "AGENTIC REVIEW / CURRENT FRONTEND", 13, "#345EAD", 600)
    result += txt(32, 87, "From source to decision", 34)
    result += txt(32, 120, "Click through the workspace. Review the handoffs, state changes and confirmation boundaries.", 16, "#505966")
    for index, (name, description, ids) in enumerate(rows):
        y = 166 + index * 177
        result += txt(32, y, name, 12, "#345EAD", 600)
        result += txt(154, y, description, 14, "#505966")
        for n, target in enumerate(ids):
            x = 32 + n * 211
            screen = screen_map[target]
            card = rect(x, y + 22, 191, 102)
            card += rect(x + 14, y + 37, 32, 5, "#345EAD", "#345EAD", 2)
            card += txt(x + 14, y + 69, wrap(screen["title"], 167, 16), 16, weight=600, gap=21)
            card += txt(x + 14, y + 111, screen["group"], 11, "#505966")
            result += link(target, screen["title"], card)
            if n < 5:
                # Review and investigate lanes are sequences; operate is a peer index.
                if index < 2:
                    result += f'<path d="M{x + 194} {y + 73} h14 l-4 -4 m4 4 l-4 4" fill="none" stroke="#8994A5" stroke-width="1.6"/>'
    result += rect(32, 708, 1256, 46, "#EDF0F7", "#EDF0F7", 12)
    result += txt(48, 737, "Source baseline 91021df  |  Source-derived diagrams, not screenshots  |  Browser verification pending", 14, "#505966")
    result += "</svg>"
    return result.replace('href="#screen=', 'href="atlas.html#screen=') if standalone else result


def main() -> None:
    records = [json.loads((ROOT / name).read_text(encoding="utf-8")) for name in ("core.json", "support.json", "states.json")]
    screens = [screen for record in records for screen in record["screens"]]
    journeys = [journey for record in records for journey in record.get("journeys", [])]
    screen_map = {screen["id"]: screen for screen in screens}
    diagrams = {screen["id"]: screen_svg(screen) for screen in screens}
    flows = {journey["id"]: flow_svg(journey, screen_map) for journey in journeys}
    overview = overview_svg(screen_map)
    (ROOT / "screens").mkdir(exist_ok=True)
    (ROOT / "flows").mkdir(exist_ok=True)
    for key, value in diagrams.items():
        (ROOT / "screens" / f"{key}.svg").write_text(value.replace('href="#screen=', 'href="../atlas.html#screen='), encoding="utf-8")
    for journey in journeys:
        (ROOT / "flows" / f'{journey["id"]}.svg').write_text(flow_svg(journey, screen_map, True), encoding="utf-8")
    (ROOT / "overview.svg").write_text(overview_svg(screen_map, True), encoding="utf-8")
    data = {"baseline": BASELINE, "date": DATE, "screens": screens, "journeys": journeys,
            "diagrams": diagrams, "flows": flows, "overview": overview}
    payload = json.dumps(data, ensure_ascii=True).replace("</", "<\\/")
    template = (ROOT / "viewer.html").read_text(encoding="utf-8")
    page, replacements = re.subn(r"/\*__REVIEW_DATA__\*/\s*null\b", lambda _: payload, template)
    if replacements != 1:
        raise ValueError("The atlas template must contain exactly one review data placeholder.")
    (ROOT / "atlas.html").write_text(page, encoding="utf-8")
    manifest = {"baseline": BASELINE, "date": DATE, "screenCount": len(screens), "journeyCount": len(journeys),
                "evidence": "Source-derived wireframes with illustrative content; not screenshots or runtime acceptance.",
                "verification": "Blocked: designated remote Windows environment was stopped. No local verification performed."}
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    lines = ["# Screen and interaction catalog", "", f"Source baseline: `{BASELINE}`. Generated on {DATE}.", "",
             "These diagrams illustrate source-derived behavior. They are not screenshots or runtime evidence.", "",
             "| Screen | Group | Diagram | Source |", "| --- | --- | --- | --- |"]
    for screen in screens:
        source = screen["sources"][0]
        lines.append(f'| {screen["title"]} | {screen["group"]} | [{screen["id"]}](screens/{screen["id"]}.svg) | [{source["path"]}](../../../{source["path"]}#L{source["line"]}) |')
    lines += ["", "## Journeys", ""]
    for journey in journeys:
        lines.append(f'- [{journey["title"]}](flows/{journey["id"]}.svg): {journey["summary"]}')
    (ROOT / "CATALOG.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f'Published {len(screens)} screen diagrams and {len(journeys)} journeys to {ROOT / "atlas.html"}.')


if __name__ == "__main__":
    main()
