// Real flight prices from the Travelpayouts (Aviasales) Data API.
// Needs TRAVELPAYOUTS_TOKEN in Vercel's environment variables; TRAVELPAYOUTS_MARKER is optional (your partner id, added to the links).
// These are cached prices that other travellers found recently, not a live seat search.
module.exports = async function handler(req, res) {
  const token = process.env.TRAVELPAYOUTS_TOKEN, marker = process.env.TRAVELPAYOUTS_MARKER || "";
  const q = req.query || {};
  if (q.ping) { res.setHeader("Cache-Control", "no-store"); return res.status(200).json({ ok: !!token }); }
  if (!token) return res.status(503).json({ error: "no_key" });
  const from = String(q.from || "").toUpperCase(), to = String(q.to || "").toUpperCase();
  const depart = String(q.depart || ""), ret = String(q.ret || "");
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || !/^\d{4}-\d{2}(-\d{2})?$/.test(depart) || (ret && !/^\d{4}-\d{2}(-\d{2})?$/.test(ret)))
    return res.status(400).json({ error: "bad_request" });

  async function search(dep, back) {
    const p = new URLSearchParams({ origin: from, destination: to, departure_at: dep, currency: "nok", cy: "nok", sorting: "price", direct: "false", limit: "5", page: "1", one_way: back ? "false" : "true", unique: "false" });
    if (back) p.set("return_at", back);
    const r = await fetch("https://api.travelpayouts.com/aviasales/v3/prices_for_dates?" + p.toString(), { headers: { "X-Access-Token": token } });
    const j = await r.json().catch(() => null);
    return r.ok && j && j.success && Array.isArray(j.data) ? j.data : [];
  }
  try {
    let exact = true, data = await search(depart, ret);
    if (!data.length && depart.length === 10) { exact = false; data = await search(depart.slice(0, 7), ret ? ret.slice(0, 7) : ""); }   // nothing cached for those days: show the month
    const offers = data.slice(0, 3).map(d => ({
      price: Math.round(+d.price || 0), airline: String(d.airline || ""), depart: String(d.departure_at || ""), ret: String(d.return_at || ""),
      transfers: +d.transfers || 0, duration: +d.duration_to || +d.duration || 0,
      url: d.link ? "https://www.aviasales.com" + d.link + (marker ? (String(d.link).includes("?") ? "&" : "?") + "marker=" + encodeURIComponent(marker) : "") : ""
    })).filter(o => o.price > 0);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=7200");
    return res.status(200).json({ ok: true, exact, currency: "NOK", offers });
  } catch (e) {
    return res.status(502).json({ error: "upstream" });
  }
};
