// netlify/functions/flw-v4-webhook.js
// Receives Flutterwave v4 webhooks for the A1 Socials bot's PWBT (dynamic
// virtual account) wallet funding flow.
//
// v4 webhook shape is a flat event envelope with a nested `data` object:
//   { webhook_id, timestamp, type: "charge.completed", data: { id, amount,
//     currency, customer: { id, ... }, reference, status: "succeeded", ... } }
// This is NOT the same shape as a v3 webhook — don't just rename fields on
// an old v3 handler, the nesting is different.
//
// Deploy this as its own Netlify function, separate from the bot process.
// Configure the webhook URL + a secret hash in the Flutterwave dashboard
// under Settings > Webhooks, and set FLW_WEBHOOK_SECRET_HASH here to match.

const crypto = require("crypto");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  if ((privateKey.startsWith('"') && privateKey.endsWith('"')) || (privateKey.startsWith("'") && privateKey.endsWith("'"))) {
    privateKey = privateKey.slice(1, -1);
  }
  admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
}
const db = admin.firestore();

const SECRET_HASH = process.env.FLW_WEBHOOK_SECRET_HASH || "";

function isValidSignature(rawBody, signature) {
  if (!SECRET_HASH || !signature) return false;
  const expected = crypto.createHmac("sha256", SECRET_HASH).update(rawBody).digest("base64");
  // Constant-time compare to avoid a timing side-channel on the signature check.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  const signature = event.headers["flutterwave-signature"] || event.headers["Flutterwave-Signature"];

  if (!isValidSignature(rawBody, signature)) {
    console.warn("flw-v4-webhook: invalid or missing signature");
    return { statusCode: 401, body: "Invalid signature" };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // Only PWBT (bank transfer) completions matter for wallet funding.
  if (payload.type !== "charge.completed") {
    return { statusCode: 200, body: "Ignored (not a charge.completed event)" };
  }

  const chargeData = payload.data || {};
  const reference = chargeData.reference;
  const status = chargeData.status; // "succeeded" | other
  const amountReceived = chargeData.amount;
  const customerId = chargeData.customer?.id;

  if (!reference) {
    return { statusCode: 200, body: "Ignored (no reference)" };
  }

  // Find the pending transaction this webhook corresponds to.
  const q = await db.collection("transactions").where("reference", "==", reference).limit(1).get();
  if (q.empty) {
    console.warn("flw-v4-webhook: no matching transaction for reference", reference);
    return { statusCode: 200, body: "No matching transaction" };
  }
  const txDoc = q.docs[0];
  const tx = txDoc.data();

  // Already processed — webhooks can be retried by Flutterwave, so this
  // must be idempotent. Don't credit the wallet twice.
  if (tx.status === "success" || tx.status === "failed" || tx.status === "amount_mismatch") {
    return { statusCode: 200, body: "Already processed" };
  }

  // Verify before crediting: status, amount, and customer must all match
  // what was requested — never trust the webhook body blindly.
  if (status !== "succeeded") {
    await txDoc.ref.update({ status: "failed", webhookStatus: status || null });
    return { statusCode: 200, body: "Marked failed" };
  }
  if (tx.flwCustomerId && customerId && tx.flwCustomerId !== customerId) {
    await txDoc.ref.update({ status: "amount_mismatch", note: "customer_id mismatch" });
    return { statusCode: 200, body: "Customer mismatch" };
  }
  // chargeAmount is the fee-inclusive amount we quoted the customer when
  // the virtual account was created — that's what must have arrived.
  if (Number(amountReceived) !== Number(tx.chargeAmount)) {
    await txDoc.ref.update({ status: "amount_mismatch", webhookAmount: amountReceived });
    return { statusCode: 200, body: "Amount mismatch" };
  }

  // Credit the wallet with the original requested amount (not the
  // fee-inclusive chargeAmount — the fee is Flutterwave's, not the user's).
  await db.runTransaction(async (t) => {
    const userRef = db.collection("users").doc(tx.userId);
    t.update(userRef, { walletBalance: admin.firestore.FieldValue.increment(tx.amount) });
    t.update(txDoc.ref, { status: "success", chargeId: chargeData.id || null });
  });

  return { statusCode: 200, body: "OK" };
};
