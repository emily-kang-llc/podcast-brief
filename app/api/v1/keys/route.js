import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import adminSupabase from "@/libs/supabase/admin.mjs";
import { protectV1 } from "@/libs/arcjet/v1";
import { jsonError, handleRouteError } from "@/libs/api/errors";
import { verifyHuman, extractFCaptchaToken, humanCheckResponse } from "@/libs/fcaptcha/server";
import { generateApiKey, generateWebhookSecret, validateCallbackUrl } from "@/libs/api-keys.mjs";
import { SCOPES } from "@/libs/auth/identity";

// API key management. Session (cookie) auth only: minting and revoking keys is
// a human act, and letting a key create more keys would make revocation
// meaningless. FCaptcha guards creation (action "api_key_create").

const APP_ENV = process.env.APP_ENV || "DEVELOPMENT";
const MAX_ACTIVE_KEYS = 10;

async function requireSession() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user || null;
}

// POST /api/v1/keys { name?, monthly_credit_cap?, callback_url?, scopes?, fcaptchaToken? }
// The raw key and callback_secret are returned ONCE. Only hashes/prefixes persist.
export async function POST(req) {
  try {
    const user = await requireSession();
    if (!user) return jsonError(401, "unauthorized", "Sign in to create API keys");

    const limited = await protectV1(req, { callerId: `user:${user.id}`, kind: "write" });
    if (limited) return limited;

    let body = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const human = await verifyHuman(req, { token: extractFCaptchaToken(req, body), action: "api_key_create" });
    if (!human.ok) return humanCheckResponse(human);

    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 64) : "default";

    let monthlyCap = null;
    if (body.monthly_credit_cap != null) {
      if (!Number.isInteger(body.monthly_credit_cap) || body.monthly_credit_cap < 0) {
        return jsonError(422, "invalid_monthly_credit_cap", "monthly_credit_cap must be a non-negative integer");
      }
      monthlyCap = body.monthly_credit_cap;
    }

    let callbackUrl = null;
    if (body.callback_url != null && body.callback_url !== "") {
      const problem = validateCallbackUrl(body.callback_url);
      if (problem) return jsonError(422, "invalid_callback_url", problem);
      callbackUrl = body.callback_url;
    }

    let scopes = [...SCOPES];
    if (Array.isArray(body.scopes)) {
      const invalid = body.scopes.filter((s) => !SCOPES.includes(s));
      if (invalid.length) return jsonError(422, "invalid_scopes", `Unknown scopes: ${invalid.join(", ")}`);
      if (body.scopes.length === 0) return jsonError(422, "invalid_scopes", "At least one scope is required");
      scopes = [...new Set(body.scopes)];
    }

    const { count } = await adminSupabase
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", user.id)
      .eq("environment", APP_ENV)
      .is("revoked_at", null);
    if ((count ?? 0) >= MAX_ACTIVE_KEYS) {
      return jsonError(409, "too_many_keys", `You can have at most ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);
    }

    const { key, hash, displayPrefix } = generateApiKey(APP_ENV);
    const callbackSecret = generateWebhookSecret();

    const { data: row, error } = await adminSupabase
      .from("api_keys")
      .insert({
        profile_id: user.id,
        name,
        key_prefix: displayPrefix,
        key_hash: hash,
        scopes,
        monthly_credit_cap: monthlyCap,
        callback_url: callbackUrl,
        callback_secret: callbackSecret,
        environment: APP_ENV,
      })
      .select("id, name, key_prefix, scopes, monthly_credit_cap, callback_url, created_at")
      .single();

    if (error) {
      console.error("api_keys insert failed:", error.message);
      return jsonError(500, "internal_error", "Could not create API key");
    }

    return NextResponse.json(
      {
        object: "api_key",
        ...row,
        key,
        callback_secret: callbackSecret,
        warning: "Store `key` and `callback_secret` now. They are not retrievable later.",
      },
      { status: 201 }
    );
  } catch (err) {
    return handleRouteError(err, "POST /api/v1/keys");
  }
}

// GET /api/v1/keys — list this user's keys (no secrets).
export async function GET(req) {
  try {
    const user = await requireSession();
    if (!user) return jsonError(401, "unauthorized", "Sign in to list API keys");

    const limited = await protectV1(req, { callerId: `user:${user.id}`, kind: "read" });
    if (limited) return limited;

    const { data, error } = await adminSupabase
      .from("api_keys")
      .select("id, name, key_prefix, scopes, monthly_credit_cap, callback_url, created_at, last_used_at, revoked_at")
      .eq("profile_id", user.id)
      .eq("environment", APP_ENV)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("api_keys list failed:", error.message);
      return jsonError(500, "internal_error", "Could not list API keys");
    }
    return NextResponse.json({ object: "list", data: data.map((k) => ({ object: "api_key", ...k })) });
  } catch (err) {
    return handleRouteError(err, "GET /api/v1/keys");
  }
}