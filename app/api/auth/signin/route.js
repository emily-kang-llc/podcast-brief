import { NextResponse } from "next/server";
import { verifyHuman, extractFCaptchaToken, humanCheckResponse } from "@/libs/fcaptcha/server";
import { cleanUrl } from "@/libs/url.mjs";
import arcjet, { shield, slidingWindow } from "@arcjet/next";

// Signin/signup (magic-link) proxy. The browser's Supabase client generates
// and stores the PKCE verifier itself; its /auth/v1/otp HTTP request (which
// carries the code_challenge) is rerouted here by libs/auth/browser-otp-client.
// This route verifies FCaptcha (action "signup"), then forwards the EXACT OTP
// body to a fixed Supabase Auth endpoint with the public anon key. It never
// calls signInWithOtp() server-side (that breaks the PKCE callback) and never
// uses SUPABASE_SECRET_KEY.
//
// No detectBot: this is the auth path (like /api/auth/callback), and FCaptcha
// is the bot detector here.
const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({ mode: "LIVE" }),
    // Same per-IP budget as the callback — user-initiated, so 10 per 10
    // minutes is generous for retypes, tight enough for OTP spam.
    slidingWindow({ mode: "LIVE", interval: "10m", max: 10 }),
  ],
});

export const dynamic = "force-dynamic";

// Fields auth-js sends in the OTP body. Anything else is rejected so this
// route can never become an arbitrary Supabase write proxy.
const ALLOWED_OTP_FIELDS = new Set([
  "email",
  "create_user",
  "data",
  "gotrue_meta_security",
  "code_challenge",
  "code_challenge_method",
]);

export async function POST(req) {
  try {
    const decision = await aj.protect(req);
    if (decision.isDenied()) {
      const status = decision.reason.isRateLimit() ? 429 : 403;
      return NextResponse.json(
        { error: decision.reason.isRateLimit() ? "Too many requests" : "Forbidden" },
        { status }
      );
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!body || typeof body.email !== "string" || !body.email.includes("@")) {
      return NextResponse.json({ error: "email required" }, { status: 400 });
    }

    const unexpected = Object.keys(body).filter((k) => !ALLOWED_OTP_FIELDS.has(k));
    if (unexpected.length > 0) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    // The whole point of this design: the browser owns PKCE. An OTP request
    // without a challenge means the caller bypassed auth-js — reject it.
    if (typeof body.code_challenge !== "string" || !body.code_challenge) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const fcaptchaToken = extractFCaptchaToken(req, body);
    const human = await verifyHuman(req, {
      token: fcaptchaToken,
      action: "signup",
    });
    if (!human.ok) return humanCheckResponse(human);

    // Fixed upstream target — this route is not an open proxy. Public anon
    // key only; no service-role credentials anywhere in this file.
    const upstream = `${cleanUrl("NEXT_PUBLIC_SUPABASE_URL")}/auth/v1/otp`;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    const res = await fetch(upstream, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });

    // Relay only the status and the safe JSON body auth-js expects.
    const text = await res.text();
    return new Response(text || "{}", {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Unhandled error in /api/auth/signin:", e.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
