import "server-only";
import adminSupabase from "@/libs/supabase/admin.mjs";
import { MAX_EPISODE_SECONDS, creditsNeeded, getRegenCost, formatDuration } from "@/libs/credits";
import { resolveEpisode } from "@/libs/podcast/resolve.mjs";
import { ApiError } from "@/libs/api/errors";
import { toPublicBrief } from "@/libs/briefs/serialize.mjs";

// Brief operations shared by the legacy web route (/api/jobs/brief) and the v1
// API (/api/v1/briefs). All business rules live here; routes only do auth,
// rate limiting, captcha, and response shaping.
//
// Uses the admin (service-role) client because the credit RPCs are locked to
// service_role. Every query is scoped by profile_id.

export const APP_ENV = process.env.APP_ENV || "DEVELOPMENT";
const db = adminSupabase;

const BRIEF_COLUMNS =
  "id, profile_id, input_url, status, created_at, started_at, completed_at, output_markdown, " +
  "references, podcast_name, episode_title, regeneration_count, episode_duration_seconds, " +
  "credits_charged, credits_refunded, refunded_at, outcome, error_code, error_message, " +
  "api_key_id, idempotency_key, callback_url";

export function billingUrl() {
  const domain = process.env.NEXT_PUBLIC_DOMAIN_NAME || "www.podcastbrief.app";
  return `https://${domain}/billing`;
}

// Resolves an Apple Podcasts episode URL to metadata + cost. Throws ApiError
// with the same codes the legacy estimate endpoint uses.
export async function quoteEpisode(episodeUrl) {
  if (typeof episodeUrl !== "string" || !episodeUrl.startsWith("https://podcasts.apple.com")) {
    throw new ApiError(
      "invalid_episode_url",
      422,
      "episode_url must be an Apple Podcasts episode link (https://podcasts.apple.com/…?i=…)"
    );
  }

  let episode;
  try {
    episode = await resolveEpisode(episodeUrl);
  } catch (err) {
    if (err.message?.startsWith("[422]")) {
      throw new ApiError(
        "episode_not_found",
        422,
        "Couldn't find this episode. Make sure the link is from Apple Podcasts and points to a specific episode (look for `?i=` in the URL)."
      );
    }
    console.error("resolveEpisode failed:", err.message, err.stack);
    throw new ApiError("episode_lookup_failed", 502, "Something went wrong resolving this episode. Please try again.");
  }

  if (!episode.durationSeconds) {
    throw new ApiError("duration_unknown", 422, "Couldn't determine the length of this episode. Try a different link.");
  }
  if (episode.durationSeconds > MAX_EPISODE_SECONDS) {
    throw new ApiError(
      "episode_too_long",
      422,
      `This episode is ${formatDuration(episode.durationSeconds)}. Episodes up to 4 hours are supported.`,
      { duration_seconds: episode.durationSeconds, max_duration_seconds: MAX_EPISODE_SECONDS }
    );
  }

  return { episode, creditsNeeded: creditsNeeded(episode.durationSeconds) };
}

export async function getBalance(profileId) {
  const { data, error } = await db.from("profiles").select("credits").eq("id", profileId).single();
  if (error) {
    console.error("getBalance failed:", error.message);
    throw new ApiError("internal_error", 500, "Could not read credit balance");
  }
  return data?.credits ?? 0;
}

// Credits charged to briefs created with this key since the start of the
// current UTC month. Used to enforce api_keys.monthly_credit_cap.
export async function monthlyCreditsUsedByKey(apiKeyId) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data, error } = await db
    .from("briefs")
    .select("credits_charged")
    .eq("api_key_id", apiKeyId)
    .gte("created_at", monthStart);
  if (error) {
    console.error("monthlyCreditsUsedByKey failed:", error.message);
    return 0;
  }
  return (data || []).reduce((sum, r) => sum + (r.credits_charged || 0), 0);
}

export async function findByIdempotencyKey(profileId, idempotencyKey) {
  const { data } = await db
    .from("briefs")
    .select(BRIEF_COLUMNS)
    .eq("profile_id", profileId)
    .eq("environment", APP_ENV)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  return data || null;
}

export async function findExistingForUrl(profileId, episodeUrl) {
  const { data } = await db
    .from("briefs")
    .select(BRIEF_COLUMNS)
    .eq("profile_id", profileId)
    .eq("environment", APP_ENV)
    .eq("input_url", episodeUrl)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

export async function getBriefForProfile(profileId, briefId) {
  const { data, error } = await db
    .from("briefs")
    .select(BRIEF_COLUMNS)
    .eq("id", briefId)
    .eq("profile_id", profileId)
    .eq("environment", APP_ENV)
    .maybeSingle();
  if (error && error.code !== "22P02") {
    // 22P02 = invalid uuid; treat as not found
    console.error("getBriefForProfile failed:", error.message);
  }
  return data || null;
}

// Cursor-paginated list (cursor = created_at of the last item returned).
export async function listBriefs(profileId, { limit = 20, status = null, cursor = null } = {}) {
  let query = db
    .from("briefs")
    .select(BRIEF_COLUMNS)
    .eq("profile_id", profileId)
    .eq("environment", APP_ENV)
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (status) query = query.eq("status", status);
  if (cursor) query = query.lt("created_at", cursor);

  const { data, error } = await query;
  if (error) {
    console.error("listBriefs failed:", error.message);
    throw new ApiError("internal_error", 500, "Could not list briefs");
  }
  const rows = data || [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: page, nextCursor: hasMore ? page[page.length - 1].created_at : null };
}

// 1-based position in the queue for a queued brief; null otherwise.
export async function queuePositionFor(row) {
  if (!row || row.status !== "queued") return null;
  const { count, error } = await db
    .from("briefs")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued")
    .eq("environment", APP_ENV)
    .lt("created_at", row.created_at);
  if (error) return null;
  return (count ?? 0) + 1;
}

export async function toBriefResponse(row, { includeContent = true } = {}) {
  const queuePosition = await queuePositionFor(row);
  return toPublicBrief(row, { includeContent, queuePosition });
}

// Post-RPC annotation. Non-critical: the brief is already queued and paid for.
// A 23505 here means two identical requests raced on the same Idempotency-Key;
// the loser's RPC already got `already_exists`, so there is nothing to fix.
async function annotateBrief(briefId, profileId, fields) {
  const { error } = await db
    .from("briefs")
    .update(fields)
    .eq("id", briefId)
    .eq("profile_id", profileId)
    .eq("environment", APP_ENV);
  if (error && error.code !== "23505") {
    console.error("Non-critical: failed to annotate brief:", error.message);
  }
}

// Atomic: dedup + credit check + deduct + insert + ledger, via RPC. Then
// annotates the row with metadata the RPC does not know about.
export async function queueBrief({
  profileId,
  episodeUrl,
  durationSeconds,
  creditsToCharge,
  episodeTitle = null,
  podcastName = null,
  apiKeyId = null,
  idempotencyKey = null,
  callbackUrl = null,
}) {
  const { data: result, error: rpcError } = await db.rpc("consume_credits_and_queue_brief", {
    p_profile_id: profileId,
    p_episode_url: episodeUrl,
    p_duration_seconds: durationSeconds,
    p_credits_to_charge: creditsToCharge,
    p_environment: APP_ENV,
  });

  if (rpcError) {
    // 23505 = unique violation: the partial index caught a race on the same URL.
    if (rpcError.code === "23505") {
      throw new ApiError("already_exists", 409, "A brief for this episode is already in progress");
    }
    console.error("RPC error:", rpcError);
    throw new ApiError("queue_failed", 500, "Failed to queue brief");
  }
  if (result.error === "already_exists") {
    throw new ApiError("already_exists", 409, "You already have a brief for this episode");
  }
  if (result.error === "insufficient_credits") {
    throw new ApiError("insufficient_credits", 402, "Not enough credits for this episode", {
      credits_needed: creditsToCharge,
      credits_remaining: result.credits_remaining,
      top_up_url: billingUrl(),
    });
  }
  if (result.error) {
    console.error("Unexpected RPC error:", result.error);
    throw new ApiError("queue_failed", 500, "Failed to queue brief");
  }

  await annotateBrief(result.brief_id, profileId, {
    episode_title: episodeTitle,
    podcast_name: podcastName,
    api_key_id: apiKeyId,
    idempotency_key: idempotencyKey,
    callback_url: callbackUrl,
  });

  return {
    briefId: result.brief_id,
    creditsCharged: result.credits_charged,
    creditsRemaining: result.credits_remaining,
  };
}

// Regeneration: free within 24h of completion, full price after. Pre-credit
// briefs (credits_charged NULL) are always free. Resets outcome/error/webhook
// state so the re-run reports fresh results.
export async function regenerateBrief({ profileId, episodeUrl, apiKeyId = null, callbackUrl = null, idempotencyKey = null }) {
  const { data: inProgress } = await db
    .from("briefs")
    .select("id")
    .eq("input_url", episodeUrl)
    .eq("profile_id", profileId)
    .eq("environment", APP_ENV)
    .in("status", ["queued", "generating"])
    .maybeSingle();
  if (inProgress) {
    throw new ApiError("brief_in_progress", 409, "A brief for this episode is already being generated", {
      brief_id: inProgress.id,
    });
  }

  const { data: completed } = await db
    .from("briefs")
    .select("id, credits_charged, completed_at")
    .eq("input_url", episodeUrl)
    .eq("profile_id", profileId)
    .eq("environment", APP_ENV)
    .eq("status", "complete")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!completed) {
    throw new ApiError("no_completed_brief", 404, "No completed brief found to regenerate");
  }

  const regenCost = getRegenCost(completed.completed_at, completed.credits_charged);

  const { data: result, error: rpcError } = await db.rpc("consume_credits_and_regenerate_brief", {
    p_profile_id: profileId,
    p_brief_id: completed.id,
    p_credits_to_charge: regenCost,
    p_environment: APP_ENV,
  });

  if (rpcError) {
    console.error("RPC error:", rpcError);
    throw new ApiError("queue_failed", 500, "Failed to queue regeneration");
  }
  if (result.error === "insufficient_credits") {
    throw new ApiError("insufficient_credits", 402, "Not enough credits to regenerate", {
      credits_needed: regenCost,
      credits_remaining: result.credits_remaining,
      top_up_url: billingUrl(),
    });
  }
  if (result.error === "already_regenerated") {
    throw new ApiError("already_regenerated", 409, "This brief has already been regenerated");
  }
  if (result.error) {
    console.error("Unexpected regen RPC error:", result.error);
    throw new ApiError("queue_failed", 500, "Failed to queue regeneration");
  }

  await annotateBrief(completed.id, profileId, {
    outcome: null,
    error_code: null,
    error_message: null,
    webhook_attempts: 0,
    webhook_last_status: null,
    webhook_last_attempt_at: null,
    webhook_delivered_at: null,
    ...(apiKeyId ? { api_key_id: apiKeyId } : {}),
    ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  });

  return {
    briefId: completed.id,
    creditsCharged: result.credits_charged,
    creditsRemaining: result.credits_remaining,
  };
}