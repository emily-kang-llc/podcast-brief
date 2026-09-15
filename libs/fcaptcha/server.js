import "server-only";
import { NextResponse } from "next/server";
import { cleanUrl } from "@/libs/url.mjs";

// Server-side FCaptcha verification for human (cookie-session) writes.
//
// Modes (FCAPTCHA_MODE):
//   off      — never checks. Default when FCAPTCHA_URL is unset.
//   monitor  — verifies and logs, but never rejects. Default when FCAPTCHA_URL
//              is set. Deploy in this mode first, confirm the frontend is
//              sending tokens (no "would reject" lines in Vercel logs), then
//              switch to enforce.
//   enforce  — rejects missing/invalid tokens.
//
// Outage policy is action-scoped, never a global switch:
//   - brief_submit / brief_regenerate fail OPEN when FCaptcha is unreachable
//     (captcha_unavailable) so an FCaptcha outage never blocks paying
//     customers from creating briefs.
//   - signup / api_key_create (and any other action) fail CLOSED on every
//     failure, including captcha_unavailable (503).
//   - Invalid, missing, reused, wrong-action, wrong-host, low-score, and
//     misconfigured verdicts fail closed everywhere.
//
// API-key callers never go through this: the key is their credential.

// Human web-UI writes that may proceed when the verifier itself is down.
const FAILOPEN_ACTIONS = new Set(["brief_submit", "brief_regenerate"]);

const TIMEOUT_MS = 4000;

const MESSAGES = {
  captcha_missing: "Verification token missing. Reload the page and try again.",
  captcha_failed: "Verification failed. Reload the page and try again.",
  captcha_hostname_mismatch: "Verification token was issued for a different site.",
  captcha_action_mismatch: "Verification token was issued for a different action.",
  captcha_unavailable: "Verification service is unavailable. Please try again shortly.",
  captcha_misconfigured: "Verification is misconfigured on the server.",
};

// Env is read per call (not at module load) so mode can vary by deployment
// and tests can set it per case. cleanUrl throws on unset vars; FCaptcha being
// unconfigured must mean "off", not a crash.
function currentConfig() {
  let url = "";
  try { url = cleanUrl("FCAPTCHA_URL"); } catch { url = ""; }
  const verifySecret = process.env.FCAPTCHA_VERIFY_SECRET || "";
  const mode = (process.env.FCAPTCHA_MODE || (url ? "monitor" : "off")).toLowerCase();
  return { url, verifySecret, mode };
}

export function fcaptchaMode() {
  return currentConfig().mode;
}

// Token arrives as `fcaptchaToken` in the JSON body or as X-FCaptcha-Token.
export function extractFCaptchaToken(req, body) {
  const fromBody = body && typeof body.fcaptchaToken === "string" ? body.fcaptchaToken : null;
  return fromBody || req.headers.get("x-fcaptcha-token") || null;
}

function requestHostname(req) {
  const raw = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  return raw.split(",")[0].trim().split(":")[0].toLowerCase();
}

// The token's signed `hostname` is the Origin the widget ran on. By default we
// require it to equal the host this request arrived on (same page, same host),
// which also works for Vercel preview deployments. Override with
// FCAPTCHA_EXPECTED_HOSTNAMES=a.com,b.com if you front the app differently.
function expectedHostnames(req) {
  const env = process.env.FCAPTCHA_EXPECTED_HOSTNAMES;
  if (env) return env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = requestHostname(req);
  return host ? [host] : [];
}

async function siteverify(req, token, action, cfg) {
  if (!cfg.url || !cfg.verifySecret) return { pass: false, reason: "captcha_misconfigured" };
  if (!token) return { pass: false, reason: "captcha_missing" };

  let res;
  let data;
  try {
    res = await fetch(`${cfg.url}/turnstile/v0/siteverify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: cfg.verifySecret, response: token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    data = await res.json();
  } catch (err) {
    console.error("[fcaptcha] siteverify request failed:", err.message);
    return { pass: false, reason: "captcha_unavailable" };
  }

  if (!res.ok) {
    console.error(`[fcaptcha] siteverify HTTP ${res.status}`);
    return { pass: false, reason: res.status === 401 ? "captcha_misconfigured" : "captcha_unavailable" };
  }
  if (!data.success) {
    return { pass: false, reason: "captcha_failed", errorCodes: data["error-codes"] || [], score: data.score };
  }

  // hostname and action are signed into the token. Checking them is what stops
  // a token minted on another site (lifted site key) or for another action
  // (e.g. api_key_create) from being spent here.
  const expected = expectedHostnames(req);
  const hostname = String(data.hostname || "").toLowerCase();
  if (expected.length && !expected.includes(hostname)) {
    return { pass: false, reason: "captcha_hostname_mismatch", hostname, score: data.score };
  }
  if (action && data.action !== action) {
    return { pass: false, reason: "captcha_action_mismatch", action: data.action, score: data.score };
  }
  return { pass: true, reason: null, score: data.score, hostname, action: data.action };
}

// Returns { ok, mode, checked, reason?, score? }. `ok` already accounts for
// mode and the action-scoped outage policy.
export async function verifyHuman(req, { token, action }) {
  const cfg = currentConfig();
  if (cfg.mode === "off") return { ok: true, mode: cfg.mode, checked: false };

  const verdict = await siteverify(req, token, action, cfg);

  if (cfg.mode === "monitor") {
    if (!verdict.pass) {
      console.warn(`[fcaptcha] monitor: would reject action=${action} reason=${verdict.reason}`);
    }
    return { ok: true, mode: cfg.mode, checked: true, ...verdict };
  }

  if (verdict.pass) return { ok: true, mode: cfg.mode, checked: true, ...verdict };
  if (verdict.reason === "captcha_unavailable" && FAILOPEN_ACTIONS.has(action)) {
    console.warn(`[fcaptcha] enforce: FCaptcha unavailable for action=${action}; failing open`);
    return { ok: true, mode: cfg.mode, checked: true, ...verdict, failedOpen: true };
  }
  return { ok: false, mode: cfg.mode, checked: true, ...verdict };
}

export function humanCheckResponse(result) {
  const reason = result.reason || "captcha_failed";
  const message = MESSAGES[reason] || MESSAGES.captcha_failed;
  const status = reason === "captcha_unavailable" ? 503 : 403;
  // `error` is the human-readable message (shown by apiClient toasts);
  // `code` keeps the machine-readable reason for programmatic handling.
  return NextResponse.json({ error: message, code: reason, message }, { status });
}
