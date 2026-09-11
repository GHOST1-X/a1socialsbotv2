// firebase.js
// Firebase Admin SDK initializer for the A1 Socials Firebase project.
// Same credential/PIN pattern as the WoodPayVTU bot, unchanged.

const admin = require("firebase-admin");
const crypto = require("crypto");

let ADMIN_INIT_ERROR = null;

// Hardcoded test-only fallbacks — override via env vars in production.
// See earlier chat warning: rotate these once testing is done.
const DEFAULT_FIREBASE_PROJECT_ID = "a1socialsbotv2";
const DEFAULT_FIREBASE_CLIENT_EMAIL = "firebase-adminsdk-fbsvc@a1socialsbotv2.iam.gserviceaccount.com";
const DEFAULT_FIREBASE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCh/xiXdWwR4EpA\niPl7KIghFrD36MTmCLpzfVdI/lPnXUZZOiskzveC7YiyWGQY22WOzRc4RuhNOyc0\n/4NansRfkK5a6uduEYO9JpRmNpZNvfBxt11C9oU+UEAcL+Aa2cQrlf+y+x/Juntw\n0nC+dJkSfGVH2cj6ePpFJRfZ3b8P91opbv1A6gn0Uk4hYaVKUC2BcfOWaDXF19fU\nM4qdOBB78y9TOM3dJdi4uccsGGDclVdNFd1OvJCc9i4I511f6FJzpHJxNH2X51Mc\neyVI80Iz1JTDN+KlH5kpjXXaSwicVub7pay7PaVE/v0V+uJveXF4Eapy2VI8WnUF\nP4f1RRK9AgMBAAECggEAGadmsxGW2CvfRmIKtCzChg7sXo4fpFgsgr6ONJKGIgUc\n72NtUqpt+u937tpdm6we5KLo8vITtqtP9a4jFJZA/etRGTfLB5zBcpJp/NfXLJ+Q\nNMn3fHPCvRADXxNb15S14rsh36uyKIWeJ8tDrH2Vgh5uAZdlIvlGlO2fXdKmf7YJ\nIzf0bZG8Em851cThJveDJ+Ctnb2xvSD7Xp5GAoazB0oIPoMrPxk6s76mO+Ve33He\nOcL9yxA1GmcsbO9qeMbwGUG0qu+TsHqBbVGJsFVy/U2mNKQgDvnCMJC4/Vq+FkAS\nafbySok2z91K9pk6STkgQxMIgerAat0AGw9OF9orAQKBgQDUr+lC7UJosZ+YaBm6\ndzpBTU7BHJ/H2s+Zp+TqBxRAwppqXk1snxPOKL+jtFj5uifMM7w+BA95KtW6P26H\nUZ63gjckQu6EVqP4tE2+jBMcEtO2sixCJU6lsfum6ZvTBCu6EHetXvgNWNBT0/q9\nbNvxAT4puUOkWDZTyO5LlFAsPQKBgQDC/ILJ9vRdEPBLj05IfJBzKyBDFAOd6TBp\nf0Gy7k4AfV50QnKxdpgVUU2ySPP11YMfSpp+UuCwhcqXxcamBo6NA5xlNzV4AHKH\nqWiQPf0DUYTLm+WJgfqiFa7mp620xkD9I5UyAD3QoO9VoQ9hAAPeHhG77OveH5n5\nZd67Et5ogQKBgGsxNXj7pwqo6uyfGsh1qrCay+RcDtNlHlgs3Bxu8PAqpDSTzqW+\nDvdKZjuVe3pxLfmm4WrIFRxWUF2L9qLQqhOG10+5RAkCuaVxCfXNFxyBCJ79cXzs\n3JR5/YEEH/rcEUW3YvnH8XCYoHZ/UdICeV8f5zqUGtlLdCYKEL+awkVpAoGBAJhd\n0aYYwGNpNR0WYsnp7MbSUGeaYCkpa5dExgYYigN/9CtNMWrTjYw6+Ef1Eg5sRgZR\nueA0yzellOZ8ufpK7WHsDG5bcgDP+K9iBj+Q8QGC1g51SCzn0P6PixjatraopWgq\nQg/MeIFrARscvHPEG0GapakAPmBYuW1V2XK+D+YBAoGBAL8QRdrs/gM6wteEryly\n2BSpgA9eceeJdBvMSmvW/HBLBq386xmCAOZpgoiRsR4ZELBQ82FlF2hQL+9lgIxE\nPkps36Z4L+dop6YWsa59m3ZpeWI+In+KfnTDrvoRgQjFYKMHcexun40s7/TzDZOY\n23dDq7/cfWJ28HKyXgnKQDZ4\n-----END PRIVATE KEY-----\n";

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID || DEFAULT_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || DEFAULT_FIREBASE_CLIENT_EMAIL;
  let privateKey = (process.env.FIREBASE_PRIVATE_KEY || DEFAULT_FIREBASE_PRIVATE_KEY).replace(/\\n/g, "\n").trim();

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
