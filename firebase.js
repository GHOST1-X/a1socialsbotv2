// firebase.js
// Firebase Admin SDK initializer for the A1 Socials Firebase project.
// Same credential/PIN pattern as the WoodPayVTU bot, unchanged.

const admin = require("firebase-admin");
const crypto = require("crypto");

let ADMIN_INIT_ERROR = null;

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();

  if ((privateKey.startsWith('"') && privateKey.endsWith('"')) || (privateKey.startsWith("'") && privateKey.endsWith("'"))) {
    privateKey = privateKey.slice(1, -1);
  }
  privateKey = privateKey.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    ADMIN_INIT_ERROR =
      "Firebase Admin credentials missing. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY in .env";
    console.error(ADMIN_INIT_ERROR);
  } else {
    try {
      crypto.createPrivateKey(privateKey);
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      });
    } catch (e) {
      ADMIN_INIT_ERROR = "FIREBASE_PRIVATE_KEY is malformed: " + e.message;
      console.error(ADMIN_INIT_ERROR);
    }
  }
}

// ---------- PIN hashing ----------
// PINs are 4 digits (10,000 possibilities), so a fast hash like plain SHA-256
// is brute-forceable in milliseconds if the Firestore document ever leaks.
// scrypt is deliberately slow/memory-hard, which makes brute-forcing a small
// keyspace like this expensive even at scale. Each PIN gets its own random
// salt (stored alongside the hash) rather than reusing the Firestore uid,
// which isn't actually secret.
const SCRYPT_KEYLEN = 64;
const SCRYPT_PREFIX = "scrypt";

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pin), salt, SCRYPT_KEYLEN).toString("hex");
  return `${SCRYPT_PREFIX}:${salt}:${hash}`;
}

function verifyPin(pin, storedHash, uid) {
  if (!storedHash) return { valid: false, needsUpgrade: false };

  if (storedHash.startsWith(`${SCRYPT_PREFIX}:`)) {
    const [, salt, hash] = storedHash.split(":");
    const candidate = crypto.scryptSync(String(pin), salt, SCRYPT_KEYLEN).toString("hex");
    const a = Buffer.from(candidate, "hex");
    const b = Buffer.from(hash, "hex");
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { valid, needsUpgrade: false };
  }

  // Legacy format: sha256(`${pin}:${uid}`), no prefix — kept for parity with
  // the WoodPayVTU codebase in case accounts are ever migrated across.
  const legacyHash = crypto.createHash("sha256").update(`${pin}:${uid}`).digest("hex");
  const valid =
    legacyHash.length === storedHash.length &&
    crypto.timingSafeEqual(Buffer.from(legacyHash, "hex"), Buffer.from(storedHash, "hex"));
  return { valid, needsUpgrade: valid, newHash: valid ? hashPin(pin) : null };
}

module.exports = { admin, ADMIN_INIT_ERROR, hashPin, verifyPin };
