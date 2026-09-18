# curator/ — tooling for the Managed Agent, not for the app

Nothing in this folder runs on App Platform. The web service is `node server.js` and only
reads the knowledge base and calls Serverless Inference.

These files are used by the **docs curator**, a DigitalOcean Managed Agent that clones this
repo on a weekly schedule (and by an operator staging a demo):

| File | Who runs it | What it does |
|---|---|---|
| `releases.py` | the agent | `fetch` new doctl releases as JSON; `index` regenerates `docs/release-index.json`, `docs/changelog.md` and the bookmark; `bootstrap` / `rewind` for setup and demo staging |
| `sync-docs-to-spaces.sh` | the agent | mirrors `docs/` to the Spaces bucket behind the knowledge base (`aws s3 sync --delete`) |
| `reindex-kb.sh` | the agent | starts a knowledge-base indexing job and waits for it |

The agent's runbook, spec and deployment scripts live in the companion repo
[managed-agents-kb-curator-demo](https://github.com/hgonzalez-do/managed-agents-kb-curator-demo).
