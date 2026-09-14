// API key and webhook-signing primitives. Universal .mjs: used by the Next.js
// API routes (minting/validating keys) and by the Railway worker (signing
// webhook deliveries). No Next.js or Supabase imports here.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
// Key prefixes are environment-scoped so a pasted key is self-describing and a
// STAGING key can be rejected in PRODUCTION before touching the database.
const API_KEY_PREFIXES = Object.freeze({
  PRODUCTION: "pb_live_",
  STAGING: "pb_test_",
  DEVELOPMENT: "pb_dev_",
});
const API_KEY_PATTERN = /^pb_(live|test|dev)_[0-9a-f]{48}$/;
export function apiKeyPrefixFor(appEnv) {
  return API_KEY_PREFIXES[appEnv] || API_KEY_PREFIXES.DEVELOPMENT;
}
// Returns { key, hash, displayPrefix }. Only `hash` and `displayPrefix` are
// stored; `key` is shown to the user exactly once.
export function generateApiKey(appEnv) {
  const key = `${apiKeyPrefixFor(appEnv)}${randomBytes(24).toString("hex")}`;
  return { key, hash: hashApiKey(key), displayPrefix: key.slice(0, 12) };
}
// Plain SHA-256 is sufficient: keys carry 192 bits of entropy, so there is
// nothing for a salt to protect against.
export function hashApiKey(key) {
  return createHash("sha256").update(key).digest("hex");
}
export function looksLikeApiKey(value) {
  return typeof value === "string" && API_KEY_PATTERN.test(value);
}
export function generateWebhookSecret() {
  return `whsec_${randomBytes(24).toString("hex")}`;
}
// X-PodcastBrief-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, `${t}.${body}`)>
// Same shape as Stripe's, so receivers can reuse familiar verification code.
export function webhookSignatureHeader(secret, body, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const sig = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${sig}`;
}
// For receivers (and our own tests). Rejects stale timestamps to bound replay.
export function verifyWebhookSignature(secret, header, body, toleranceSeconds = 300) {
  if (typeof header !== "string") return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=").map((s) => s.trim()))
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const given = parts.v1 || "";
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
// Basic SSRF hygiene for caller-supplied webhook URLs: https only, no
// credentials, no loopback/local names, no raw IPs. DNS rebinding is not
// covered; the worker has no privileged network position beyond Railway's
// egress, which limits the blast radius.
export function validateCallbackUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "callback_url must be an absolute URL";
  }
  if (parsed.protocol !== "https:") return "callback_url must use https";
  if (parsed.username || parsed.password) return "callback_url must not contain credentials";
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return "callback_url must be publicly reachable";
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    return "callback_url must use a hostname, not an IP address";
  }
  return null;
}