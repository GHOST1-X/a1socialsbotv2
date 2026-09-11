// owlet.js
// Wrapper around the Owlet backend API (single POST endpoint, action-based).
// Base: https://a1socials.mysocials.store/api/store-v2
// Every request body is { key, action, ...params }.
//
// NOTE ON FIELD NAMES: only the request/response *shape* for each action was
// shared (e.g. "{ add: service, link, quantity }"), not a sample service
// object or a sample order-status object. normalizeService() and
// checkOrderStatus() below read every plausible field name defensively so
// the bot doesn't break on a naming mismatch, but this should be verified
// against one real `services` and one real `status` response and trimmed
// down once confirmed — see the console.warn calls, which will fire once
// each on first use if a field can't be found under any of the guessed names.

const OWLET_BASE = process.env.OWLET_BASE_URL || "https://a1socials.mysocials.store/api/store-v2";
// Hardcoded test-only fallback — override via env var in production.
// See earlier chat warning: rotate this once testing is done.
const OWLET_KEY = process.env.OWLET_API_KEY || "msk_ncy8OJIF7uehlIXouCi6DNWhEGeD-439";
const TIMEOUT_MS = 15000;

async function owletCall(action, params = {}, { retries = 0 } = {}) {
  if (!OWLET_KEY) return { httpOk: false, error: "OWLET_API_KEY not set" };

  // Retries are opt-in and ONLY safe for idempotent read actions (balance,
  // services, status). "add" (placing an order) must never auto-retry here —
  // a timeout doesn't mean the order wasn't placed, and retrying could
  // create a duplicate paid order. Callers control that explicitly.
  let attempt = 0;
  let lastError;
  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(OWLET_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: OWLET_KEY, action, ...params }),
        signal: controller.signal,
      });
      let data = {};
      try { data = await res.json(); } catch (_) {}
      clearTimeout(timer);
      if (!res.ok && res.status >= 500 && attempt < retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 300 * 2 ** (attempt - 1)));
        continue;
      }
      return { httpOk: res.ok, ...data };
    } catch (e) {
      clearTimeout(timer);
      const isTimeout = e && e.name === "AbortError";
      lastError = { httpOk: false, timeout: isTimeout, error: e.message };
      if (isTimeout || attempt >= retries) return lastError;
      attempt++;
      await new Promise((r) => setTimeout(r, 300 * 2 ** (attempt - 1)));
    }
  }
  return lastError;
}

function isTimeoutRes(res) {
  return res && res.timeout === true;
}

// ---------- Services cache ----------
// The full catalog is likely large and rarely changes within a session —
// cache it so browsing the menu doesn't hit the API on every tap.
const SERVICES_CACHE_TTL_MS = 5 * 60 * 1000;
let servicesCache = null; // { services, ts }
let warnedServiceFields = false;

function normalizeService(s) {
  const id = s.service_id ?? s.id ?? s.service ?? s.serviceId;
  const rate = Number(s.rate ?? s.price ?? s.cost ?? s.price_per_1000 ?? 0);
  if ((id === undefined || !rate) && !warnedServiceFields) {
    warnedServiceFields = true;
    console.warn("[owlet] Unrecognized service object shape — verify field names:", JSON.stringify(s).slice(0, 300));
  }
  return {
    id,
    name: s.name ?? s.service_name ?? s.title ?? "Service",
    category: s.category ?? s.platform ?? s.type ?? "Other",
    rate, // price per 1000 units, in Naira (assumed — verify against a real response)
    min: Number(s.min ?? s.min_quantity ?? s.min_order ?? 1),
    max: Number(s.max ?? s.max_quantity ?? s.max_order ?? 100000),
  };
}

async function fetchServices() {
  if (servicesCache && Date.now() - servicesCache.ts < SERVICES_CACHE_TTL_MS) {
    return { ok: true, services: servicesCache.services };
  }
  const res = await owletCall("services", {}, { retries: 2 });
  if (isTimeoutRes(res) || !res.httpOk) return { ok: false, services: [] };
  const raw = res.services ?? res.data ?? (Array.isArray(res) ? res : null);
  if (!Array.isArray(raw)) return { ok: false, services: [] };
  const services = raw.map(normalizeService).filter((s) => s.id !== undefined);
  servicesCache = { services, ts: Date.now() };
  return { ok: true, services };
}

function servicePrice(service, quantity) {
  return Math.ceil((service.rate / 1000) * quantity);
}

async function placeOrder({ service, link, quantity }) {
  const res = await owletCall("add", { service, link, quantity });
  if (isTimeoutRes(res)) return { ok: false, timeout: true, order: null };
  const orderId = res.order ?? res.data?.order ?? res.order_id ?? null;
  const ok = !!(res.httpOk && orderId && !res.error);
  return {
    ok,
    order: orderId,
    message: ok ? null : res.error || res.message || "Order could not be placed.",
  };
}

async function checkOrderStatus(order) {
  const res = await owletCall("status", { order });
  if (isTimeoutRes(res)) return { ok: false, timeout: true };
  const d = res.data ?? res;
  return {
    ok: !!(res.httpOk && !res.error),
    status: d.status ?? null,
    startCount: d.start_count ?? d.startCount ?? null,
    remains: d.remains ?? null,
    message: res.error || res.message || null,
  };
}

async function checkBalance() {
  const res = await owletCall("balance");
  if (isTimeoutRes(res)) return { ok: false, timeout: true, balance: null };
  const d = res.data ?? res;
  return { ok: !!(res.httpOk && !res.error), balance: d.balance ?? null };
}

module.exports = { fetchServices, servicePrice, placeOrder, checkOrderStatus, checkBalance };
