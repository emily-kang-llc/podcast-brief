import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import { queueBrief, quoteEpisode, getBalance, billingUrl } from "@/libs/briefs/service";
import { protectV1 } from "@/libs/arcjet/v1";
import { ApiError } from "@/libs/api/error";
import { resolveIdentity } from "@/libs/auth/identity";

// Create a brief (agent write access)
export async function POST(req) {
  try {
    // Task 7: Use proper bearer identity resolution
    const identity = await resolveIdentity(req);
    if (identity.error) {
      return NextResponse.json({ error: identity.error.code, message: identity.error.message }, { status: identity.error.status });
    }

    // Check that this identity has write scope
    if (identity.kind === "api_key") {
      // Check that this API key has the required 'briefs:write' scope  
      const hasWriteScope = identity.apiKey.scopes.includes("briefs:write");
      if (!hasWriteScope) {
        return NextResponse.json({
          error: "insufficient_scope",
          message: "This API key lacks the briefs:write scope"
        }, { status: 403 });
      }
    }

    const body = await req.json();
    const { episodeUrl } = body;

    if (!episodeUrl) {
      return NextResponse.json({ error: "Episode URL required" }, { status: 400 });
    }

    // Arcjet shield + per-caller rate limit, no bot detection
    const denied = await protectV1(req, { callerId: identity.callerId, kind: "write" });
    if (denied) return denied;

    // Task 8: Handle episode quoting and cost resolution using shared service function
    let episode, creditsNeeded;
    try {
      ({ episode, creditsNeeded } = await quoteEpisode(episodeUrl));
    } catch (err) {
      if (err instanceof ApiError) {
        return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
      }
      throw err;
    }

    // For API key requests, we already have profileId from the key
    const profileId = identity.profileId;

    // Check user's balance
    const balance = await getBalance(profileId);
      
    // Check for URL deduplication
    const authSupabase = await createClient();
    const { data: existingBrieftData, error: existingBrieftError } = await authSupabase
      .from("briefs")
      .select("id,status")
      .eq("profile_id", profileId)
      .eq("input_url", episodeUrl)
      .eq("environment", process.env.APP_ENV)
      .single();
      
    if (existingBrieftData) {
      // User already has a job with this URL - if it's queued or generating, 409
      if (["queued", "generating"].includes(existingBrieftData.status)) {
        return NextResponse.json({
          error: "brief_already_queued",
          brief_id: existingBrieftData.id,
          status: existingBrieftData.status,
          status_url: `${process.env.NEXT_PUBLIC_DOMAIN_NAME}/api/v1/briefs/${existingBrieftData.id}`
        }, { status: 409 });
      }
    }

    // Check if brief already exists
    const { data: completedBriefData, error: completedBriefError } = await authSupabase
      .from("briefs")
      .select("id")
      .eq("profile_id", profileId)
      .eq("input_url", episodeUrl)
      .eq("environment", process.env.APP_ENV)
      .eq("status", "complete")
      .single();
      
    if (completedBriefData) {
      return NextResponse.json({
        error: "brief_already_exists",
        brief_id: completedBriefData.id,
      }, { status: 409 });
    }

    // Task 8: Use the shared principle of using credits from the balance
    // Check if user has enough credits for this episode
    if (creditsNeeded > balance) {
      return NextResponse.json({
        error: "insufficient_credits",
        credits_needed: creditsNeeded,
        credits_remaining: balance,
        top_up_url: billingUrl()
      }, { status: 402 });
    }

    // Task 8: Queue the brief with proper credentials (from API key or user)
    const queued = await queueBrief({
      profileId: profileId,
      episodeUrl,
      durationSeconds: episode.durationSeconds,
      creditsToCharge: creditsNeeded, 
      episodeTitle: episode.title,
      podcastName: episode.podcastName,
      apiKeyId: identity.kind === "api_key" ? identity.apiKey.id : null
    });

    const location = `${process.env.NEXT_PUBLIC_DOMAIN_NAME}/api/v1/briefs/${queued.briefId}`;
    
    return NextResponse.json({
      brief_id: queued.briefId,
      status: "queued",
      credits_charged: queued.creditsCharged,
      credits_remaining: queued.creditsRemaining,
    }, {
      status: 202,
      headers: {
        "Location": location,
        "Retry-After": "30"
      }
    });
  } catch (e) {
    console.error("Unhandled error in /api/v1/briefs:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}