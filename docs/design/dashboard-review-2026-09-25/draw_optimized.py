"""Draw optimized interface schematics from authored UI content, not a browser.

The PNG and SVG are design illustrations. This script does not execute the app.
"""

from __future__ import annotations

import html
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "optimized-screens"
OUTPUT.mkdir(exist_ok=True)
INK = "#1B1D24"
MUTED = "#505966"
BLUE = "#345EAD"
SOFT = "#DCE6FF"
LOW = "#F3F4FA"
LINE = "#D4DAE5"
WHITE = "#FFFFFF"
CANVAS = "#FAF9FD"
FONT_CSS = (ROOT / "prototype/material-fonts.css").read_text(encoding="utf-8")


class Drawing:
    def __init__(self, width: int, height: int, title: str):
        self.width, self.height, self.title = width, height, title
        self.image = Image.new("RGB", (width, height), CANVAS)
        self.draw = ImageDraw.Draw(self.image)
        self.parts = [f'<rect width="{width}" height="{height}" fill="{CANVAS}"/>']
        self.fonts = {}

    def font(self, size: int, bold: bool = False, mono: bool = False):
        key = (size, bold, mono)
        if key not in self.fonts:
            family = "roboto-mono" if mono else "roboto"
            weight = 400 if mono or not bold else 500
            file = ROOT.parents[2] / f"apps/dashboard/node_modules/@fontsource/{family}/files/{family}-latin-{weight}-normal.woff"
            self.fonts[key] = ImageFont.truetype(str(file), size)
        return self.fonts[key]

    def box(self, x, y, w, h, fill=WHITE, stroke=LINE, radius=12):
        self.draw.rounded_rectangle((x, y, x + w, y + h), radius, fill, stroke, 1)
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>')

    def line(self, x1, y1, x2, y2, fill=LINE, width=1):
        self.draw.line((x1, y1, x2, y2), fill, width)
        self.parts.append(f'<path d="M{x1} {y1} L{x2} {y2}" stroke="{fill}" stroke-width="{width}"/>')

    def arrow(self, x, y, fill=MUTED):
        points = [(x, y), (x + 10, y), (x + 5, y + 6)]
        self.draw.polygon(points, fill)
        self.parts.append(f'<polygon points="{x},{y} {x+10},{y} {x+5},{y+6}" fill="{fill}"/>')

    def check(self, x, y, color=BLUE):
        self.line(x + 1, y + 7, x + 6, y + 12, color, 2)
        self.line(x + 6, y + 12, x + 15, y + 2, color, 2)

    def text(self, x, y, text, size=16, color=INK, bold=False, width=None, mono=False):
        font = self.font(size, bold, mono)
        lines = []
        for paragraph in str(text).split("\n"):
            if width is None:
                lines.append(paragraph)
                continue
            line = ""
            for word in paragraph.split():
                candidate = (line + " " + word).strip()
                if line and self.draw.textlength(candidate, font) > width:
                    lines.append(line)
                    line = word
                else:
                    line = candidate
            lines.append(line)
        gap = round(size * 1.42)
        for index, line in enumerate(lines):
            top = y + index * gap
            self.draw.text((x, top), line, color, font, anchor="lt")
            family = "Roboto Mono,monospace" if mono else "Roboto,Arial,sans-serif"
            self.parts.append(f'<text x="{x}" y="{top + size}" font-family="{family}" font-size="{size}" font-weight="{500 if bold else 400}" fill="{color}">{html.escape(line)}</text>')
        return len(lines) * gap

    def button(self, x, y, label, primary=False, width=None, small=False, tonal=False):
        size = 14 if small else 16
        w = width or int(self.draw.textlength(label, self.font(size, True))) + 38
        h = 38 if small else 46
        fill = BLUE if primary else "#DFE6F4" if tonal else WHITE
        self.box(x, y, w, h, fill, fill if primary or tonal else "#8792A3", h // 2)
        self.text(x + 19, y + (11 if small else 13), label, size, WHITE if primary else "#25344E" if tonal else BLUE, True)
        return w

    def chip(self, x, y, label, tone="neutral", width=None, interactive=False, checked=False):
        bg, fg = {"neutral": ("#EDF0F7", MUTED), "blue": (SOFT, "#173D79"),
                  "amber": ("#FFF0D4", "#775000"), "green": ("#E6F1EA", "#25634E")}[tone]
        w = width or int(self.draw.textlength(label, self.font(14))) + 24 + (22 if interactive else 0)
        self.box(x, y, w, 36 if interactive else 29, bg, bg if checked or not interactive else LINE, 8 if interactive else 4)
        if checked:
            self.check(x + 10, y + 9, fg)
        self.text(x + (34 if interactive else 12), y + (9 if interactive else 6), label, 14, fg)
        return w

    def field(self, x, y, w, label, value="", h=56):
        self.box(x, y + 24, w, h, WHITE, "#8792A3", 6)
        label_width = self.draw.textlength(label, self.font(13))
        self.box(x + 10, y + 16, label_width + 10, 18, WHITE, WHITE, 0)
        self.text(x + 15, y + 16, label, 13, MUTED)
        dropdown = value.rstrip().endswith(" v")
        if dropdown:
            value = value.rstrip()[:-1].rstrip()
            self.arrow(x + w - 26, y + 24 + h // 2 - 3)
        if value:
            self.text(x + 14, y + 40, value, 16, INK, width=w - (54 if dropdown else 28))

    def disclosure(self, x, y, text):
        self.text(x, y, "+", 18, BLUE)
        self.text(x + 25, y + 1, text, 14, MUTED)

    def svg(self):
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" viewBox="0 0 {self.width} {self.height}" role="img">'
                f'<title>{html.escape(self.title)}</title><desc>Authored optimized UI schematic. Not a browser screenshot.</desc>'
                + '<style><![CDATA[' + FONT_CSS + ']]></style>'
                + "".join(self.parts) + "</svg>")

    def save(self, name):
        self.image.save(OUTPUT / f"{name}.png")
        (OUTPUT / f"{name}.svg").write_text(self.svg(), encoding="utf-8")


def shell(title, group="Review", height=960):
    d = Drawing(1400, height, title)
    d.box(0, 0, 84, height, LOW, LOW, 0)
    d.box(20, 20, 44, 44, BLUE, BLUE, 15)
    d.box(31, 31, 8, 22, WHITE, WHITE, 2)
    d.box(43, 31, 10, 9, WHITE, WHITE, 2)
    d.box(43, 44, 10, 9, WHITE, WHITE, 2)
    for index, (label, letter) in enumerate([("Review", "R"), ("Tasks", "T"), ("Activity", "A"), ("Workspace", "W")]):
        y = 102 + 83 * index
        if label == group:
            d.box(14, y, 56, 34, "#DFE6F4", "#DFE6F4", 17)
        d.text(34, y + 7, letter, 17, BLUE if label == group else MUTED, True)
        tw = d.draw.textlength(label, d.font(11))
        d.text(42 - tw / 2, y + 42, label, 11, MUTED)
    d.box(84, 0, 1316, 80, WHITE, WHITE, 0)
    d.text(116, 28, "Agentic Review", 21, INK, True)
    d.box(703, 20, 389, 40, "#EDF0F7", "#EDF0F7", 9)
    d.text(719, 32, "example/dashboard-ui-fixture", 14, MUTED)
    d.arrow(1070, 36)
    d.text(1140, 31, "Search", 15, MUTED)
    d.text(1230, 31, "Link", 14, MUTED)
    d.box(1306, 20, 42, 42, SOFT, SOFT, 21)
    d.text(1316, 31, "DA", 14, BLUE, True)
    d.line(84, 80, 1400, 80)
    return d


def tabs(d, y, labels, active=0, x=116):
    for i, label in enumerate(labels):
        w = int(d.draw.textlength(label, d.font(16))) + 40
        d.text(x + 16, y + 13, label, 16, BLUE if i == active else MUTED, i == active)
        if i == active:
            d.line(x + 16, y + 45, x + w - 16, y + 45, BLUE, 3)
        x += w
    d.line(116, y + 47, 1360, y + 47)


def list_screen():
    d = shell("Optimized Pull requests")
    tabs(d, 96, ["Pull requests", "Issues", "Reports"])
    d.text(116, 181, "Pull requests", 32)
    d.button(1132, 174, "+ Import from GitHub", True)
    d.field(116, 241, 553, "Search pull requests", "Title or source number")
    d.field(687, 241, 248, "Source state", "All source states       v")
    d.button(958, 266, "Filters")
    d.button(1105, 266, "Refresh")
    x = 116
    for index, label in enumerate(["All investigations", "Needs review", "Running", "Blocked", "Interrupted", "Completed"]):
        w = d.chip(x, 335, label, "blue" if index == 0 else "neutral", interactive=True, checked=index == 0)
        x += w + 9
    d.box(116, 390, 1244, 443, WHITE, LINE, 15)
    d.box(117, 391, 1242, 45, LOW, LOW, 14)
    d.text(138, 404, "6 pull requests", 14, MUTED)
    d.text(920, 404, "Action", 14, MUTED)
    d.text(1150, 404, "Validation", 14, MUTED)
    rows = [
        ("Preserve settings when a migration is cancelled", "PR #2101 · Static review · Open · Completed", "Request changes", "Not run", "amber"),
        ("Improve keyboard navigation in Command Palette", "PR #2102 · Static review · Open · Completed", "Request changes", "Not run", "amber"),
        ("Inspect an in-progress synthetic E2E capture", "PR #2203 · E2E review · Open · Running", "View progress", "In progress", "blue"),
        ("E2E preflight requires a build prerequisite", "PR #2202 · E2E review · Open · Blocked", "View prerequisites", "Blocked", "amber"),
    ]
    for i, (title, meta, result, validation, tone) in enumerate(rows):
        y = 436 + 99 * i
        if i == 0:
            d.box(118, y, 1240, 98, "#F7F9FF", "#F7F9FF", 0)
        if i:
            d.line(117, y, 1359, y)
        d.text(139, y + 25, title, 18, INK, True, width=727)
        d.text(139, y + 59, meta, 13, MUTED)
        d.button(912, y + 28, result, small=True, tonal=True)
        d.chip(1150, y + 32, validation, tone)
        d.text(1324, y + 33, ">", 20, MUTED)
    d.text(130, 876, "1–4 of 6", 14, MUTED)
    d.button(1050, 861, "Previous page", small=True)
    d.button(1212, 861, "Next page", small=True)
    return d


def outcome(d, y, report=False):
    d.box(116, y, 1244, 172, LOW, LINE, 16)
    d.text(140, y + 19, "Review conclusion", 13, MUTED)
    d.text(140, y + 47, "Changes needed", 29)
    d.text(140, y + 93, "Required E2E: Not run", 16, "#775000", True)
    d.disclosure(140, y + 132, "Assessment details")
    d.line(775, y + 23, 775, y + 148)
    d.button(799, y + 36, "Prepare request changes", True)
    d.button(799, y + 97, "View evidence" if report else "Read report", small=True)
    d.button(966, y + 97, "Other actions", small=True)


def detail_screen():
    d = shell("Optimized Pull request detail")
    d.text(116, 106, "< Back to pull requests", 15, BLUE)
    d.text(116, 150, "Pull request #2101 · example/dashboard-ui-fixture", 14, MUTED)
    d.text(116, 183, "Preserve settings when a migration is cancelled", 29)
    d.text(116, 230, "Open · Snapshot imported 21 Sep, 09:10", 14, MUTED)
    d.button(1155, 226, "New review", small=True)
    outcome(d, 292)
    tabs(d, 487, ["Overview", "Investigations", "Discussion"])
    d.box(116, 561, 779, 157, WHITE, LINE, 16)
    d.text(140, 582, "About this change", 21, INK, True)
    d.text(140, 624, "Keep the previous configuration when settings migration is cancelled.", 17, MUTED, width=720)
    d.disclosure(140, 677, "Recorded source snapshot")
    d.box(116, 741, 779, 180, WHITE, LINE, 16)
    d.text(140, 765, "Current investigation", 21, INK, True)
    d.chip(735, 760, "Completed", "green")
    d.text(140, 812, "Changes needed · Complete · Exact original PR revision", 16, MUTED)
    d.button(140, 859, "Open task", small=True)
    d.button(280, 859, "Read report", small=True)
    d.box(918, 561, 442, 360, WHITE, LINE, 16)
    d.text(942, 582, "Source context", 21, INK, True)
    for i, (key, value) in enumerate([("Repository", "example/dashboard-ui-fixture"), ("Source state", "Open"), ("Classification", "Pull request"), ("Saved source", "a4d71e2 · commit")]):
        d.text(942, 629 + i * 59, key, 13, MUTED)
        d.text(942, 651 + i * 59, value, 15, INK)
    d.text(942, 883, "View recorded discussion", 14, BLUE)
    return d


def report_screen():
    d = shell("Optimized report and feedback", height=1500)
    d.text(116, 104, "< Back to reports", 15, BLUE)
    d.text(116, 144, "PR #2101 · Report v1", 13, MUTED)
    d.text(116, 176, "Preserve settings when a migration is cancelled", 29)
    outcome(d, 235, True)
    d.disclosure(116, 429, "Report details · Complete · Final")
    tabs(d, 475, ["Findings (2)", "Evidence", "Details"])
    d.field(116, 548, 539, "Search all 2 findings", "Title or file path")
    d.field(677, 548, 273, "Priority", "All priorities             v")
    d.field(972, 548, 388, "Assessment", "All assessments                      v")
    d.box(116, 638, 1244, 61, "#EDF0F7", "#EDF0F7", 12)
    d.button(131, 649, "Selected (1)", small=True)
    d.text(292, 660, "Saved", 14, MUTED)
    d.button(868, 649, "Select page", small=True)
    d.button(1020, 649, "Clear selection", small=True)
    d.text(1210, 660, "Save all drafts", 13, MUTED)
    d.text(116, 725, "1–2 of 2 findings", 13, MUTED)
    d.box(116, 754, 343, 129, "#DFE6F4", "#DFE6F4", 12)
    d.chip(134, 770, "P1", "amber")
    d.text(193, 777, "Confirmed · Selected", 13, MUTED)
    d.text(134, 813, "1. Cancellation can persist stale settings", 18, INK, True, width=300)
    d.text(134, 859, "SettingsMigration.cs:42", 12, MUTED)
    d.box(116, 898, 343, 121, WHITE, LINE, 12)
    d.chip(134, 912, "P1", "amber")
    d.text(193, 919, "Confirmed", 13, MUTED)
    d.text(134, 954, "2. Cancelled migration can leave an incomplete configuration", 17, INK, True, width=300)
    d.box(482, 726, 878, 730, WHITE, LINE, 16)
    d.text(506, 749, "Cancellation can persist stale settings", 25, INK, True)
    d.text(506, 790, "Confirmed · Finding 1 / 2 · original PR revision", 13, MUTED)
    d.box(507, 824, 20, 20, BLUE, BLUE, 3)
    d.check(509, 826, WHITE)
    d.text(540, 825, "Include in feedback", 15)
    d.chip(1260, 818, "P1", "amber")
    d.text(506, 876, "Trigger & impact", 17, INK, True)
    d.text(506, 908, "Cancellation can overwrite the previous configuration.", 16, MUTED)
    d.text(506, 950, "Source evidence", 17, INK, True)
    d.text(506, 981, "SettingsMigration.cs:42", 14, MUTED, mono=True)
    d.box(506, 1012, 830, 69, LOW, LOW, 8)
    d.text(521, 1028, "if (cancellationRequested) return;\nawait configuration.SaveAsync(nextSettings);", 15, INK, mono=True)
    d.text(506, 1108, "Final recheck", 17, INK, True)
    d.text(506, 1139, "Confirmed against the retained source. Runtime validation is not recorded.", 15, MUTED, width=815)
    d.text(506, 1189, "Proposed fix", 17, INK, True)
    d.chip(506, 1221, "Code suggestion available", "blue")
    d.field(506, 1280, 830, "Feedback draft", "Please preserve the previously saved settings when cancellation is requested.", 61)
    d.text(507, 1374, "Private · Session only", 12, MUTED)
    d.button(506, 1401, "Previous", small=True)
    d.button(1090, 1398, "Save draft & next", True)
    return d


def preview_screen():
    d = shell("Preview with generated summary", height=1200)
    d.box(84, 81, 1316, 1119, "#E7EBF4", "#E7EBF4", 0)
    d.box(202, 107, 1054, 1027, "#E7EBF4", "#CAD2DF", 26)
    d.text(234, 135, "Preview · Request changes", 29)
    d.text(1193, 139, "×", 25, MUTED)
    for x, step, label, active in [(234, "✓", "Select findings", True), (811, "2", "Preview", True)]:
        d.box(x, 187, 24, 24, BLUE if active else MUTED, BLUE if active else MUTED, 12)
        if step == "✓":
            d.check(x + 4, 192, WHITE)
        else:
            d.text(x + 7, 192, step, 12, WHITE)
        d.text(x + 36, 191, label, 16, BLUE if step == "2" else MUTED, step == "2")
        if x < 811:
            d.line(x + 174, 199, 779, 199, LINE)
    d.text(234, 228, "PR #2101 · example/dashboard-ui-fixture · Open · Head a4d71e2", 14, MUTED)
    d.text(234, 266, "2 selected · 2 code suggestions · 0 text findings", 17, INK, True)
    d.text(234, 308, "Destination: One GitHub review · REQUEST_CHANGES", 16, MUTED)
    d.box(234, 351, 988, 152, WHITE, LINE, 16)
    d.text(258, 374, "Review summary", 21, INK, True)
    d.text(258, 419, "Requesting changes for 2 findings affecting cancellation and configuration persistence. Runtime validation is still pending.", 18, INK, width=934)
    d.box(234, 535, 988, 265, LOW, LINE, 16)
    d.text(257, 556, "Finding 1 · Cancellation can persist stale settings", 21, INK, True)
    d.text(257, 596, "Confirmed · SettingsMigration.cs:42–43", 14, MUTED)
    d.text(257, 633, "Please preserve the previously saved settings when cancellation is requested. The write must be guarded before persistence.", 16, INK, width=934)
    d.box(257, 707, 942, 69, WHITE, LINE, 8)
    d.text(271, 721, "cancellationToken.ThrowIfCancellationRequested();\nawait configuration.SaveAsync(nextSettings, cancellationToken);", 15, INK, mono=True)
    d.box(234, 819, 988, 195, LOW, LINE, 16)
    d.text(257, 842, "Finding 2 · Cancelled migration can leave an incomplete configuration", 20, INK, True, width=940)
    d.text(257, 901, "Confirmed · SettingsMigration.cs:45–46", 14, MUTED)
    d.text(257, 935, "Please preserve the previously saved settings when cancellation is requested.", 16, INK, width=940)
    d.line(203, 1045, 1254, 1045, LINE)
    d.button(234, 1071, "Back to findings")
    d.button(803, 1071, "Edit feedback")
    d.button(983, 1071, "Confirm Request changes", True)
    d.box(1239, 307, 5, 662, "#D4DAE5", "#D4DAE5", 2)
    d.box(1239, 307, 5, 290, "#8994A5", "#8994A5", 2)
    return d


def main():
    screens = [
        ("pull-requests", "01", "Scan the queue", list_screen(), "page=pulls"),
        ("pr-detail", "02", "Review the conclusion", detail_screen(), "page=pulls&id=2101"),
        ("report", "03", "Read and edit feedback", report_screen(), "page=reports&id=2101&tab=findings"),
        ("preview", "04", "Preview the generated summary", preview_screen(), "page=pulls"),
    ]
    board = Drawing(2400, 2310, "Optimized frontend UI / UX - Material 3 refinement")
    board.text(62, 45, "Agentic Review", 42, INK, True)
    board.text(62, 110, "Optimized UI / UX · Material 3", 21, MUTED)
    board.chip(2057, 70, "OPTIMIZED / M3", "blue", 260)
    scale = 0.79
    for i, (name, number, label, drawing, route) in enumerate(screens):
        drawing.save(name)
        if name == "preview":
            drawing.save("compose")
        x = 60 + (i % 2) * 1160
        y = 200 if i < 2 else 1057
        board.text(x, y - 39, number, 18, BLUE, True)
        board.text(x + 44, y - 39, label, 20, INK, True)
        resized = drawing.image.resize((round(drawing.width * scale), round(drawing.height * scale)), Image.Resampling.LANCZOS)
        board.image.paste(resized, (x, y))
        board.parts.append(f'<a href="optimized.html#{html.escape(route, quote=True)}"><g transform="translate({x} {y}) scale({scale})">{"".join(drawing.parts)}</g></a>')
    board.text(62, 2270, "UI schematics · Illustrative sample data · Open optimized.html for the interactive prototype", 15, MUTED)
    board.image.save(ROOT / "optimized-overview.png")
    (ROOT / "optimized-overview.svg").write_text(board.svg(), encoding="utf-8")
    print("Drew four optimized screen illustrations and the combined PNG/SVG overview.")


if __name__ == "__main__":
    main()
