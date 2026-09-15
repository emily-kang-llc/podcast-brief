import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import { getBriefForProfile } from "@/libs/briefs/service";
import { protectV1 } from "@/libs/arcjet/v1";

// Get one owned brief by ID (agent read access)
export async function GET(req, { params }) {
  try {
    const authSupabase = await createClient();
    const { data: { user }, error } = await authSupabase.auth.getUser();
    if (error || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Arcjet shield + per-caller rate limit, no bot detection
    const denied = await protectV1(req, { callerId: user.id, kind: "read" });
    if (denied) return denied;

    const { id } = params;
    if (!id) {
      return NextResponse.json({ error: "Brief ID required" }, { status: 400 });
    }

    const brief = await getBriefForProfile(user.id, id);
    
    if (!brief) {
      return NextResponse.json({ error: "Brief not found" }, { status: 404 });
    }

    return NextResponse.json(brief);
  } catch (e) {
    console.error("Unhandled error in /api/v1/briefs/[id]:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}