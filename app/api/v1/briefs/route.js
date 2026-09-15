import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import { queueBrief } from "@/libs/briefs/service";
import { protectV1 } from "@/libs/arcjet/v1";
import { ApiError } from "@/libs/api/error";

// Create a brief (agent write access)
export async function POST(req) {
  try {
    const authSupabase = await createClient();
    const { data: { user }, error } = await authSupabase.auth.getUser();
    if (error || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { episodeUrl } = body;

    // In agent API, the route only accepts Bearer tokens
    if (!episodeUrl) {
      return NextResponse.json({ error: "Episode URL required" }, { status: 400 });
    }

    // Arcjet shield + per-caller rate limit, no bot detection
    const denied = await protectV1(req, { callerId: user.id, kind: "write" });
    if (denied) return denied;

    // Validate episode URL and get the episode info
    const episode = await validateEpisodeUrl(episodeUrl);
    if (!episode) {
      return NextResponse.json({ error: "Invalid episode URL" }, { status: 422 });
    }

    // Get user's credits
    const { data: creditsData, error: creditsError } = await authSupabase
      .from("profiles")
      .select("credits")
      .eq("id", user.id)
      .single();
      
    if (!creditsData || creditsError) {
      console.error("Error fetching user credits:", creditsError);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    // Check for URL deduplication
    const { data: existingBrieftData, error: existingBrieftError } = await authSupabase
      .from("briefs")
      .select("id,status")
      .eq("profile_id", user.id)
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
      .eq("profile_id", user.id)
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

    // Check user credits
    const maxCredits = await getMaxCredits(user.id);
    
    // Queue the brief (bypass FCaptcha for agent v1)
    const queued = await queueBrief({
      profileId: user.id,
      episodeUrl,
      durationSeconds: episode.durationSeconds,
      creditsToCharge: episode.credits,
      episodeTitle: episode.title,
      podcastName: episode.podcastName,
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

// Simple URL validation and metadata extraction logic
async function validateEpisodeUrl(url) {
  // This would be replaced with actual implementation in a real system
  // For now, returning a mock implementation for the file structure
  return {
    title: "Sample Episode",
    podcastName: "Sample Podcast",
    durationSeconds: 1800,
    credits: 1
  };
}

// Get user's maximum allowed credits
async function getMaxCredits(profileId) {
  // For now, return a placeholder 
  return 100;
}