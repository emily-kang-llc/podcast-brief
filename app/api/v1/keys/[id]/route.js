import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import adminSupabase from "@/libs/supabase/admin.mjs";
import { protectV1 } from "@/libs/arcjet/v1";
import { jsonError, handleRouteError } from "@/libs/api/errors";

const APP_ENV = process.env.APP_ENV || "DEVELOPMENT";

// DELETE /api/v1/keys/:id — revoke. Idempotent: revoking twice returns 200.
// Briefs created with the key keep their api_key_id for accounting.
export async function DELETE(req, { params }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return jsonError(401, "unauthorized", "Sign in to revoke API keys");

    const limited = await protectV1(req, { callerId: `user:${user.id}`, kind: "write" });
    if (limited) return limited;

    const { id } = await params;
    const { data, error } = await adminSupabase
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .eq("profile_id", user.id)
      .eq("environment", APP_ENV)
      .is("revoked_at", null)
      .select("id, revoked_at");

    if (error && error.code !== "22P02") {
      console.error("api_keys revoke failed:", error.message);
      return jsonError(500, "internal_error", "Could not revoke API key");
    }

    if (!data?.length) {
      // Either it never existed for this user, or it was already revoked.
      const { data: existing } = await adminSupabase
        .from("api_keys")
        .select("id, revoked_at")
        .eq("id", id)
        .eq("profile_id", user.id)
        .maybeSingle();
      if (!existing) return jsonError(404, "not_found", "No API key with that id");
      return NextResponse.json({ object: "api_key", id: existing.id, revoked_at: existing.revoked_at, revoked: true });
    }

    return NextResponse.json({ object: "api_key", id: data[0].id, revoked_at: data[0].revoked_at, revoked: true });
  } catch (err) {
    return handleRouteError(err, "DELETE /api/v1/keys/:id");
  }
}