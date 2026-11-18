// Real hotel search and booking (Duffel Stays). Only a person pressing "Confirm" in Opem's checkout can book;
// the AI can search but never book. With a test token nothing is charged and no real hotel is booked.
const duffel = require("../lib/providers/duffel-stays.js");
const hits = new Map(), booked = new Map();   // per server instance

function clip(s, n) { return String(s == null ? "" : s).slice(0, n); }
function isoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !isNaN(Date.parse(s + "T00:00:00Z")); }
function bad(res, msg) { return res.status(400).json({ error: "bad_request", detail: msg }); }

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const mode = duffel.mode();
  if (req.method === "GET") return res.status(200).json({ ok: !!mode, mode, live_booking: mode === "live" && process.env.OPEM_LIVE_BOOKING === "on" });
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!mode) return res.status(503).json({ error: "not_connected", detail: "Hotel booking isn't connected yet (no Duffel key)." });
  const origin = req.headers.origin || "", host = req.headers.host || "";
  if (origin && origin.replace(/^https?:\/\//, "") !== host) return res.status(403).json({ error: "origin" });
  const ip = clip((req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown", 60), now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  if (recent.length >= 60) return res.status(429).json({ error: "rate_limited" });
  recent.push(now); hits.set(ip, recent); if (hits.size > 5000) hits.clear();

  let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!b || typeof b.action !== "string") return bad(res, "missing action");
  try {
    if (b.action === "search") {
      const lat = +b.lat, lon = +b.lon, adults = Math.min(8, Math.max(1, parseInt(b.adults, 10) || 2)), rooms = Math.min(4, Math.max(1, parseInt(b.rooms, 10) || 1));
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return bad(res, "location");
      if (!isoDate(b.check_in) || !isoDate(b.check_out)) return bad(res, "dates");
      const nights = (Date.parse(b.check_out) - Date.parse(b.check_in)) / 864e5, ahead = (Date.parse(b.check_in) - Date.now()) / 864e5;
      if (nights < 1 || nights > 30 || ahead < -1 || ahead > 360) return bad(res, "Check-in must be in the future and the stay 1–30 nights.");
      const radius = Math.min(15, Math.max(1, +b.radius || 4));
      const list = await duffel.search({ lat, lon, radius, adults, rooms, check_in: b.check_in, check_out: b.check_out });
      return res.status(200).json({ mode, results: list.slice(0, 40) });
    }
    if (b.action === "rates") { if (!/^[\w-]{6,80}$/.test(b.search_result_id || "")) return bad(res, "id"); return res.status(200).json(Object.assign({ mode }, await duffel.rates(b.search_result_id))); }
    if (b.action === "quote") { if (!/^[\w-]{6,80}$/.test(b.rate_id || "")) return bad(res, "id"); return res.status(200).json({ mode, quote: await duffel.quote(b.rate_id) }); }
    if (b.action === "book") {
      if (mode !== "test" && process.env.OPEM_LIVE_BOOKING !== "on") return res.status(403).json({ error: "live_off", detail: "Real bookings are switched off until checkout, payment and legal checks are approved." });
      if (mode === "live") return res.status(403).json({ error: "live_off", detail: "Live card payment isn't built yet." });
      const key = clip(b.key, 60), g = b.guest || {};
      if (!/^[\w-]{10,60}$/.test(key) || !/^[\w-]{6,80}$/.test(b.quote_id || "")) return bad(res, "ids");
      const given = clip(g.given_name, 60).trim(), family = clip(g.family_name, 60).trim(), email = clip(b.email, 120).trim(), phone = clip(b.phone, 30).replace(/[^\d+]/g, "");
      if (!given || !family || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !/^\+\d{6,15}$/.test(phone)) return bad(res, "Fill in first name, last name, a valid email and a phone number with country code (+47…).");
      if (b.confirmed !== true) return bad(res, "not confirmed");
      if (booked.has(key)) return res.status(200).json({ mode, booking: booked.get(key), repeat: true });
      try {
        const bk = await duffel.book({ quote_id: b.quote_id, key, email, phone, guests: [{ given_name: given, family_name: family }], requests: clip(b.requests, 300) });
        booked.set(key, bk); return res.status(200).json({ mode, booking: bk });
      } catch (e) {
        // if the booking actually went through before the error, find it instead of booking twice
        const found = await duffel.findByKey(key).catch(() => null);
        if (found) { booked.set(key, found); return res.status(200).json({ mode, booking: found, recovered: true }); }
        throw e;
      }
    }
    if (b.action === "find") { if (!/^[\w-]{10,60}$/.test(b.key || "")) return bad(res, "key"); return res.status(200).json({ mode, booking: await duffel.findByKey(b.key) }); }
    if (b.action === "get") { if (!/^[\w-]{6,80}$/.test(b.id || "")) return bad(res, "id"); return res.status(200).json({ mode, booking: await duffel.get(b.id) }); }
    if (b.action === "cancel") { if (!/^[\w-]{6,80}$/.test(b.id || "") || b.confirmed !== true) return bad(res, "id"); return res.status(200).json({ mode, booking: await duffel.cancel(b.id) }); }
    return bad(res, "unknown action");
  } catch (e) {
    const st = e.status === 429 ? 429 : e.status === 422 || e.status === 400 || e.status === 404 ? 409 : 502;
    return res.status(st).json({ error: e.code || "supplier", detail: clip(e.message, 240) });
  }
};
