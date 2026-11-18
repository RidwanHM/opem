// Opem's live chat: checks the request, then streams the AI's answer as lines of JSON
// ({"t":"text"} words, {"t":"status"} what he is checking, {"t":"act"} globe/app actions, {"t":"meta"} usage).
// The API key lives only in Vercel (ANTHROPIC_API_KEY). It is never sent to the browser.
const { runChat, SONNET, HAIKU, clip } = require("../lib/opem-ai.js");
const hits = new Map();
let dayCount = 0, dayStamp = "";

// Simple questions can go to the fast model once tests show it is good enough (OPEM_ROUTING=on in Vercel).
function pickModel(messages, images) {
  if (process.env.OPEM_ROUTING !== "on" || images.length) return "sonnet";
  const last = String(messages[messages.length - 1].content || "");
  if (last.length > 140 || messages.length > 6) return "sonnet";
  if (/plan|itiner|budget|budsjett|book|bestill|reiserute|days|dager|nights|netter|compare|sammenlign|route|rute|cheap|billig|flight|fly|weather|vær|when|når|visa|hotel/i.test(last)) return "sonnet";
  return "haiku";
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === "GET") return res.status(200).json({ ok: !!key, model: SONNET, fast: process.env.OPEM_ROUTING === "on" ? HAIKU : null });
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!key) return res.status(503).json({ error: "no_key" });

  const origin = req.headers.origin || "", host = req.headers.host || "";
  if (origin && origin.replace(/^https?:\/\//, "") !== host) return res.status(403).json({ error: "origin" });

  const ip = clip((req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown", 60), now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  if (recent.length >= 30) return res.status(429).json({ error: "rate_limited" });
  recent.push(now); hits.set(ip, recent); if (hits.size > 5000) hits.clear();
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayStamp) { dayStamp = today; dayCount = 0; }
  if (++dayCount > 3000) return res.status(429).json({ error: "rate_limited" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !Array.isArray(body.messages)) return res.status(400).json({ error: "bad_request" });
  const messages = body.messages.slice(-14)
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: clip(m.content, 3000) }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  // merge accidental double turns so roles alternate
  for (let i = messages.length - 1; i > 0; i--) if (messages[i].role === messages[i - 1].role) { messages[i - 1].content += "\n\n" + messages[i].content; messages.splice(i, 1); }
  if (!messages.length || messages[messages.length - 1].role !== "user") return res.status(400).json({ error: "bad_request" });
  const imgs = (Array.isArray(body.images) ? body.images : []).slice(0, 4)
    .filter(i => i && /^image\/(jpeg|png|webp|gif)$/.test(i.media_type) && typeof i.data === "string" && i.data.length < 1800000 && /^[A-Za-z0-9+/=]+$/.test(i.data.slice(0, 200)));
  if (imgs.length) {
    const last = messages[messages.length - 1];
    last.content = imgs.map(i => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })).concat([{ type: "text", text: last.content }]);
  }
  const cityIds = (Array.isArray(body.cityIds) ? body.cityIds : []).slice(0, 300).map(x => clip(x, 40));

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("X-Accel-Buffering", "no");
  const emit = ev => { try { res.write(JSON.stringify(ev) + "\n"); } catch (e) {} };
  try {
    await runChat({ messages, context: body.context, cityIds, model: pickModel(messages, imgs), emit });
  } catch (e) {
    emit({ t: "error", status: e.status || 502, v: e.status === 503 ? "no_key" : e.status === 429 ? "rate_limited" : "upstream", detail: clip(e.detail || e.message, 200) });
  }
  res.end();
};
