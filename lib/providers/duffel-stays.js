// Duffel Stays: real hotel search and booking. Opem talks to Duffel only through this file,
// so another hotel supplier (HBX, Expedia) can be added later as a sibling module.
// Key: DUFFEL_ACCESS_TOKEN in Vercel. A test token (starts with "duffel_test_") books only in Duffel's test world.
const BASE = "https://api.duffel.com";
function token() { return process.env.DUFFEL_ACCESS_TOKEN || ""; }
function mode() { const t = token(); return !t ? null : /^duffel_test_/.test(t) ? "test" : "live"; }

async function call(method, path, body, ms) {
  const r = await fetch(BASE + path, {
    method, signal: AbortSignal.timeout(ms || 25000),
    headers: { "Authorization": "Bearer " + token(), "Duffel-Version": "v2", "Accept": "application/json", "Content-Type": "application/json", "Accept-Encoding": "gzip" },
    body: body ? JSON.stringify({ data: body }) : undefined
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const e0 = j && j.errors && j.errors[0] || {};
    const e = new Error(e0.message || e0.title || ("Duffel " + r.status)); e.status = r.status; e.code = e0.code || ""; throw e;
  }
  return j && j.data;
}

function money(a, c) { return a == null || a === "" ? null : { amount: +a, currency: c || "" }; }
function photo(acc) { const p = (acc && acc.photos || [])[0]; return p && p.url || ""; }
function accSummary(acc) {
  acc = acc || {}; const loc = acc.location || {}, ad = loc.address || {}, g = loc.geographic_coordinates || {};
  return { id: acc.id || "", name: acc.name || "Hotel", stars: acc.rating || null, review: acc.review_score || null, reviews: acc.review_count || null,
    photo: photo(acc), photos: (acc.photos || []).slice(0, 6).map(p => p.url).filter(Boolean),
    address: [ad.line_one, ad.city_name, ad.country_code].filter(Boolean).join(", "), lat: g.latitude, lon: g.longitude,
    amenities: (acc.amenities || []).slice(0, 8).map(a => a.description || a.type).filter(Boolean),
    check_in: acc.check_in_information || null, description: String(acc.description || "").slice(0, 600) };
}
function cancelText(tl, total) {
  tl = Array.isArray(tl) ? tl : [];
  if (!tl.length) return { refundable: false, text: "Non-refundable" };
  const full = tl.find(t => total && +t.refund_amount >= total.amount);
  if (full) return { refundable: true, until: full.before, text: "Free cancellation before " + String(full.before).slice(0, 16).replace("T", " ") + " (hotel time may differ)" };
  return { refundable: "partial", until: tl[0].before, text: "Partly refundable: " + tl.map(t => t.refund_amount + " " + t.currency + " back before " + String(t.before).slice(0, 10)).join("; ") };
}
function rateSummary(room, rate) {
  const total = money(rate.total_amount, rate.total_currency);
  return { id: rate.id, room: room.name || "Room", beds: (room.beds || []).map(b => b.count + " " + b.type).join(", "), photo: (room.photos || [])[0] && room.photos[0].url || "",
    total, base: money(rate.base_amount, rate.base_currency), tax: money(rate.tax_amount, rate.tax_currency), fee: money(rate.fee_amount, rate.fee_currency),
    at_hotel: money(rate.due_at_accommodation_amount, rate.due_at_accommodation_currency),
    board: rate.board_type || "", payment_type: rate.payment_type || "", methods: (rate.available_payment_methods || []).flat ? (rate.available_payment_methods || []).flat() : rate.available_payment_methods || [],
    cancel: cancelText(rate.cancellation_timeline, total) };
}

async function search(q) {
  const guests = []; for (let i = 0; i < q.adults; i++) guests.push({ type: "adult" });
  const d = await call("POST", "/stays/search", { rooms: q.rooms, guests, check_in_date: q.check_in, check_out_date: q.check_out,
    location: { radius: q.radius, geographic_coordinates: { latitude: q.lat, longitude: q.lon } } }, 30000);
  const results = Array.isArray(d) ? d : d && d.results || [];
  return results.map(r => Object.assign(accSummary(r.accommodation), { search_result_id: r.id,
    cheapest: money(r.cheapest_rate_total_amount, r.cheapest_rate_currency || r.cheapest_rate_total_currency),
    at_hotel: money(r.cheapest_rate_due_at_accommodation_amount, r.cheapest_rate_due_at_accommodation_currency) }))
    .filter(h => h.search_result_id && h.cheapest);
}
async function rates(searchResultId) {
  const d = await call("POST", "/stays/search_results/" + encodeURIComponent(searchResultId) + "/actions/fetch_all_rates", null, 30000);
  const acc = d && d.accommodation || {}, out = [];
  (acc.rooms || []).forEach(room => (room.rates || []).forEach(rate => out.push(rateSummary(room, rate))));
  out.sort((a, b) => (a.total ? a.total.amount : 1e12) - (b.total ? b.total.amount : 1e12));
  return { hotel: accSummary(acc), check_in: d && d.check_in_date, check_out: d && d.check_out_date, rates: out.slice(0, 30) };
}
async function quote(rateId) {
  const q = await call("POST", "/stays/quotes", { rate_id: rateId });
  const acc = q.accommodation || {}, room = (acc.rooms || [])[0] || {}, rate = (room.rates || [])[0] || {};
  return { id: q.id, hotel: accSummary(acc), check_in: q.check_in_date, check_out: q.check_out_date, rooms: q.rooms,
    total: money(q.total_amount, q.total_currency), base: money(q.base_amount, q.base_currency), tax: money(q.tax_amount, q.tax_currency), fee: money(q.fee_amount, q.fee_currency),
    at_hotel: money(q.due_at_accommodation_amount, q.due_at_accommodation_currency), deposit: money(q.deposit_amount, q.deposit_currency),
    rate: rate.id ? rateSummary(room, rate) : null };
}
function bookingSummary(b) {
  const acc = b.accommodation || {}, room = (acc.rooms || [])[0] || {}, rate = (room.rates || [])[0] || {};
  return { id: b.id, reference: b.reference || "", status: b.status || "", confirmed_at: b.confirmed_at || null, cancelled_at: b.cancelled_at || null,
    check_in: b.check_in_date, check_out: b.check_out_date, rooms: b.rooms, hotel: accSummary(acc), room: room.name || "",
    total: money(rate.total_amount, rate.total_currency), cancel: rateSummary(room, rate).cancel, key_collection: acc.key_collection && acc.key_collection.instructions || "",
    hotel_phone: acc.phone_number || "", hotel_email: acc.email || "", key: b.metadata && b.metadata.opem_key || "" };
}
async function book(p) {
  const b = await call("POST", "/stays/bookings", { quote_id: p.quote_id, guests: p.guests, email: p.email, phone_number: p.phone,
    accommodation_special_requests: p.requests || undefined, metadata: { opem_key: p.key, opem_mode: mode() } }, 45000);
  return bookingSummary(b);
}
async function get(id) { return bookingSummary(await call("GET", "/stays/bookings/" + encodeURIComponent(id))); }
async function cancel(id) { return bookingSummary(await call("POST", "/stays/bookings/" + encodeURIComponent(id) + "/actions/cancel")); }
async function findByKey(key) {   // used when the phone lost the connection during a booking
  const d = await call("GET", "/stays/bookings?limit=50");
  const list = Array.isArray(d) ? d : d && d.bookings || [];
  const hit = list.find(b => b.metadata && b.metadata.opem_key === key);
  return hit ? bookingSummary(hit) : null;
}
module.exports = { mode, search, rates, quote, book, get, cancel, findByKey };
