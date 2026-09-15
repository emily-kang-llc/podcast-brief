import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import { verifyHuman, extractFCaptchaToken, humanCheckResponse } from "@/libs/fcaptcha/server";
import arcjet, { shield, slidingWindow } from "@arcjet/next";

// Signin/signup (magic link) proxy. The OTP call used to go straight from the
// browser to Supabase Auth, so there was no server choke point to hang a
// captcha on — and the send path is how attackers farm 3-free-credit accounts
// and burn the email quota. This route verifies FCaptcha (action "signup"),
// then triggers the OTP email via a cookie-bound server client. That client
// writes the PKCE verifier cookie the callback needs to exchange the code.
//
// No detectBot: this is the auth path (like /api/auth/callback), and FCaptcha
// is the bot detector here. Email prefetchers never hit this POST route.
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

    const body = await req.json();
    if (!body.email) {
      return NextResponse.json({ error: "email required" }, { status: 400 });
    }

    // Only allow the expected OTP fields that auth-js generates
    const expectedFields = ["email", "options"];
    const bodyKeys = Object.keys(body);
    const invalidFields = bodyKeys.filter(key => !expectedFields.includes(key));
    if (invalidFields.length > 0) {
      console.warn("[auth/signin] Unexpected fields in OTP request:", invalidFields);
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    // Extract token that arrives as X-FCaptcha-Token header
    const fcaptchaToken = extractFCaptchaToken(req, body);
    const human = await verifyHuman(req, {
      token: fcaptchaToken,
      action: "signup",
    });
    if (!human.ok) return humanCheckResponse(human);

    const emailRedirectTo = new URL("/api/auth/callback", req.url).toString();
    
    // Use the server client to initiate the OTP (this preserves the PKCE cookie)
    const supabase = await createClient();
    
    // The browser client created in the page.js will have the PKCE verifiers in cookies
    // We should forward the actual body that Supabase auth expects
    const { error } = await supabase.auth.signInWithOtp({
      email: body.email,
      options: {
        emailRedirectTo,
      },
    });

    // Deliberately 200 with { error } in the body — mirrors the supabase-js
    // shape the page already understands (including the over_email_send_rate_limit
    // code) and avoids the apiClient interceptor turning the error into a toast.
    if (error) {
      console.error("[auth/signin] signInWithOtp error:", error.message);
      return NextResponse.json({ ok: false, error: { code: error.code, message: error.message } });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Unhandled error in /api/auth/signin:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}