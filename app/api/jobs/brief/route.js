import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import { MAX_EPISODE_SECONDS, creditsNeeded as calcCredits } from "@/libs/credits";
import { verifyEstimate } from "@/libs/estimate-signer";
import { getPostHog } from "@/libs/posthog/server";
import { ApiError } from "@/libs/api/error";
import { queueBrief, regenerateBrief } from "@/libs/briefs/service";
import { verifyHuman, extractFCaptchaToken, humanCheckResponse } from "@/libs/fcaptcha/server";
import arcjet, { shield, tokenBucket, detectBot } from "@arcjet/next";

// Legacy web-app endpoint. The browser UI posts here; agents use /api/v1/briefs.
// Business logic lives in libs/briefs/service.js (shared with v1); this route
// keeps the original request/response shape so the frontend is unchanged, apart
// from one optional new body field: `fcaptchaToken`.
//
// Single Arcjet decision: shield + bot detection + per-user token bucket. Bot
// detection stays ON here because this route is for humans in a browser; the
// agent-facing v1 routes deliberately omit it.
const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({ mode: "LIVE" }),
    tokenBucket({
      mode: "LIVE",
      refillRate: 2,   // 2 tokens per minute
      interval: 60,    // refill interval in seconds
      capacity: 10,    // max burst size
      characteristics: ["userId"],
    }),
    detectBot({ mode: "LIVE", allow: [] }),
  ],
});

// Translate ApiError into the response shapes the existing frontend expects.
function legacyErrorResponse(err, fallbackMessage) {
  if (err instanceof ApiError) {
    if (err.code === "insufficient_credits") {
      return NextResponse.json(
        {
          error: "insufficient_credits",
          creditsRemaining: err.extra.credits_remaining,
          creditsNeeded: err.extra.credits_needed,
        },
        { status: 402 }
      );
    }
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error("Unhandled error in /api/jobs/brief:", err);
  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { episodeUrl, durationSeconds, regenerate, sig, episodeTitle, podcastName } = body;
    if (!episodeUrl) {
      return NextResponse.json({ error: "episodeUrl required" }, { status: 400 });
    }

    const authSupabase = await createClient();
    const { data: { user }, error } = await authSupabase.auth.getUser();
    if (error || !user) {
      console.error("Auth failed:", error?.message ?? "no user");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Rate limit AFTER auth — tracked per user, not per IP
    const decision = await aj.protect(req, { userId: user.id, requested: 1 });
    if (decision.isDenied()) {
      if (decision.reason.isBot()) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    // FCaptcha (human check). Behaviour depends on FCAPTCHA_MODE — see
    // libs/fcaptcha/server.js. The action is bound into the token, so a token
    // minted for a regenerate click cannot be spent on a fresh submission.
    const human = await verifyHuman(req, {
      token: extractFCaptchaToken(req, body),
      action: regenerate ? "brief_regenerate" : "brief_submit",
    });
    if (!human.ok) return humanCheckResponse(human);

    // Regen path FIRST — regen requests don't send durationSeconds
    if (regenerate) {
      try {
        const r = await regenerateBrief({ profileId: user.id, episodeUrl });
        return NextResponse.json({
          status: "queued",
          briefId: r.briefId,
          creditsCharged: r.creditsCharged,
          creditsRemaining: r.creditsRemaining,
        });
      } catch (err) {
        return legacyErrorResponse(err, "Failed to queue regeneration");
      }
    }

    // New brief — validate durationSeconds server-side (defense in depth)
    if (!Number.isInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_EPISODE_SECONDS) {
      return NextResponse.json({ error: "Invalid or out-of-range episode duration" }, { status: 422 });
    }

    // Verify the estimate signature — prevents clients from forging a low durationSeconds
    // to pay fewer credits. The sig was produced by the estimate endpoint using HMAC.
    if (!sig || !verifyEstimate(episodeUrl, durationSeconds, sig)) {
      return NextResponse.json(
        { error: "Detected modification in duration info, please send a request again." },
        { status: 422 }
      );
    }

    const needed = calcCredits(durationSeconds);

    let queued;
    try {
      queued = await queueBrief({
        profileId: user.id,
        episodeUrl,
        durationSeconds,
        creditsToCharge: needed,
        episodeTitle: episodeTitle || null,
        podcastName: podcastName || null,
      });
    } catch (err) {
      return legacyErrorResponse(err, "Failed to queue brief");
    }

    const posthog = getPostHog();
    posthog?.capture({
      distinctId: user.id,
      event: "brief_queued",
      properties: { episode_url: episodeUrl, source: "web" },
    });
    posthog?.flush().catch((e) => console.error("[posthog] flush failed:", e.message));

    return NextResponse.json({
      status: "queued",
      briefId: queued.briefId,
      creditsCharged: queued.creditsCharged,
      creditsRemaining: queued.creditsRemaining,
    });
  } catch (e) {
    console.error("Unhandled error in /api/jobs/brief:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}