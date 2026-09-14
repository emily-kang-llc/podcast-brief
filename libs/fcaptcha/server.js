import "server-only";
import { NextResponse } from "next/server";

// Server-side FCaptcha verification for human (cookie-session) writes.
//
// Modes (FCAPTCHA_MODE):
//   off      — never checks. Default when FCAPTCHA_URL is unset.
//   monitor  — verifies and logs, but never rejects. Default when FCAPTCHA_URL
//              is set. Deploy in this mode first, confirm the frontend is
//              sending tokens (no "would reject" lines in Vercel logs), then
//              switch to enforce.
//   enforce  — rejects missing/invalid tokens. Fails CLOSED if FCaptcha is
//              unreachable unless FCAPTCHA_FAIL_OPEN=true.
//
// API-key callers never go through this: the key is their credential.

const FCAPTCHA_URL = (process.env.FCAPTCHA_URL || "").replace(/\/+$/, "");
const VERIFY_SECRET = process.env.FCAPTCHA_VERIFY_SECRET || "";
const MODE = (process.env.FCAPTCHA_MODE || (FCAPTCHA_URL ? "monitor" : "off")).toLowerCase();
const FAIL_OPEN = /^(1|true|yes|on)$/i.test(process.env.FCAPTCHA_FAIL_OPEN || "");
// Off by default: IP binding causes false rejections when the visitor's path to
// Vercel and to FCaptcha differ (IPv4 vs IPv6, mobile carriers).
const BIND_IP = /^(1|true|yes|on)$/i.test(process.env.FCAPTCHA_BIND_IP || "");
const TIMEOUT_MS = 4000;

const MESSAGES = {
  captcha_missing: "Verification token missing. Reload the page and try again.",
  captcha_failed: "Verification failed. Reload the page and try again.",
  captcha_hostname_mismatch: "Verification token was issued for a different site.",
  captcha_action_mismatch: "Verification token was issued for a different action.",
  captcha_unavailable: "Verification service is unavailable. Please try again shortly.",
  captcha_misconfigured: "Verification is misconfigured on the server.",
};

export function fcaptchaMode() {
  return MODE;
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

function visitorIp(req) {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || null;
}

async function siteverify(req, token, action) {
  if (!FCAPTCHA_URL || !VERIFY_SECRET) return { pass: false, reason: "captcha_misconfigured" };
  if (!token) return { pass: false, reason: "captcha_missing" };

  const ip = BIND_IP ? visitorIp(req) : null;
  let res;
  let data;
  try {
    res = await fetch(`${FCAPTCHA_URL}/turnstile/v0/siteverify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: VERIFY_SECRET, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    data = await res.json();
  } catch (err) {
    console.error("[fcaptcha] siteverify request failed:", err.message);
    return { pass: false, reason: "captcha_unavailable" };
  }

  if (!res.ok) {
    console.error(`[fcaptcha] siteverify HTTP ${res.status}:`, JSON.stringify(data));
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

// Returns { ok, mode, checked, reason?, score? }. `ok` already accounts for mode.
export async function verifyHuman(req, { token, action }) {
  if (MODE === "off") return { ok: true, mode: MODE, checked: false };

  const verdict = await siteverify(req, token, action);

  if (MODE === "monitor") {
    if (!verdict.pass) {
      console.warn(`[fcaptcha] monitor: would reject action=${action} reason=${verdict.reason}`);
    }
    return { ok: true, mode: MODE, checked: true, ...verdict };
  }

  if (verdict.pass) return { ok: true, mode: MODE, checked: true, ...verdict };
  if (verdict.reason === "captcha_unavailable" && FAIL_OPEN) {
    console.warn("[fcaptcha] enforce: FCaptcha unavailable, FCAPTCHA_FAIL_OPEN=true, allowing");
    return { ok: true, mode: MODE, checked: true, ...verdict, failedOpen: true };
  }
  return { ok: false, mode: MODE, checked: true, ...verdict };
}

export function humanCheckResponse(result) {
  const reason = result.reason || "captcha_failed";
  const message = MESSAGES[reason] || MESSAGES.captcha_failed;
  const status = reason === "captcha_unavailable" ? 503 : 403;
  // `error` is the human-readable message (shown by apiClient toasts);
  // `code` keeps the machine-readable reason for programmatic handling.
  return NextResponse.json({ error: message, code: reason, message }, { status });
}