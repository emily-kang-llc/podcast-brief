import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import { protectV1 } from "@/libs/arcjet/v1";

// Get user identity information (api v1)
export async function GET(req) {
  try {
    const authSupabase = await createClient();
    const { data: { user }, error } = await authSupabase.auth.getUser();
    if (error || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Arcjet shield + per-caller rate limit, no bot detection
    const denied = await protectV1(req, { callerId: user.id, kind: "read" });
    if (denied) return denied;

    // Fetch user's credits and profile info
    const { data: creditsData, error: creditsError } = await authSupabase
      .from("profiles")
      .select("credits")
      .eq("id", user.id)
      .single();
      
    if (creditsError) {
      console.error("Error fetching user credits:", creditsError);
      return NextResponse.json({ error: "Failed to fetch user data" }, { status: 500 });
    }

    return NextResponse.json({
      user_id: user.id,
      scopes: ["briefs:read", "briefs:write"],  // Session has both scopes
      credits_remaining: creditsData.credits,
    });
  } catch (e) {
    console.error("Unhandled error in /api/v1/me:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}