// Real places to stay from OpenStreetMap (via the public Overpass API). No key needed.
// Returns names and positions only: OpenStreetMap has no prices, ratings or photos.
module.exports = async function handler(req, res) {
  const q = req.query || {};
  if (q.ping) { res.setHeader("Cache-Control", "no-store"); return res.status(200).json({ ok: true }); }
  const s = +q.s, w = +q.w, n = +q.n, e = +q.e;
  if (![s, w, n, e].every(Number.isFinite) || s >= n || w >= e || n - s > 1.2 || e - w > 1.2 || Math.abs(s) > 90 || Math.abs(n) > 90 || Math.abs(w) > 180 || Math.abs(e) > 180)
    return res.status(400).json({ error: "bad_request" });
  const box = [s, w, n, e].map(v => v.toFixed(4)).join(",");
  const filter = '["tourism"~"^(hotel|guest_house|hostel|apartment|resort)$"]["name"]';
  const query = "[out:json][timeout:20];(node" + filter + "(" + box + ");way" + filter + "(" + box + "););out center tags 400;";
  try {
    const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Opem travel prototype (opem-six.vercel.app)" }, body: "data=" + encodeURIComponent(query) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !Array.isArray(j.elements)) return res.status(r.status === 429 ? 429 : 502).json({ error: r.status === 429 ? "rate_limited" : "upstream" });
    let all = j.elements.map(el => {
      const t = el.tags || {}, lat = el.lat != null ? el.lat : el.center && el.center.lat, lon = el.lon != null ? el.lon : el.center && el.center.lon;
      const name = String(t["name:en"] || t.name || "").trim();
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || name.length > 60 || !/[A-Za-z]/.test(name)) return null;
      const stars = parseInt(t.stars, 10);
      return { id: el.type[0] + el.id, name, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, type: t.tourism, stars: stars >= 1 && stars <= 5 ? stars : 0,
        score: (stars ? 2 : 0) + (t.website || t["contact:website"] ? 1 : 0) + (t.wikidata ? 2 : 0) + (t.phone || t["contact:phone"] ? 0.5 : 0) };
    }).filter(Boolean);
    const seen = new Set(); all = all.filter(a => { const k = a.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    // keep the better-documented places, then spread the picks across the area so they are not all in one street
    all.sort((a, b) => b.score - a.score); const pool = all.slice(0, 120), picks = [];
    const d2 = (a, b) => (a.lat - b.lat) ** 2 + ((a.lon - b.lon) * Math.cos(a.lat * Math.PI / 180)) ** 2;
    while (pool.length && picks.length < 14) {
      let bi = 0, bv = -1;
      pool.forEach((c, i) => { const near = picks.length ? Math.min(...picks.map(p => d2(p, c))) : 1; const v = near * (1 + c.score); if (v > bv) { bv = v; bi = i; } });
      picks.push(pool.splice(bi, 1)[0]);
    }
    res.setHeader("Cache-Control", "public, s-maxage=604800, stale-while-revalidate=2592000");
    return res.status(200).json({ ok: true, total: all.length, stays: picks.map(p => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, type: p.type, stars: p.stars })) });
  } catch (err) {
    return res.status(502).json({ error: "upstream" });
  }
};
