#!/usr/bin/env python3
"""Release-notes tooling used by the docs curator agent (and by humans).

Subcommands
  fetch      Print releases newer than a tag as JSON (what the agent reads).
  bootstrap  Seed docs/ from the last N stable releases (one-time setup).
  index      Rebuild docs/release-index.json, docs/changelog.md and
             docs/curator-state.json from docs/releases/*.md (run after edits).
  rewind     Delete the N newest release docs, then re-index. Used to stage a
             live demo so the agent has visible work to do.

Only the Python standard library is used.
"""

import argparse
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
RELEASES_DIR = DOCS / "releases"
STATE_FILE = DOCS / "curator-state.json"
INDEX_FILE = DOCS / "release-index.json"
CHANGELOG_FILE = DOCS / "changelog.md"

SOURCE_REPO = os.environ.get("SOURCE_REPO", "digitalocean/doctl")
API = f"https://api.github.com/repos/{SOURCE_REPO}/releases"

# Matches lines such as: "* 77264ed8bc03... agents: allow coding-hermes ..."
COMMIT_LINE = re.compile(r"^\s*[\*\-]\s*([0-9a-f]{7,40})\s+(.*)$")
PR_REF = re.compile(r"(?:#|/pull/)(\d+)")


# --------------------------------------------------------------------------- GitHub

def github_get(url):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "doctl-support-bot-curator"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
        return json.load(r)


def list_releases(stable_only=True, per_page=100):
    releases = github_get(f"{API}?per_page={per_page}")
    releases = [r for r in releases if not r.get("draft")]
    if stable_only:
        releases = [r for r in releases if not r.get("prerelease")]
    # GitHub returns newest first; keep it that way.
    return [normalize(r) for r in releases]


def parse_body(body, html_url):
    """Turn the release body into structured change entries."""
    repo_url = f"https://github.com/{SOURCE_REPO}"
    entries = []
    for line in (body or "").splitlines():
        m = COMMIT_LINE.match(line)
        if m:
            sha, message = m.group(1), m.group(2).strip()
            pr = PR_REF.search(message)
            entries.append({
                "sha": sha[:7],
                "message": message,
                "commit_url": f"{repo_url}/commit/{sha}",
                "pr_url": f"{repo_url}/pull/{pr.group(1)}" if pr else None,
            })
        elif line.strip().startswith(("*", "-")) and len(line.strip()) > 2:
            text = line.strip()[1:].strip()
            pr = PR_REF.search(text)
            entries.append({"sha": None, "message": text, "commit_url": None,
                            "pr_url": f"{repo_url}/pull/{pr.group(1)}" if pr else None})
    return entries


def normalize(r):
    return {
        "tag": r["tag_name"],
        "name": r.get("name") or r["tag_name"],
        "published_at": r.get("published_at"),
        "prerelease": bool(r.get("prerelease")),
        "url": r["html_url"],
        "body": r.get("body") or "",
        "changes": parse_body(r.get("body"), r["html_url"]),
    }


# --------------------------------------------------------------------------- docs I/O

def read_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"source_repo": SOURCE_REPO, "last_processed_tag": None, "last_processed_published_at": None}


def parse_release_doc(path):
    """Read front matter + '## Summary' paragraph from a release markdown file."""
    text = path.read_text()
    fm = {}
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    body = text
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                fm[k.strip()] = v.strip().strip('"')
        body = m.group(2)
    summary = ""
    sm = re.search(r"^## Summary\s*\n(.*?)(?=\n## |\Z)", body, re.S | re.M)
    if sm:
        summary = " ".join(sm.group(1).strip().split())
    fm.setdefault("tag", path.stem)
    fm["prerelease"] = str(fm.get("prerelease", "false")).lower() == "true"
    fm["summary"] = summary
    fm["doc"] = f"docs/releases/{path.name}"
    fm["change_count"] = len(re.findall(r"^\s*[-*] ", body.split("## Changes")[-1], re.M)) if "## Changes" in body else 0
    return fm


def write_release_doc(rel):
    """Deterministic page used by `bootstrap`; the agent writes richer pages for new releases."""
    RELEASES_DIR.mkdir(parents=True, exist_ok=True)
    date = (rel["published_at"] or "")[:10]
    n = len(rel["changes"])
    summary = (
        f"doctl {rel['tag']} was published on {date} and includes {n} change{'s' if n != 1 else ''}. "
        f"This summary was generated automatically during bootstrap; the curator agent writes "
        f"human-readable summaries for new releases."
    )
    lines = [
        "---",
        f"tag: {rel['tag']}",
        f"name: {rel['name']}",
        f"published_at: {rel['published_at']}",
        f"prerelease: {str(rel['prerelease']).lower()}",
        f"url: {rel['url']}",
        "---",
        "",
        f"# doctl {rel['tag']}",
        "",
        f"Released {date}. Source: {rel['url']}",
        "",
        "## Summary",
        "",
        summary,
        "",
        "## Changes",
        "",
    ]
    for c in rel["changes"] or [{"message": "No itemized changes in the release notes.", "commit_url": None, "sha": None, "pr_url": None}]:
        link = f" ([{c['sha']}]({c['commit_url']}))" if c.get("sha") else ""
        pr = f" [PR]({c['pr_url']})" if c.get("pr_url") else ""
        lines.append(f"- {c['message']}{link}{pr}")
    lines += ["", "## Upgrade notes", "", "No breaking changes were called out in the release notes.", ""]
    path = RELEASES_DIR / f"{rel['tag']}.md"
    path.write_text("\n".join(lines))
    return path


def build_index():
    docs = sorted(
        (parse_release_doc(p) for p in RELEASES_DIR.glob("*.md")),
        key=lambda d: d.get("published_at") or "",
        reverse=True,
    )
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    index = {
        "source_repo": SOURCE_REPO,
        "generated_at": now,
        "latest": docs[0]["tag"] if docs else None,
        "release_count": len(docs),
        "releases": [
            {k: d.get(k) for k in ("tag", "name", "published_at", "prerelease", "url", "summary", "doc", "change_count")}
            for d in docs
        ],
    }
    INDEX_FILE.write_text(json.dumps(index, indent=2) + "\n")

    lines = [
        "# doctl changelog",
        "",
        f"Curated from https://github.com/{SOURCE_REPO}/releases. Newest first. "
        f"Each entry links to a detailed release page.",
        "",
    ]
    for d in docs:
        lines.append(f"## {d['tag']} — {(d.get('published_at') or '')[:10]}")
        lines.append("")
        lines.append(d["summary"] or "(no summary)")
        lines.append("")
        lines.append(f"Details: [{d['doc']}]({d['doc'].replace('docs/', '')}) · [GitHub release]({d.get('url')})")
        lines.append("")
    CHANGELOG_FILE.write_text("\n".join(lines))

    state = read_state()
    state["source_repo"] = SOURCE_REPO
    state["last_processed_tag"] = docs[0]["tag"] if docs else None
    state["last_processed_published_at"] = docs[0].get("published_at") if docs else None
    state["last_indexed_at"] = now
    STATE_FILE.write_text(json.dumps(state, indent=2) + "\n")
    return index


# --------------------------------------------------------------------------- commands

def cmd_fetch(args):
    releases = list_releases(stable_only=not args.include_prereleases)
    since = args.since or read_state().get("last_processed_tag")
    since_at = read_state().get("last_processed_published_at")
    new = []
    for r in releases:
        if since and r["tag"] == since:
            break
        if not since and since_at and r["published_at"] <= since_at:
            break
        new.append(r)
    else:
        # `since` tag not found in the fetched window: fall back to timestamp.
        if since and since_at:
            new = [r for r in releases if r["published_at"] > since_at]
    new = new[: args.limit] if args.limit else new
    new.reverse()  # oldest first, so docs are written in order
    json.dump({"since": since, "count": len(new), "releases": new}, sys.stdout, indent=2)
    print()


def cmd_bootstrap(args):
    releases = list_releases(stable_only=True)[: args.count]
    for r in reversed(releases):
        write_release_doc(r)
    idx = build_index()
    print(f"Seeded {len(releases)} release docs. Latest: {idx['latest']}")


def cmd_index(_args):
    idx = build_index()
    print(f"Indexed {idx['release_count']} releases. Latest: {idx['latest']}")


def cmd_rewind(args):
    docs = sorted(RELEASES_DIR.glob("*.md"), key=lambda p: parse_release_doc(p).get("published_at") or "", reverse=True)
    removed = []
    for p in docs[: args.count]:
        removed.append(p.name)
        p.unlink()
    idx = build_index()
    print(f"Removed {removed}. Docs now current through {idx['latest']}.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="print releases newer than the last processed tag as JSON")
    f.add_argument("--since", help="tag to start after (default: docs/curator-state.json)")
    f.add_argument("--limit", type=int, default=0, help="max releases to return (0 = all)")
    f.add_argument("--include-prereleases", action="store_true")
    f.set_defaults(func=cmd_fetch)

    b = sub.add_parser("bootstrap", help="seed docs/ from the last N stable releases")
    b.add_argument("--count", type=int, default=5)
    b.set_defaults(func=cmd_bootstrap)

    sub.add_parser("index", help="rebuild release-index.json, changelog.md, curator-state.json").set_defaults(func=cmd_index)

    r = sub.add_parser("rewind", help="delete the N newest release docs and re-index (demo staging)")
    r.add_argument("--count", type=int, default=1)
    r.set_defaults(func=cmd_rewind)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
