// doctl Support Bot — runs on DigitalOcean App Platform.
//
// Request flow for POST /api/chat: one call to a Gradient AI agent endpoint
// (POST <AGENT_ENDPOINT>/api/v1/chat/completions). The agent owns the knowledge base and
// does retrieval and generation on its side, so this service holds a single credential —
// that agent's access key — and no DigitalOcean API token at all.
//
// The assistant's persona and answering rules live in the agent's instruction
// (chat-agent/instruction.md in the curator repo), not here: changing how it answers is an
// agent update, not a redeploy.
//
// Node stdlib only — no npm install needed.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DOCS_DIR = path.join(__dirname, "docs");

const cfg = {
  port: Number(process.env.PORT || 8080),
  // e.g. https://<id>.agents.do-ai.run — `deployment.url` of the Gradient agent.
  agentEndpoint: (process.env.AGENT_ENDPOINT || "").replace(/\/$/, ""),
  // Scoped to that one agent. Not a dop_/doo_ DigitalOcean token and not interchangeable with one.
  agentAccessKey: process.env.AGENT_ACCESS_KEY || "",
  model: process.env.AGENT_MODEL || "llama-4-maverick",
  maxTokens: Number(process.env.AGENT_MAX_TOKENS || 800),
  // Optional: fetch the release index from GitHub (raw URL) so the "docs current through"
  // badge reflects the curator's latest push immediately. The app is not redeployed when the
  // curator pushes, so the docs/ copy on disk is a snapshot from deploy time; this URL is how
  // the badge stays current. Answers never come from either — only from the knowledge base.
  releaseIndexUrl: process.env.RELEASE_INDEX_URL || "",
};

// ---------------------------------------------------------------------------
// Gradient agent endpoint
// ---------------------------------------------------------------------------

async function askAgent(messages) {
  if (!cfg.agentEndpoint || !cfg.agentAccessKey) {
    throw new Error("Server is missing AGENT_ENDPOINT or AGENT_ACCESS_KEY");
  }
  const res = await fetch(`${cfg.agentEndpoint}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.agentAccessKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: false,
      temperature: 0.2,
      max_tokens: cfg.maxTokens,
    }),
  });
  if (!res.ok) {
    throw new Error(`Agent endpoint failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    usage: data.usage || null,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleChat(body) {
  const message = String(body.message || "").trim();
  if (!message) return { status: 400, json: { error: "message is required" } };

  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const started = Date.now();

  // No system message: the agent carries its own instruction. Retrieval happens inside the
  // agent, and the retrieved documents are deliberately not surfaced to the caller.
  const answer = await askAgent([
    ...history.filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content),
    { role: "user", content: message },
  ]);

  return {
    status: 200,
    json: {
      answer: answer.text,
      model: cfg.model,
      usage: answer.usage,
      timing_ms: { total: Date.now() - started },
    },
  };
}

let releaseIndexCache = { at: 0, json: null };

async function handleReleases() {
  if (cfg.releaseIndexUrl) {
    if (Date.now() - releaseIndexCache.at < 60_000 && releaseIndexCache.json) {
      return { status: 200, json: releaseIndexCache.json };
    }
    try {
      const res = await fetch(cfg.releaseIndexUrl, { headers: { "Cache-Control": "no-cache" } });
      if (res.ok) {
        releaseIndexCache = { at: Date.now(), json: await res.json() };
        return { status: 200, json: releaseIndexCache.json };
      }
    } catch (err) {
      console.warn(`release index fetch failed, using deploy-time copy (may be stale): ${err.message}`);
    }
  }
  try {
    const raw = await readFile(path.join(DOCS_DIR, "release-index.json"), "utf8");
    return { status: 200, json: JSON.parse(raw) };
  } catch {
    return { status: 404, json: { error: "docs/release-index.json not found" } };
  }
}

function handleHealth() {
  return {
    status: 200,
    json: {
      ok: true,
      model: cfg.model,
      agent_endpoint_configured: Boolean(cfg.agentEndpoint && cfg.agentAccessKey),
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      const r = handleHealth();
      return sendJson(res, r.status, r.json);
    }
    if (req.method === "GET" && url.pathname === "/api/releases") {
      const r = await handleReleases();
      return sendJson(res, r.status, r.json);
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const r = await handleChat(await readJsonBody(req));
      return sendJson(res, r.status, r.json);
    }
    if (req.method === "GET") return serveStatic(res, url.pathname);
    return sendJson(res, 405, { error: "method not allowed" });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message || "internal error" });
  }
});

server.listen(cfg.port, () => {
  console.log(`doctl-support-bot listening on :${cfg.port} (model=${cfg.model}, agent endpoint=${cfg.agentEndpoint || "MISSING"})`);
});
