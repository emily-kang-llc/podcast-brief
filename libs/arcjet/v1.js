import "server-only";
import arcjet, { shield, tokenBucket } from "@arcjet/next";
import { NextResponse } from "next/server";

// Rate limiting for /api/v1/*. Deliberately no detectBot(): these routes exist
// for agents, so "looks automated" is expected, not suspicious. Abuse control is
// per-caller rate limits plus the fact that every brief costs prepaid credits.
// Human-only protections (FCaptcha) are applied separately to session callers.
//
// Constructed lazily so importing this module without ARCJET_KEY (tests, local
// dev) does not throw; in that case protectV1() is a no-op.

let limiters = null;

function getLimiters() {
  if (limiters) return limiters;
  if (!process.env.ARCJET_KEY) return null;
  const key = process.env.ARCJET_KEY;
  limiters = {
    // Writes create briefs and spend credits: 10/min sustained, bursts of 30.
    write: arcjet({
      key,
      rules: [
        shield({ mode: "LIVE" }),
        tokenBucket({ mode: "LIVE", refillRate: 10, interval: 60, capacity: 30, characteristics: ["callerId"] }),
      ],
    }),
    // Reads (polling brief status) are cheap: 120/min sustained, bursts of 240.
    read: arcjet({
      key,
      rules: [
        shield({ mode: "LIVE" }),
        tokenBucket({ mode: "LIVE", refillRate: 120, interval: 60, capacity: 240, characteristics: ["callerId"] }),
      ],
    }),
  };
  return limiters;
}

// Returns a NextResponse to send if the request is denied, otherwise null.
export async function protectV1(req, { callerId, kind = "read", requested = 1 }) {
  const l = getLimiters();
  if (!l) return null;
  const decision = await l[kind === "write" ? "write" : "read"].protect(req, { callerId, requested });
  if (!decision.isDenied()) return null;
  if (decision.reason.isRateLimit()) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests. Slow down and retry." },
      { status: 429, headers: { "Retry-After": "10" } }
    );
  }
  return NextResponse.json({ error: "forbidden", message: "Request blocked" }, { status: 403 });
}