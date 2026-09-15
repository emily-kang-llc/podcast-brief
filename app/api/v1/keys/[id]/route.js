import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import { protectV1 } from "@/libs/arcjet/v1";

// Revoke an API key (session-only, human access)
export async function DELETE(req, { params }) {
  try {
    const authSupabase = await createClient();
    const { data: { user }, error } = await authSupabase.auth.getUser();
    if (error || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = params;

    // Arcjet shield + per-caller rate limit, no bot detection
    const denied = await protectV1(req, { callerId: user.id, kind: "write" });
    if (denied) return denied;

    if (!id) {
      return NextResponse.json({ error: "API Key ID required" }, { status: 400 });
    }

    // Revoking an API key is a no-FCaptcha operation - just changing state
    const { data, error: updateError } = await authSupabase
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .eq("profile_id", user.id)
      .select()
      .single();
      
    if (updateError) {
      console.error("Error revoking API key:", updateError);
      return NextResponse.json({ error: "Failed to revoke API key" }, { status: 500 });
    }

    return NextResponse.json({ revoked: true });
  } catch (e) {
    console.error("Unhandled error in /api/v1/keys/[id]:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}