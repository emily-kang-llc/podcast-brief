import "server-only";
import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import adminSupabase from "@/libs/supabase/admin.mjs";
import { hashApiKey, looksLikeApiKey } from "@/libs/api-keys.mjs";

// Resolves "who is calling" for both humans (Supabase cookie session) and agents
// (Authorization: Bearer pb_…). Returns one of:
//   { kind: "session", profileId, callerId, user }
//   { kind: "api_key", profileId, callerId, apiKey: { id, name, scopes, monthlyCreditCap, callbackUrl } }
//   { error: { status, code, message } }
//
// Downstream code only needs profileId, which is what makes the rest of the app
// (credit RPCs, RLS-bypassing admin queries scoped by profile_id) identical for
// both caller types.

const APP_ENV = process.env.APP_ENV || "DEVELOPMENT";
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export const SCOPES = Object.freeze(["briefs:read", "briefs:write"]);

export async function resolveIdentity(req) {
  const header = req.headers.get("authorization") || "";
  if (/^Bearer\s+/i.test(header)) {
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (looksLikeApiKey(token)) return resolveApiKey(token);
    return unauthorized("invalid_api_key", "Malformed API key. Keys look like pb_live_<48 hex chars>.");
  }
  return resolveSession();
}

async function resolveApiKey(rawKey) {
  const { data: key, error } = await adminSupabase
    .from("api_keys")
    .select("id, profile_id, name, scopes, monthly_credit_cap, callback_url, revoked_at, last_used_at, environment")
    .eq("key_hash", hashApiKey(rawKey))
    .maybeSingle();

  if (error) {
    console.error("[identity] api_keys lookup failed:", error.message);
    return { error: { status: 500, code: "auth_unavailable", message: "Could not verify API key" } };
  }
  if (!key || key.revoked_at) return unauthorized("invalid_api_key", "Unknown or revoked API key");
  if (key.environment !== APP_ENV) {
    return unauthorized("invalid_api_key", `This key was issued for ${key.environment} and cannot be used here`);
  }

  await touchLastUsed(key);

  return {
    kind: "api_key",
    profileId: key.profile_id,
    callerId: `key:${key.id}`,
    apiKey: {
      id: key.id,
      name: key.name,
      scopes: Array.isArray(key.scopes) ? key.scopes : [],
      monthlyCreditCap: key.monthly_credit_cap,
      callbackUrl: key.callback_url,
    },
  };
}

// Throttled so a busy agent does not turn every request into a write.
async function touchLastUsed(key) {
  const last = key.last_used_at ? Date.parse(key.last_used_at) : 0;
  if (Date.now() - last < LAST_USED_WRITE_INTERVAL_MS) return;
  const { error } = await adminSupabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", key.id);
  if (error) console.error("[identity] last_used_at update failed:", error.message);
}

async function resolveSession() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return unauthorized("unauthorized", "Sign in, or send an API key as Authorization: Bearer pb_…");
  }
  return { kind: "session", profileId: user.id, callerId: `user:${user.id}`, user };
}

function unauthorized(code, message) {
  return { error: { status: 401, code, message } };
}

// Sessions have every scope; API keys carry an explicit list.
export function hasScope(identity, scope) {
  if (identity.kind === "session") return true;
  return identity.apiKey.scopes.includes(scope);
}

export function identityErrorResponse(identity) {
  const e = identity.error;
  const headers = e.status === 401 ? { "WWW-Authenticate": 'Bearer realm="podcastbrief"' } : {};
  return NextResponse.json({ error: e.code, message: e.message }, { status: e.status, headers });
}

export function scopeErrorResponse(scope) {
  return NextResponse.json(
    { error: "insufficient_scope", message: `This API key lacks the ${scope} scope` },
    { status: 403 }
  );
}