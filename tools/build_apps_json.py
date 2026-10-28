#!/usr/bin/env python3
"""Build apps.json from the published entries in projects.js."""

import argparse
import json
import re
import sys
from pathlib import Path


BASE_URL = "https://ottub.github.io/"
PUBLISHED_STATE = "App Storeで公開中"


def load_projects(path: Path) -> list[dict]:
    source = path.read_text(encoding="utf-8")
    match = re.search(
        r"window\.IWANT_PROJECTS\s*=\s*(\[.*\])\s*;",
        source,
        flags=re.DOTALL,
    )
    if match is None:
        raise ValueError(f"could not find window.IWANT_PROJECTS in {path}")
    projects = json.loads(match.group(1))
    if not isinstance(projects, list):
        raise ValueError("window.IWANT_PROJECTS must be an array")
    return projects


def build_payload(projects: list[dict]) -> dict:
    apps = []
    for project in projects:
        if project.get("state") != PUBLISHED_STATE:
            continue

        url = project["url"]
        match = re.search(r"/id(\d+)$", url)
        if match is None:
            raise ValueError(f"could not read App Store id from URL: {url}")

        app_id = match.group(1)
        apps.append(
            {
                "id": app_id,
                "name": project["name"],
                "field": project["field"],
                "copy": project["copy"].split("\n", 1)[0],
                "icon": BASE_URL + project["icon"].lstrip("/"),
                "url": f"https://apps.apple.com/jp/app/id{app_id}",
            }
        )
    return {"version": 1, "apps": apps}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit with status 1 if apps.json differs from projects.js",
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    projects_path = root / "projects.js"
    output_path = root / "apps.json"

    try:
        payload = build_payload(load_projects(projects_path))
    except (KeyError, OSError, json.JSONDecodeError, ValueError) as error:
        print(f"build_apps_json.py: {error}", file=sys.stderr)
        return 1

    expected = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode(
        "utf-8"
    )

    if args.check:
        try:
            actual = output_path.read_bytes()
        except OSError as error:
            print(f"apps.json cannot be read: {error}", file=sys.stderr)
            return 1
        if actual != expected:
            print("apps.json is out of date; run python3 tools/build_apps_json.py")
            return 1
        print("apps.json is up to date.")
        return 0

    try:
        output_path.write_bytes(expected)
    except OSError as error:
        print(f"apps.json cannot be written: {error}", file=sys.stderr)
        return 1
    print(f"Wrote {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
