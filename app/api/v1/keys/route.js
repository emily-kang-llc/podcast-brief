import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import { protectV1 } from "@/libs/arcjet/v1";
import { verifyHuman, extractFCaptchaToken, humanCheckResponse } from "@/libs/fcaptcha/server";
import { generateApiKey } from "@/libs/api-keys.mjs";
import { ApiError } from "@/libs/api/error";

// List API keys (session-only, human access)
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

    // Fetch user's API keys (excluding the secret hash)
    const { data, error: fetchError } = await authSupabase
      .from("api_keys")
      .select("id,created_at,revoked_at,description")
      .eq("profile_id", user.id)
      .order("created_at", { ascending: false });
      
    if (fetchError) {
      console.error("Error fetching API keys:", fetchError);
      return NextResponse.json({ error: "Failed to fetch API keys" }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (e) {
    console.error("Unhandled error in /api/v1/keys:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// Create a new API key (session-only, human access, requires FCaptcha)
export async function POST(req) {
  try {
    const body = await req.json();
    const { description } = body;
    
    const authSupabase = await createClient();
    const { data: { user }, error } = await authSupabase.auth.getUser();
    if (error || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Arcjet shield + per-caller rate limit, no bot detection
    const denied = await protectV1(req, { callerId: user.id, kind: "write" });
    if (denied) return denied;

    // FCaptcha verification for api_key_create action
    const human = await verifyHuman(req, {
      token: extractFCaptchaToken(req, body),
      action: "api_key_create",
    });
    if (!human.ok) return humanCheckResponse(human);

    // Generate new API key
    const { key, hash, displayPrefix } = generateApiKey(process.env.APP_ENV || "DEVELOPMENT");
    
    // Store in DB
    const { data, error: insertError } = await authSupabase
      .from("api_keys")
      .insert({
        profile_id: user.id,
        description: description || "",
        key_hash: hash,
        key_prefix: displayPrefix,
        environment: process.env.APP_ENV || "DEVELOPMENT",
      })
      .select()
      .single();
      
    if (insertError) {
      console.error("Error creating API key:", insertError);
      return NextResponse.json({ error: "Failed to create API key" }, { status: 500 });
    }

    // Return only the raw key once, and the metadata
    return NextResponse.json({ 
      raw: key, 
      id: data.id, 
      prefix: data.key_prefix 
    });
  } catch (e) {
    console.error("Unhandled error in /api/v1/keys POST:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}