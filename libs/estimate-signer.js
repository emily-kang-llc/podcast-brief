import "server-only";
import crypto from "crypto";

// Server-only module — do NOT import from client components ("use client").
// Signs and verifies estimate data so the confirm endpoint can detect tampering.
//
// Secret: ESTIMATE_SIGNING_SECRET. Historically this reused STRIPE_SECRET_KEY,
// which coupled two unrelated concerns — rotating the Stripe key (as you have to
// after a leak) silently invalidated every in-flight estimate. The Stripe key
// remains a fallback so a deploy without the new var does not break; set the
// dedicated secret (`openssl rand -hex 32`) to remove the coupling.

let warnedFallback = false;

function getSecret() {
  const dedicated = process.env.ESTIMATE_SIGNING_SECRET;
  if (dedicated) return dedicated;
  const fallback = process.env.STRIPE_SECRET_KEY;
  if (!fallback) throw new Error("ESTIMATE_SIGNING_SECRET (or STRIPE_SECRET_KEY as fallback) is required for estimate signing");
  if (!warnedFallback) {
    console.warn("[estimate-signer] ESTIMATE_SIGNING_SECRET not set; falling back to STRIPE_SECRET_KEY. Set a dedicated secret.");
    warnedFallback = true;
  }
  return fallback;
}

export function signEstimate(episodeUrl, durationSeconds) {
  return crypto.createHmac("sha256", getSecret()).update(`${episodeUrl}|${durationSeconds}`).digest("hex");
}

export function verifyEstimate(episodeUrl, durationSeconds, sig) {
  if (!sig) return false;
  const expected = signEstimate(episodeUrl, durationSeconds);
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}