import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import { getBriefForProfile } from "@/libs/briefs/service";
import { protectV1 } from "@/libs/arcjet/v1";
import { resolveIdentity } from "@/libs/auth/identity";

// Get one owned brief by ID (agent read access)
export async function GET(req, { params }) {
  try {
    // Task 7: Use proper bearer identity resolution
    const identity = await resolveIdentity(req);
    if (identity.error) {
      return NextResponse.json({ error: identity.error.code, message: identity.error.message }, { status: identity.error.status });
    }

    // Check that this identity has read scope
    if (identity.kind === "api_key") {
      // Check that this API key has the required 'briefs:read' scope  
      const hasReadScope = identity.apiKey.scopes.includes("briefs:read");
      if (!hasReadScope) {
        return NextResponse.json({
          error: "insufficient_scope",
          message: "This API key lacks the briefs:read scope"
        }, { status: 403 });
      }
    }

    // Arcjet shield + per-caller rate limit, no bot detection
    const denied = await protectV1(req, { callerId: identity.callerId, kind: "read" });
    if (denied) return denied;

    const { id } = params;
    if (!id) {
      return NextResponse.json({ error: "Brief ID required" }, { status: 400 });
    }

    // Task 8: Properly scope the query by profile_id
    const brief = await getBriefForProfile(identity.profileId, id);
    
    if (!brief) {
      return NextResponse.json({ error: "Brief not found" }, { status: 404 });
    }

    // Task 8: Return safe fields only (no error_log)
    return NextResponse.json({
      id: brief.id,
      status: brief.status,
      episode_title: brief.episode_title,
      podcast_name: brief.podcast_name,
      output_markdown: brief.output_markdown,
      created_at: brief.created_at
    });
  } catch (e) {
    console.error("Unhandled error in /api/v1/briefs/[id]:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}