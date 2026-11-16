// Real photos from Unsplash. Needs UNSPLASH_ACCESS_KEY in Vercel's environment variables.
// Unsplash asks apps to link the image from their servers, credit the photographer and Unsplash, and report when a photo is used.
module.exports = async function handler(req, res) {
  const key = process.env.UNSPLASH_ACCESS_KEY, q0 = req.query || {};
  if (q0.ping) { res.setHeader("Cache-Control", "no-store"); return res.status(200).json({ ok: !!key }); }
  if (!key) return res.status(503).json({ error: "no_key" });
  const q = String(q0.q || "").trim().slice(0, 60);
  if (!q || !/^[\p{L}\p{N} ,.'-]+$/u.test(q)) return res.status(400).json({ error: "bad_request" });
  try {
    const p = new URLSearchParams({ query: q, per_page: "1", orientation: "landscape", content_filter: "high" });
    const r = await fetch("https://api.unsplash.com/search/photos?" + p.toString(), { headers: { Authorization: "Client-ID " + key, "Accept-Version": "v1" } });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return res.status(r.status === 403 || r.status === 429 ? 429 : 502).json({ error: r.status === 403 || r.status === 429 ? "rate_limited" : "upstream" });
    const ph = (j.results || [])[0];
    if (!ph) { res.setHeader("Cache-Control", "public, s-maxage=86400"); return res.status(200).json({ ok: true, photo: null }); }
    const utm = "?utm_source=opem&utm_medium=referral";
    if (ph.links && ph.links.download_location) fetch(ph.links.download_location, { headers: { Authorization: "Client-ID " + key } }).catch(() => {});
    // the same search is answered from Vercel's cache for a week, so it does not use up the hourly limit
    res.setHeader("Cache-Control", "public, s-maxage=604800, stale-while-revalidate=2592000");
    return res.status(200).json({ ok: true, photo: {
      url: ph.urls && (ph.urls.regular || ph.urls.small), small: ph.urls && ph.urls.small, alt: String(ph.alt_description || q).slice(0, 140),
      by: ph.user ? String(ph.user.name || "").slice(0, 60) : "", byUrl: ph.user && ph.user.links ? ph.user.links.html + utm : "", page: "https://unsplash.com/" + utm } });
  } catch (e) {
    return res.status(502).json({ error: "upstream" });
  }
};
