// flutterwave.js (v4)
// Generates a one-time (dynamic) Flutterwave virtual account for wallet
// funding, using the v4 "Pay With Bank Transfer" (PWBT) flow:
//   1. OAuth client_credentials -> access_token (cached, ~10 min expiry)
//   2. POST /customers            -> customer_id
//   3. POST /virtual-accounts     -> account_number, bank name, fee-inclusive amount
// Docs: https://developer.flutterwave.com/docs/pay-with-bank-transfer
//
// IMPORTANT: v4 webhooks are shaped completely differently from v3 —
// event type "charge.completed", with the amount/reference/customer nested
// under `data`. If reusing a v3 webhook, it needs a rewrite to match this
// shape, not just a field rename. The Firestore fields this file writes
// (on the `transactions` collection) are what any adapted webhook needs
// to update: status, reference, chargeAmount, flwVirtualAccountId.

const FLW_BASE = process.env.FLW_ENV === "production"
  ? "https://f4bexperience.flutterwave.com"
  : "https://developersandbox-api.flutterwave.com";
const FLW_TOKEN_URL = "https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token";

const FLW_CLIENT_ID = process.env.FLW_CLIENT_ID || ""; // "public key" slot in v4 dashboard
const FLW_CLIENT_SECRET = process.env.FLW_CLIENT_SECRET || ""; // "secret key" slot in v4 dashboard
// Flutterwave MFB's own settlement bank code, per the PWBT docs example.
// Verify against GET /banks for your account if virtual accounts fail to generate.
const BANK_CODE = process.env.FLW_BANK_CODE || "090567";
// Dynamic account validity window, in seconds (max 31536000 / 365 days, default 3600).
const ACCOUNT_EXPIRY_SECONDS = Number(process.env.FLW_ACCOUNT_EXPIRY_SECONDS || 3600);

function randomIdempotencyKey() {
  return `a1s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- OAuth token cache ----------
// Tokens expire in ~600s (10 min) per the docs. Refresh a little early
// (60s buffer) rather than waiting for an actual 401 mid-flow.
let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return { ok: true, token: cachedToken.accessToken };
  }
  if (!FLW_CLIENT_ID || !FLW_CLIENT_SECRET) {
    return { ok: false, error: "FLW_CLIENT_ID / FLW_CLIENT_SECRET not set" };
  }
  try {
    const res = await fetch(FLW_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: FLW_CLIENT_ID,
        client_secret: FLW_CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      return { ok: false, error: data.error_description || data.error || "Token request failed" };
    }
    cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 600) * 1000,
    };
    return { ok: true, token: cachedToken.accessToken };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function flwFetch(path, body, token) {
  const res = await fetch(`${FLW_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Idempotency-Key": randomIdempotencyKey(),
    },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  return { httpOk: res.ok, ...data };
}

async function createFundingAccount({ db, admin, uid, name, phone, email, amount }) {
  const tokenRes = await getAccessToken();
  if (!tokenRes.ok) return { ok: false, error: tokenRes.error };
  const token = tokenRes.token;

  const [first, ...rest] = String(name || "A1 Socials Customer").trim().split(" ");
  const last = rest.join(" ") || first;
  const customerEmail = email || `${phone || uid}@a1socials-bot.local`;

  // Step 1: create the customer. A1 Socials doesn't currently store/reuse a
  // Flutterwave customer_id per user — this creates a fresh customer object
  // per funding request, which the API allows and PWBT doesn't dedupe on.
  const customerRes = await flwFetch("/customers", {
    name: { first: first || "A1Socials", last: last || "Customer" },
    email: customerEmail,
  }, token);
  const customerId = customerRes.data?.id;
  if (!customerRes.httpOk || !customerId) {
    return { ok: false, error: customerRes.message || customerRes.error?.message || "Could not create customer" };
  }

  // Step 2: create the dynamic virtual account.
  const reference = `A1SC${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const vaRes = await flwFetch("/virtual-accounts", {
    reference,
    customer_id: customerId,
    expiry: ACCOUNT_EXPIRY_SECONDS,
    amount: Number(amount),
    bank_code: BANK_CODE,
    currency: "NGN",
    account_type: "dynamic",
    narration: name || "A1 Socials",
  }, token);

  const vaData = vaRes.data;
  if (!vaRes.httpOk || !vaData || !vaData.account_number) {
    return { ok: false, error: vaRes.error?.message || vaRes.message || "Could not generate a funding account right now." };
  }

  // v4 returns the *fee-inclusive* amount already calculated in
  // vaData.amount — no manual fee math needed here, unlike v3.
  const txRef = db.collection("transactions").doc();
  await txRef.set({
    userId: uid,
    type: "wallet_funding_dynamic",
    amount: Number(amount),
    chargeAmount: vaData.amount,
    status: "pending",
    reference: vaData.reference || reference,
    flwVirtualAccountId: vaData.id || null,
    flwCustomerId: customerId,
    accountNumber: vaData.account_number,
    bankName: vaData.account_bank_name,
    note: vaData.note || null,
    source: "whatsapp-bot",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    txId: txRef.id,
    accountNumber: vaData.account_number,
    bankName: vaData.account_bank_name,
    chargeAmount: vaData.amount,
    reference: vaData.reference || reference,
  };
}

module.exports = { createFundingAccount, getAccessToken };
