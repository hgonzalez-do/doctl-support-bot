// doctl Support Bot — runs on DigitalOcean App Platform.
//
// Request flow for POST /api/chat:
//   1. Retrieve the most relevant chunks from a Gradient Knowledge Base
//      (POST https://kbaas.do-ai.run/v1/<KB_UUID>/retrieve).
//   2. Ask a model on DigitalOcean Serverless Inference to answer using only
//      those chunks (POST https://inference.do-ai.run/v1/chat/completions).
//   3. Return the answer plus the source documents that were used.
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
  doApiToken: process.env.DO_API_TOKEN || "",
  kbUuid: process.env.KB_UUID || "",
  modelAccessKey: process.env.MODEL_ACCESS_KEY || "",
  model: process.env.INFERENCE_MODEL || "anthropic-claude-haiku-4.5",
  inferenceBaseUrl: (process.env.INFERENCE_BASE_URL || "https://inference.do-ai.run").replace(/\/$/, ""),
  kbBaseUrl: (process.env.KB_RETRIEVE_BASE_URL || "https://kbaas.do-ai.run").replace(/\/$/, ""),
  numResults: Number(process.env.KB_NUM_RESULTS || 6),
  alpha: Number(process.env.KB_ALPHA || 0.5),
};

const SYSTEM_PROMPT = `You are the doctl support assistant. doctl is DigitalOcean's command-line tool.
Answer the user's question using ONLY the context documents provided. The context comes from
release notes and docs curated from https://github.com/digitalocean/doctl/releases.

Rules:
- Be concise and specific. Mention version numbers (tags) and dates when relevant.
- When you use a document, cite it inline like [source: <item_name>].
- If the context does not contain the answer, say so plainly and point the user to
  https://docs.digitalocean.com/reference/doctl/ . Never invent versions, flags, or dates.`;

// ---------------------------------------------------------------------------
// DigitalOcean calls
// ---------------------------------------------------------------------------

async function retrieveFromKnowledgeBase(query) {
  if (!cfg.doApiToken || !cfg.kbUuid) {
    throw new Error("Server is missing DO_API_TOKEN or KB_UUID");
  }
  const res = await fetch(`${cfg.kbBaseUrl}/v1/${cfg.kbUuid}/retrieve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.doApiToken}`,
    },
    body: JSON.stringify({ query, num_results: cfg.numResults, alpha: cfg.alpha }),
  });
  if (!res.ok) {
    throw new Error(`Knowledge base retrieve failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return (data.results || []).map((r) => ({
    text: r.text_content || r.text || "",
    item_name: r.metadata?.item_name || "unknown",
    score: r.score ?? r.metadata?.score ?? null,
  }));
}

async function chatCompletion(messages) {
  if (!cfg.modelAccessKey) {
    throw new Error("Server is missing MODEL_ACCESS_KEY");
  }
  const res = await fetch(`${cfg.inferenceBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.modelAccessKey}`,
    },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2, max_tokens: 800 }),
  });
  if (!res.ok) {
    throw new Error(`Serverless Inference failed: ${res.status} ${await res.text()}`);
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

function buildContext(chunks) {
  return chunks
    .map((c, i) => `--- Document ${i + 1} (item_name: ${c.item_name}) ---\n${c.text}`)
    .join("\n\n");
}

async function handleChat(body) {
  const message = String(body.message || "").trim();
  if (!message) return { status: 400, json: { error: "message is required" } };

  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const started = Date.now();

  const chunks = await retrieveFromKnowledgeBase(message);
  const retrieveMs = Date.now() - started;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content),
    {
      role: "user",
      content: `Context documents:\n\n${buildContext(chunks) || "(no documents found)"}\n\nQuestion: ${message}`,
    },
  ];

  const answer = await chatCompletion(messages);
  const totalMs = Date.now() - started;

  // De-duplicate sources by item_name, keep a short snippet for the UI.
  const seen = new Set();
  const sources = [];
  for (const c of chunks) {
    if (seen.has(c.item_name)) continue;
    seen.add(c.item_name);
    sources.push({ item_name: c.item_name, snippet: c.text.slice(0, 240) });
  }

  return {
    status: 200,
    json: {
      answer: answer.text,
      sources,
      model: cfg.model,
      usage: answer.usage,
      timing_ms: { retrieve: retrieveMs, total: totalMs },
    },
  };
}

async function handleReleases() {
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
      knowledge_base_configured: Boolean(cfg.kbUuid && cfg.doApiToken),
      inference_configured: Boolean(cfg.modelAccessKey),
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
  console.log(`doctl-support-bot listening on :${cfg.port} (model=${cfg.model}, kb=${cfg.kbUuid ? "set" : "MISSING"})`);
});
