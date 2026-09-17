# doctl support knowledge

This folder is the knowledge base behind the doctl Support Bot. It is indexed by a
DigitalOcean Gradient Knowledge Base (via a Spaces bucket) and kept current by a
DigitalOcean Managed Agent that runs on a weekly schedule.

Layout:

- `changelog.md` — rolling, newest-first summary of every doctl release we track.
- `releases/<tag>.md` — one page per release: summary, itemized changes with commit links, upgrade notes.
- `release-index.json` — machine-readable index of the releases (served by the bot at `/api/releases`).
- `curator-state.json` — bookmark of the last release the curator processed. Do not edit by hand.

How it is maintained:

1. The curator agent runs `scripts/releases.py fetch` to find releases newer than the bookmark.
2. It writes a `releases/<tag>.md` page per new release with a human-readable summary.
3. It runs `scripts/releases.py index` to regenerate `changelog.md`, `release-index.json` and the bookmark.
4. It commits and pushes, syncs this folder to Spaces, and triggers a knowledge-base re-index.

Source of truth: https://github.com/digitalocean/doctl/releases
