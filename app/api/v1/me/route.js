import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import { resolveIdentity, identityErrorResponse } from "@/libs/auth/identity";
import { getBalance } from "@/libs/briefs/service";
import { protectV1 } from "@/libs/arcjet/v1";

// Identity/scopes/balance for the current caller. Works with either a cookie
// session or a Bearer API key; agents use this to check their key works and
// how many credits remain before submitting a brief.
export async function GET(req) {
  try {
    const identity = await resolveIdentity(req);
    if (identity.error) return identityErrorResponse(identity);

    // Arcjet shield + per-caller rate limit, no bot detection
    const denied = await protectV1(req, { callerId: identity.callerId, kind: "read" });
    if (denied) return denied;

    const credits_remaining = await getBalance(identity.profileId);

    return NextResponse.json({
      identity_type: identity.kind === "api_key" ? "api_key" : "session",
      scopes: identity.kind === "api_key" ? identity.apiKey.scopes : ["briefs:read", "briefs:write"],
      credits_remaining,
    });
  } catch (e) {
    console.error("Unhandled error in /api/v1/me:", e.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
