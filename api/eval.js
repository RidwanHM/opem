// Test runner for Opem's AI: runs a few of the 50 test conversations and has a judge score the answers.
// Example: /api/eval?from=0&n=4&model=haiku   (capped per day so it can't run up the bill)
const { runChat, SONNET, clip } = require("../lib/opem-ai.js");
const SET = require("../lib/eval-set.js");
const CITIES = require("../lib/cities.json");
let runs = 0, stamp = "";
const PRICE = { "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5] };   // USD per million tokens (in, out)

const CONTEXT = "The traveller usually flies from Oslo (OSL) unless they say otherwise.\nNo saved travel profile yet.\nThey are looking at the globe.\nCities on Opem's map (id: name, country): " + CITIES.map(c => c[0] + ": " + c[1] + ", " + c[2]).join("; ");

async function judge(sc, out) {
  const key = process.env.ANTHROPIC_API_KEY;
  const prompt = "You grade a travel assistant's reply. Be strict and fair.\n\nConversation:\n" + sc.m.map(x => x.role + ": " + x.content).join("\n") +
    "\n\nWhat a good reply does: " + sc.expect + "\n\nThe assistant's reply:\n" + (out.text || "(no text)") + "\n\nApp actions it took: " + (out.acts.length ? out.acts.map(a => a.name + " " + JSON.stringify(a.input).slice(0, 200)).join("; ") : "none") +
    "\nTools it used: " + (out.tools.join(", ") || "none") +
    "\n\nReturn only JSON: {\"relevance\":1-5,\"accuracy\":1-5,\"helpfulness\":1-5,\"tools\":1-5,\"tone_length\":1-5,\"invented_live_facts\":true/false,\"wrong_language\":true/false,\"note\":\"one short sentence\"}";
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: AbortSignal.timeout(40000), headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: SONNET, max_tokens: 300, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json().catch(() => null); const t = j && j.content && j.content[0] && j.content[0].text || "";
  try { return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch (e) { return { note: "judge failed: " + clip(t || (j && j.error && j.error.message), 120) }; }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "no_key" });
  const q = req.query || {}, today = new Date().toISOString().slice(0, 10);
  if (today !== stamp) { stamp = today; runs = 0; }
  if (q.list) return res.status(200).json({ count: SET.length, simple: SET.filter(s => s.simple).length, ids: SET.map(s => s.id) });
  if (++runs > 40) return res.status(429).json({ error: "daily test limit reached" });
  const from = Math.max(0, parseInt(q.from, 10) || 0), n = Math.min(5, Math.max(1, parseInt(q.n, 10) || 3));
  const pool = q.only === "simple" ? SET.filter(s => s.simple) : q.only === "complex" ? SET.filter(s => !s.simple) : SET;
  const model = q.model === "haiku" ? "haiku" : "sonnet";
  const batch = pool.slice(from, from + n);
  const results = await Promise.all(batch.map(async sc => {
    const acts = [], t0 = Date.now();
    try {
      const out = await runChat({ messages: sc.m, context: CONTEXT, cityIds: CITIES.map(c => c[0]), model, emit: e => { if (e.t === "act") acts.push(e); } });
      const ms = Date.now() - t0, pr = PRICE[out.model] || [2, 10], u = out.usage;
      const cost = (u.input * pr[0] + u.cache_read * pr[0] * 0.1 + u.cache_write * pr[0] * 1.25 + u.output * pr[1]) / 1e6 + u.searches * 0.01;
      const grade = await judge(sc, { text: out.text, acts, tools: out.tools });
      return { id: sc.id, model: out.model, ms, cost_usd: +cost.toFixed(4), tools: out.tools, acts: acts.map(a => a.name), answer: clip(out.text, 700), grade };
    } catch (e) { return { id: sc.id, model, error: clip(e.detail || e.message, 200) }; }
  }));
  return res.status(200).json({ from, n: batch.length, total: pool.length, results });
};
