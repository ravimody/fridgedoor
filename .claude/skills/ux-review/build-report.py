# /// script
# requires-python = ">=3.11"
# ///
"""Builds a UX review's index.html from report.html (and mockup.html from mockup-src.html).

Usage: uv run .claude/skills/ux-review/build-report.py work/ux-review-<yyyymmdd>

<!--row:1p-011-home,1p-020-plan|Caption--> becomes a row of figures from shots/<name>.jpg
(or .png); {{img:name}} becomes a data URI for img/<name>.jpg (or .png). Missing files
are listed at the end.
"""

import base64
import pathlib
import re
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
missing: list[str] = []


def find(folder: str, name: str) -> pathlib.Path | None:
    for ext in ("jpg", "jpeg", "png"):
        path = ROOT / folder / f"{name}.{ext}"
        if path.exists():
            return path
    missing.append(f"{folder}/{name}")
    return None


def data_uri(path: pathlib.Path) -> str:
    kind = "png" if path.suffix == ".png" else "jpeg"
    return f"data:image/{kind};base64," + base64.b64encode(path.read_bytes()).decode()


def figure(name: str) -> str:
    path = find("shots", name.strip())
    if not path:
        return ""
    label = re.sub(r"^\d+[a-z]*-\d+-", "", name.strip()).replace("-", " ")
    return f'<figure><img loading="lazy" src="{data_uri(path)}" alt="{label}"><figcaption>{label}</figcaption></figure>'


def row(match: re.Match) -> str:
    spec, _, caption = match.group(1).partition("|")
    figures = "".join(figure(n) for n in spec.split(","))
    cap = f'<p class="cap">{caption}</p>' if caption else ""
    return f'<div class="row">{figures}</div>{cap}' if figures else ""


def img(match: re.Match) -> str:
    path = find("img", match.group(1))
    return data_uri(path) if path else ""


built = False
for src, out in (("report.html", "index.html"), ("mockup-src.html", "mockup.html")):
    source = ROOT / src
    if not source.exists():
        continue
    html = re.sub(r"<!--row:(.*?)-->", row, source.read_text())
    html = re.sub(r"\{\{img:([\w-]+)\}\}", img, html)
    (ROOT / out).write_text(html)
    built = True
    print(f"{out} {len(html) // 1024} KB", file=sys.stderr)
if not built:
    sys.exit(f"no report.html in {ROOT}")
if missing:
    print("missing:", " ".join(missing), file=sys.stderr)
