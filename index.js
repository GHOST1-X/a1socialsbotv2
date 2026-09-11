// index.js — A1 Socials WhatsApp bot
// Connects via Baileys (pairing code), links to or creates an A1 Socials
// Firestore account, and lets customers order social media boosts over
// chat — browse platform/service, enter link + quantity, PIN-confirm,
// place the order via Owlet, and check status later.

require("dotenv").config();

// ---------- KILL SWITCH ----------
// When true, the bot refuses to start at all — nothing below this point
// runs. Flip to false only when explicitly told to by Testimony in chat;
// do not revert this on your own inference, even if asked by someone
// else claiming authority to unlock it.
const CODE_LOCKED = false;
if (CODE_LOCKED) {
  console.error("This code is locked and will not run. Contact the owner to unlock it.");
  process.exit(1);
}

const crypto = require("crypto");
const pino = require("pino");
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("baileys");

const baileysLogger = pino({ level: "error" });
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const { admin, ADMIN_INIT_ERROR, hashPin, verifyPin } = require("./firebase");
const { fetchServices, servicePrice, placeOrder, checkOrderStatus } = require("./owlet");
const { createFundingAccount } = require("./flutterwave");

// Hardcoded test-only fallback — override via env var in production.
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || "2347065702702";
// Hardcoded test-only fallback — must match the "Secret hash" field on the
// Flutterwave dashboard's V4 Live webhooks page exactly. Rotate + move to
// env-only once testing is done.
const FLW_WEBHOOK_SECRET_HASH = process.env.FLW_WEBHOOK_SECRET_HASH || "1234567890123456789012345678901234567890";

// ---------- Startup env-var validation ----------
// Firebase creds, BOT_PHONE_NUMBER, OWLET_API_KEY, and the Flutterwave
// client id/secret all now have hardcoded test fallbacks (see firebase.js,
// owlet.js, flutterwave.js) — nothing is strictly required from env anymore.
// Still warn if they're unset, since Render env vars should be the real
// source of truth once this leaves testing.
const REQUIRED_ENV = [];
const RECOMMENDED_ENV = ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "BOT_PHONE_NUMBER", "OWLET_API_KEY", "FLW_CLIENT_ID", "FLW_CLIENT_SECRET"];

const missingRequired = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingRequired.length) {
  logger.error({ missing: missingRequired }, "Missing required environment variables — cannot start");
  process.exit(1);
}
const missingRecommended = RECOMMENDED_ENV.filter((k) => !process.env[k]);
if (missingRecommended.length) {
  logger.warn({ missing: missingRecommended }, "Missing recommended environment variables — related features will fail at runtime");
}

if (ADMIN_INIT_ERROR) {
  logger.error({ err: ADMIN_INIT_ERROR }, "Fatal: Firebase Admin failed to initialize");
  process.exit(1);
}
const db = admin.firestore();

// ---------- HTTP server: health check + Flutterwave webhook ----------
// Render's free web services spin down after 15 min with no HTTP traffic,
// which would kill the WhatsApp connection. Ping /health every few minutes
// (e.g. via UptimeRobot) to keep the service warm.
//
// The Flutterwave webhook lives on this same server at /webhook/flutterwave
// (no separate Netlify deploy) — v4 sends a "charge.completed" event with
// amount/reference/customer nested under `data`. See isValidWebhookSignature
// below for the HMAC check against FLW_WEBHOOK_SECRET_HASH.
let waConnectionState = "connecting"; // "connecting" | "open" | "closed"
const http = require("http");
const PORT = process.env.PORT || 3000;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function isValidWebhookSignature(rawBody, signature) {
  if (!FLW_WEBHOOK_SECRET_HASH || !signature) return false;
  const expected = crypto.createHmac("sha256", FLW_WEBHOOK_SECRET_HASH).update(rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleFlutterwaveWebhook(req, res) {
  const rawBody = await readRawBody(req);
  const signature = req.headers["flutterwave-signature"];

  if (!isValidWebhookSignature(rawBody, signature)) {
    logger.warn("Webhook: invalid or missing signature");
    res.writeHead(401).end("Invalid signature");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    res.writeHead(400).end("Invalid JSON");
    return;
  }

  if (payload.type !== "charge.completed") {
    res.writeHead(200).end("Ignored (not a charge.completed event)");
    return;
  }

  const chargeData = payload.data || {};
  const reference = chargeData.reference;
  const status = chargeData.status;
  const amountReceived = chargeData.amount;
  const customerId = chargeData.customer?.id;

  if (!reference) {
    res.writeHead(200).end("Ignored (no reference)");
    return;
  }

  const q = await db.collection("transactions").where("reference", "==", reference).limit(1).get();
  if (q.empty) {
    logger.warn({ reference }, "Webhook: no matching transaction");
    res.writeHead(200).end("No matching transaction");
    return;
  }
  const txDoc = q.docs[0];
  const tx = txDoc.data();

  // Idempotent — Flutterwave can retry webhooks, never credit twice.
  if (tx.status === "success" || tx.status === "failed" || tx.status === "amount_mismatch") {
    res.writeHead(200).end("Already processed");
    return;
  }

  if (status !== "succeeded") {
    await txDoc.ref.update({ status: "failed", webhookStatus: status || null });
    res.writeHead(200).end("Marked failed");
    return;
  }
  if (tx.flwCustomerId && customerId && tx.flwCustomerId !== customerId) {
    await txDoc.ref.update({ status: "amount_mismatch", note: "customer_id mismatch" });
    res.writeHead(200).end("Customer mismatch");
    return;
  }
  if (Number(amountReceived) !== Number(tx.chargeAmount)) {
    await txDoc.ref.update({ status: "amount_mismatch", webhookAmount: amountReceived });
    res.writeHead(200).end("Amount mismatch");
    return;
  }

  await db.runTransaction(async (t) => {
    const userRef = db.collection("users").doc(tx.userId);
    t.update(userRef, { walletBalance: admin.firestore.FieldValue.increment(tx.amount) });
    t.update(txDoc.ref, { status: "success", chargeId: chargeData.id || null });
  });

  res.writeHead(200).end("OK");
}

http
  .createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/webhook/flutterwave") {
      try {
        await handleFlutterwaveWebhook(req, res);
      } catch (e) {
        logger.error({ err: e.message }, "Webhook handler error");
        res.writeHead(500).end("Internal error");
      }
      return;
    }
    if (req.url === "/health") {
      let firestoreOk = true;
      try {
        await db.collection("botSessions").limit(1).get();
      } catch (e) {
        firestoreOk = false;
      }
      const healthy = waConnectionState === "open" && firestoreOk;
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ whatsapp: waConnectionState, firestore: firestoreOk ? "ok" : "unreachable" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("A1 Socials bot is running.");
  })
  .listen(PORT, () => logger.info({ port: PORT }, "Server listening (health check + webhook)"));

// ---------- Self-ping keep-alive (Render free tier) ----------
// Render's free web services spin down after 15 min of no inbound HTTP
// traffic — and a cold start can wipe the locally-stored auth_session,
// forcing a fresh device-link (the exact "Couldn't link device" wall we
// hit, since fresh links from Render's IP get blocked). RENDER_EXTERNAL_URL
// is set automatically by Render on every web service, so this self-pings
// /health every 10 minutes to keep the service warm without needing an
// external uptime monitor set up separately. No-op anywhere else (Termux,
// local) since that env var won't be set outside Render.
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || "";
if (RENDER_EXTERNAL_URL) {
  const PING_INTERVAL_MS = 10 * 60 * 1000;
  setInterval(() => {
    fetch(`${RENDER_EXTERNAL_URL}/health`).catch((e) => {
      logger.warn({ err: e.message }, "Self-ping failed");
    });
  }, PING_INTERVAL_MS);
  logger.info({ url: RENDER_EXTERNAL_URL, intervalMs: PING_INTERVAL_MS }, "Self-ping keep-alive active");
} else {
  logger.info("RENDER_EXTERNAL_URL not set — self-ping keep-alive inactive (expected outside Render)");
}

// ---------- Conversation sessions (in-memory cache, Firestore-backed) ----------
const sessions = new Map();
const SESSION_FIELDS = [
  "state", "pending", "uid", "name", "regName", "regPhone",
  "platforms", "platformChoice", "services", "orderIdInput",
];

function sessionDocId(jid) {
  return jid.replace(/\//g, "_");
}

async function getSession(jid) {
  if (sessions.has(jid)) return sessions.get(jid);

  let session = { state: "IDLE" };
  try {
    const doc = await db.collection("botSessions").doc(sessionDocId(jid)).get();
    if (doc.exists) session = { state: "IDLE", ...doc.data() };
  } catch (e) {
    logger.warn({ err: e.message, jid }, "Failed to load persisted session, starting fresh");
  }
  sessions.set(jid, session);
  return session;
}

async function persistSession(jid, session) {
  try {
    const snapshot = {};
    for (const field of SESSION_FIELDS) {
      if (session[field] !== undefined) snapshot[field] = session[field];
    }
    await db.collection("botSessions").doc(sessionDocId(jid)).set(snapshot, { merge: false });
  } catch (e) {
    logger.warn({ err: e.message, jid }, "Failed to persist session");
  }
}

function resetToMenu(session) {
  session.state = "MAIN_MENU";
  session.pending = null;
}

function naira(n) {
  return `₦${Number(n).toLocaleString("en-NG")}`;
}

// WhatsApp doesn't always address a chat by the sender's real phone number —
// some accounts use "@lid" (Linked ID), an internal identifier that isn't a
// phone number. Never trust the jid for identity — ask for the real phone
// number directly during registration instead.
function phoneVariants(rawPhone) {
  const digits = String(rawPhone).replace(/\D/g, "");
  const local = digits.startsWith("234") ? digits.slice(3) : digits.startsWith("0") ? digits.slice(1) : digits;
  return ["234" + local, "0" + local, local];
}

async function findUserByPhoneVariants(variants) {
  const q = await db.collection("users").where("phone", "in", variants).limit(1).get();
  if (q.empty) return null;
  return { uid: q.docs[0].id, ...q.docs[0].data() };
}

const MENU_TEXT =
  "*A1 Socials*\n\n" +
  "1️⃣ Order a Boost\n" +
  "2️⃣ Check Order Status\n" +
  "3️⃣ Check Wallet Balance\n" +
  "4️⃣ Fund Wallet\n\n" +
  "Reply with a number, or just type what you want (e.g. \"boost\", \"balance\", \"fund\"). Send *menu* anytime to come back here.";

function smartMainMenuChoice(text) {
  const t = text.toLowerCase().trim();
  if (["1", "boost", "order", "order a boost"].includes(t)) return "1";
  if (["2", "status", "order status", "check status"].includes(t)) return "2";
  if (["3", "balance", "bal", "wallet", "check balance"].includes(t)) return "3";
  if (["4", "fund", "funding", "topup", "top up", "top-up", "deposit", "add money"].includes(t)) return "4";
  return null;
}

// ---------- Wallet-funding: watch a pending transaction for the webhook ----------
const activeFundingListeners = new Map();
function watchFundingTransaction(sock, jid, uid, txId, requestedAmount) {
  if (activeFundingListeners.has(txId)) return;
  const txRef = db.collection("transactions").doc(txId);
  const TIMEOUT_MS = 40 * 60 * 1000;

  const cleanup = () => {
    clearTimeout(timer);
    try { unsub(); } catch (_) {}
    activeFundingListeners.delete(txId);
  };

  const unsub = txRef.onSnapshot(
    async (snap) => {
      const data = snap.data();
      if (!data) return;
      if (data.status === "success") {
        cleanup();
        const userSnap = await db.collection("users").doc(uid).get();
        const bal = userSnap.data()?.walletBalance || 0;
        await sock.sendMessage(jid, {
          text: `✅ Payment received! ${naira(requestedAmount)} added.\n\nNew balance: *${naira(bal)}*\n\n` + MENU_TEXT,
        });
      } else if (data.status === "failed" || data.status === "amount_mismatch") {
        cleanup();
        await sock.sendMessage(jid, {
          text: `⚠️ Your funding of ${naira(requestedAmount)} didn't go through. If money left your account, contact support with reference ${data.reference}.`,
        });
      }
    },
    (err) => {
      logger.error({ err: err.message, txId }, "Funding listener error");
      cleanup();
    }
  );
  const timer = setTimeout(cleanup, TIMEOUT_MS);
  activeFundingListeners.set(txId, cleanup);
}

// ---------- Service catalog helpers ----------
function groupByPlatform(services) {
  const map = new Map();
  for (const s of services) {
    const key = s.category || "Other";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return [...map.entries()].map(([platform, list]) => ({ platform, services: list }));
}

async function handleMessage(sock, jid, textRaw) {
  const text = (textRaw || "").trim();
  const lower = text.toLowerCase();
  const session = await getSession(jid);

  if (lower === "menu" && session.uid) {
    resetToMenu(session);
    return sock.sendMessage(jid, { text: MENU_TEXT });
  }

  // ---------- Not yet linked/registered ----------
  if (session.state === "IDLE") {
    session.state = "REGISTER_NAME";
    return sock.sendMessage(jid, {
      text: "Welcome to A1 Socials! 👋\nWhat's your full name?",
    });
  }

  if (session.state === "REGISTER_NAME") {
    if (text.length < 2) return sock.sendMessage(jid, { text: "Please enter your full name." });
    session.regName = text;
    session.state = "REGISTER_PHONE";
    return sock.sendMessage(jid, { text: "What's your phone number? (e.g. 08012345678)" });
  }

  if (session.state === "REGISTER_PHONE") {
    const digits = text.replace(/\D/g, "");
    if (digits.length < 10) return sock.sendMessage(jid, { text: "Enter a valid Nigerian phone number:" });
    const variants = phoneVariants(digits);

    const existing = await findUserByPhoneVariants(variants);
    if (existing) {
      session.uid = existing.uid;
      session.name = existing.name;
      resetToMenu(session);
      return sock.sendMessage(jid, { text: `Welcome back, ${existing.name || "there"}! 👋\n\n${MENU_TEXT}` });
    }

    session.regPhone = variants[0];
    session.state = "REGISTER_PIN";
    return sock.sendMessage(jid, { text: "Great. Now set a 4-digit transaction PIN (you'll use this to confirm orders):" });
  }

  if (session.state === "REGISTER_PIN") {
    if (!/^\d{4}$/.test(text)) return sock.sendMessage(jid, { text: "PIN must be exactly 4 digits. Try again:" });
    const newRef = db.collection("users").doc();
    await newRef.set({
      name: session.regName,
      phone: session.regPhone,
      walletBalance: 0,
      pinHash: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "whatsapp-bot",
    });
    await newRef.update({ pinHash: hashPin(text) });
    session.uid = newRef.id;
    session.name = session.regName;
    resetToMenu(session);
    return sock.sendMessage(jid, {
      text: `Account created! 🎉 Your wallet balance is ₦0 — reply *4* to fund it now.\n\n${MENU_TEXT}`,
    });
  }

  // Everything below requires a linked account
  if (!session.uid) {
    session.state = "IDLE";
    return handleMessage(sock, jid, text);
  }

  if (session.state === "MAIN_MENU") {
    const choice = smartMainMenuChoice(text);
    if (choice === "1") {
      await sock.sendMessage(jid, { text: "Loading services… ⏳" });
      const { ok, services } = await fetchServices();
      if (!ok || !services.length) {
        resetToMenu(session);
        return sock.sendMessage(jid, { text: "Couldn't load services right now — try again shortly.\n\n" + MENU_TEXT });
      }
      const grouped = groupByPlatform(services);
      session.platforms = grouped.map((g) => g.platform);
      session.services = services; // full flat list, filtered by platform when picked
      session.state = "BOOST_PLATFORM";
      const listText = session.platforms.map((p, i) => `${i + 1}. ${p}`).join("\n");
      return sock.sendMessage(jid, { text: `Which platform / category?\n\n${listText}\n\nReply with the number.` });
    }
    if (choice === "2") {
      session.state = "ORDER_STATUS_INPUT";
      return sock.sendMessage(jid, { text: "Enter your order ID to check its status:" });
    }
    if (choice === "3") {
      const doc = await db.collection("users").doc(session.uid).get();
      const bal = doc.data()?.walletBalance || 0;
      return sock.sendMessage(jid, { text: `Your wallet balance is *${naira(bal)}*.\n\nSend *menu* to go back.` });
    }
    if (choice === "4") {
      session.state = "FUND_AMOUNT";
      return sock.sendMessage(jid, { text: "How much would you like to add to your wallet? (minimum ₦100)" });
    }
    return sock.sendMessage(jid, { text: MENU_TEXT });
  }

  // ---------- Fund wallet flow ----------
  if (session.state === "FUND_AMOUNT") {
    const amount = Number(text.replace(/[^\d]/g, ""));
    if (!amount || amount < 100) return sock.sendMessage(jid, { text: "Enter a valid amount (minimum ₦100):" });

    const userDoc = await db.collection("users").doc(session.uid).get();
    const userData = userDoc.data();
    await sock.sendMessage(jid, { text: "Generating your funding account… ⏳" });

    const result = await createFundingAccount({
      db, admin, uid: session.uid,
      name: userData.name, phone: userData.phone, email: userData.email,
      amount,
    });

    if (!result.ok) {
      logger.error({ err: result.error, uid: session.uid }, "Funding account creation failed");
      resetToMenu(session);
      return sock.sendMessage(jid, { text: "Couldn't generate a funding account right now — try again shortly.\n\n" + MENU_TEXT });
    }

    resetToMenu(session);
    watchFundingTransaction(sock, jid, session.uid, result.txId, amount);
    return sock.sendMessage(jid, {
      text:
        `💳 *Transfer ${naira(result.chargeAmount)} to:*\n\n` +
        `Account: *${result.accountNumber}*\n` +
        `Bank: *${result.bankName}*\n\n` +
        `This account is for a single transfer only. Once it lands, I'll message you here automatically — usually within a minute or two.\n\n` +
        `Send *menu* to go back.`,
    });
  }

  // ---------- Order status lookup ----------
  if (session.state === "ORDER_STATUS_INPUT") {
    if (!text) return sock.sendMessage(jid, { text: "Enter your order ID:" });
    await sock.sendMessage(jid, { text: "Checking… ⏳" });
    const result = await checkOrderStatus(text.trim());
    resetToMenu(session);
    if (!result.ok) {
      return sock.sendMessage(jid, { text: (result.message || "Couldn't find that order.") + "\n\n" + MENU_TEXT });
    }
    return sock.sendMessage(jid, {
      text:
        `*Order #${text.trim()}*\n` +
        `Status: *${result.status || "unknown"}*\n` +
        (result.startCount !== null ? `Start count: ${result.startCount}\n` : "") +
        (result.remains !== null ? `Remaining: ${result.remains}\n` : "") +
        `\n` + MENU_TEXT,
    });
  }

  // ---------- Order a boost: pick platform ----------
  if (session.state === "BOOST_PLATFORM") {
    const idx = Number(text) - 1;
    const platform = session.platforms?.[idx];
    if (!platform) return sock.sendMessage(jid, { text: "Reply with a valid number from the list." });
    session.platformChoice = platform;
    const list = session.services.filter((s) => s.category === platform);
    session.services = list; // narrow to this platform's services for the next step
    session.state = "BOOST_SERVICE_LIST";
    const listText = list.map((s, i) => `${i + 1}. ${s.name} — ${naira(s.rate)}/1000`).join("\n");
    return sock.sendMessage(jid, { text: `*${platform}* services:\n\n${listText}\n\nReply with the number.` });
  }

  // ---------- Order a boost: pick service ----------
  if (session.state === "BOOST_SERVICE_LIST") {
    const idx = Number(text) - 1;
    const service = session.services?.[idx];
    if (!service) return sock.sendMessage(jid, { text: "Reply with a valid service number from the list." });
    session.pending = { type: "smm_boost", serviceId: service.id, serviceName: service.name, rate: service.rate, min: service.min, max: service.max };
    session.state = "BOOST_LINK";
    return sock.sendMessage(jid, { text: `Send the link or username to boost (e.g. your Instagram post/profile link):` });
  }

  // ---------- Order a boost: link ----------
  if (session.state === "BOOST_LINK") {
    if (text.length < 3) return sock.sendMessage(jid, { text: "Enter a valid link or username:" });
    session.pending.link = text;
    session.state = "BOOST_QUANTITY";
    return sock.sendMessage(jid, {
      text: `How many? (min ${session.pending.min}, max ${session.pending.max})`,
    });
  }

  // ---------- Order a boost: quantity + price + confirm ----------
  if (session.state === "BOOST_QUANTITY") {
    const qty = Number(text.replace(/[^\d]/g, ""));
    const { min, max } = session.pending;
    if (!qty || qty < min || qty > max) {
      return sock.sendMessage(jid, { text: `Enter a quantity between ${min} and ${max}:` });
    }
    session.pending.quantity = qty;
    const price = servicePrice({ rate: session.pending.rate }, qty);
    session.pending.amount = price;
    session.state = "CONFIRM_PIN";
    return sock.sendMessage(jid, {
      text:
        `*${session.pending.serviceName}*\n` +
        `Link: ${session.pending.link}\n` +
        `Quantity: ${qty}\n` +
        `Price: ${naira(price)}\n\n` +
        `Enter your PIN to confirm:`,
    });
  }

  // ---------- PIN confirmation + purchase execution ----------
  if (session.state === "CONFIRM_PIN") {
    if (!/^\d{4}$/.test(text)) return sock.sendMessage(jid, { text: "Enter your 4-digit PIN:" });

    const userRef = db.collection("users").doc(session.uid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();

    const PIN_MAX_ATTEMPTS = 5;
    const PIN_LOCKOUT_MS = 15 * 60 * 1000;
    const lockUntil = userData.pinLockUntil ? userData.pinLockUntil.toMillis?.() ?? userData.pinLockUntil : 0;
    if (lockUntil && Date.now() < lockUntil) {
      const minsLeft = Math.ceil((lockUntil - Date.now()) / 60000);
      resetToMenu(session);
      return sock.sendMessage(jid, {
        text: `Too many incorrect PIN attempts. Try again in ${minsLeft} minute(s), or contact support.\n\n${MENU_TEXT}`,
      });
    }

    const { valid, needsUpgrade, newHash } = verifyPin(text, userData.pinHash, session.uid);

    if (!valid) {
      const failCount = (userData.pinFailCount || 0) + 1;
      const update = { pinFailCount: failCount };
      if (failCount >= PIN_MAX_ATTEMPTS) {
        update.pinLockUntil = admin.firestore.Timestamp.fromMillis(Date.now() + PIN_LOCKOUT_MS);
        update.pinFailCount = 0;
        await userRef.update(update);
        resetToMenu(session);
        return sock.sendMessage(jid, {
          text: `Too many incorrect PIN attempts. Your account is locked for 15 minutes.\n\n${MENU_TEXT}`,
        });
      }
      await userRef.update(update);
      return sock.sendMessage(jid, {
        text: `Incorrect PIN (${failCount}/${PIN_MAX_ATTEMPTS} attempts). Try again, or send *menu* to cancel.`,
      });
    }

    const clearUpdate = { pinFailCount: 0, pinLockUntil: admin.firestore.FieldValue.delete() };
    if (needsUpgrade && newHash) clearUpdate.pinHash = newHash;
    await userRef.update(clearUpdate);

    const { amount, serviceId, link, quantity, serviceName } = session.pending;
    if ((userData.walletBalance || 0) < amount) {
      resetToMenu(session);
      return sock.sendMessage(jid, { text: `Insufficient wallet balance. Your balance is ${naira(userData.walletBalance || 0)}.\n\n` + MENU_TEXT });
    }

    // Debit atomically first, then attempt the order, then refund on a
    // CONFIRMED failure only — never on a timeout, where the outcome is
    // unknown (the order may still have gone through on Owlet's side).
    await sock.sendMessage(jid, { text: "Placing your order… ⏳" });
    try {
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(userRef);
        if ((fresh.data().walletBalance || 0) < amount) throw new Error("INSUFFICIENT_BALANCE");
        tx.update(userRef, { walletBalance: admin.firestore.FieldValue.increment(-amount) });
      });
    } catch (e) {
      logger.error({ err: e.message, uid: session.uid }, "Debit transaction failed");
      resetToMenu(session);
      const msg = e.message === "INSUFFICIENT_BALANCE"
        ? "Insufficient wallet balance."
        : "Something went wrong processing your payment. Please try again or contact support.";
      return sock.sendMessage(jid, { text: msg + "\n\n" + MENU_TEXT });
    }

    const result = await placeOrder({ service: serviceId, link, quantity });

    if (result.ok) {
      await db.collection("transactions").add({
        uid: session.uid,
        type: "smm_boost",
        serviceId, serviceName, link, quantity, amount,
        status: "successful",
        orderId: result.order,
        source: "whatsapp-bot",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      resetToMenu(session);
      return sock.sendMessage(jid, {
        text: `✅ Order placed! *${serviceName}* for ${link} (qty ${quantity}).\n\nOrder ID: *${result.order}*\nCheck status anytime from the menu.\n\n` + MENU_TEXT,
      });
    }

    if (result.timeout) {
      await db.collection("transactions").add({
        uid: session.uid,
        type: "smm_boost",
        serviceId, serviceName, link, quantity, amount,
        status: "pending_reconciliation",
        source: "whatsapp-bot",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      resetToMenu(session);
      return sock.sendMessage(jid, { text: "We couldn't confirm this in time. If it doesn't show up shortly, contact support before retrying.\n\n" + MENU_TEXT });
    }

    // Confirmed failure — refund
    await userRef.update({ walletBalance: admin.firestore.FieldValue.increment(amount) });
    await db.collection("transactions").add({
      uid: session.uid,
      type: "smm_boost",
      serviceId, serviceName, link, quantity, amount,
      status: "failed_refunded",
      reason: result.message || "Order failed",
      source: "whatsapp-bot",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    resetToMenu(session);
    return sock.sendMessage(jid, { text: `❌ Order failed — you've been refunded ${naira(amount)}.\n\n` + MENU_TEXT });
  }

  resetToMenu(session);
  return sock.sendMessage(jid, { text: MENU_TEXT });
}

// ---------- Baileys connection ----------
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Previously this called start() again immediately on every disconnect —
// no delay, no cap. That tight loop is what produced the log you saw: three
// "WhatsApp connection closed" events within about a second of each other,
// then an uncaught throw from inside Baileys that crashed the whole
// process (Render then restarts the container, which repeats the same
// loop). Reconnects now back off (5s, 10s, 20s... capped at 60s) and are
// serialized so overlapping start() calls can't pile up.
let reconnectAttempts = 0;
let reconnecting = false;
// Only request a pairing code once per boot — retrying it on every
// reconnect is itself a likely reason WhatsApp was closing the connection
// so quickly (looks like automated/abusive behavior from their side).
let pairingCodeRequested = false;

async function start() {
  if (reconnecting) return;
  reconnecting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_session");
    // No explicit version override — woodpayvtu-bot uses the bundled
    // default from baileys@6.7.24 with no version fetching at all, and a
    // fresh link with that exact combination was just confirmed working
    // right now. Both fetchLatestBaileysVersion() and
    // fetchLatestWaWebVersion() were tried here and neither fixed linking,
    // so matching the known-working config exactly instead of guessing further.
    const sock = makeWASocket({ auth: state, printQRInTerminal: false, logger: baileysLogger });

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        waConnectionState = "open";
        reconnectAttempts = 0;
        logger.info("Connected to WhatsApp");
      }
      if (connection === "close") {
        waConnectionState = "closed";
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        logger.warn({ shouldReconnect, err: lastDisconnect?.error?.message }, "WhatsApp connection closed");
        reconnecting = false;
        if (shouldReconnect) {
          reconnectAttempts++;
          const backoffMs = Math.min(60000, 5000 * 2 ** (reconnectAttempts - 1));
          logger.info({ backoffMs, attempt: reconnectAttempts }, "Reconnecting after backoff");
          setTimeout(() => start(), backoffMs);
        } else {
          logger.error("Logged out — delete auth_session and re-link with a new pairing code.");
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);

    if (!sock.authState.creds.registered && BOT_PHONE_NUMBER && !pairingCodeRequested) {
      pairingCodeRequested = true;
      await delay(3000);
      try {
        const code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
        logger.info({ code }, "Pairing code generated — enter this in WhatsApp");
      } catch (e) {
        logger.error({ err: e.message }, "Pairing code request failed");
        pairingCodeRequested = false; // allow a retry on the next successful connection attempt
      }
    }

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue; // ignore groups/status
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";
        try {
          await handleMessage(sock, jid, text);
        } catch (e) {
          logger.error({ err: e.message, stack: e.stack, jid }, "Error handling message");
          try {
            await sock.sendMessage(jid, { text: "Something went wrong. Please try again or send *menu*." });
          } catch (_) {
            // socket may already be closed — the outer reconnect logic handles this
          }
        } finally {
          const session = sessions.get(jid);
          if (session) await persistSession(jid, session);
        }
      }
    });

    reconnecting = false;
  } catch (e) {
    reconnecting = false;
    logger.error({ err: e.message, stack: e.stack }, "start() failed");
    reconnectAttempts++;
    const backoffMs = Math.min(60000, 5000 * 2 ** (reconnectAttempts - 1));
    setTimeout(() => start(), backoffMs);
  }
}

// Last-resort safety net: an uncaught error anywhere (e.g. a Baileys
// internal throw like the "Connection Closed" one that crashed the process
// before) now gets logged and triggers a backed-off reconnect instead of
// killing the whole service.
process.on("uncaughtException", (e) => {
  logger.error({ err: e.message, stack: e.stack }, "Uncaught exception — recovering");
  reconnecting = false;
  reconnectAttempts++;
  const backoffMs = Math.min(60000, 5000 * 2 ** (reconnectAttempts - 1));
  setTimeout(() => start(), backoffMs);
});
process.on("unhandledRejection", (e) => {
  logger.error({ err: e?.message || e }, "Unhandled rejection — recovering");
});

start();
