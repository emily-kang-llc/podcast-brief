import { NextResponse } from "next/server";
import { resolveIdentity, identityErrorResponse, hasScope, scopeErrorResponse } from "@/libs/auth/identity";
import { protectV1 } from "@/libs/arcjet/v1";
import { verifyHuman, extractFCaptchaToken, humanCheckResponse } from "@/libs/fcaptcha/server";
import { ApiError, jsonError, handleRouteError } from "@/libs/api/errors";
import {
  quoteEpisode,
  queueBrief,
  regenerateBrief,
  findByIdempotencyKey,
  findExistingForUrl,
  getBriefForProfile,
  listBriefs,
  monthlyCreditsUsedByKey,
  toBriefResponse,
  billingUrl,
} from "@/libs/briefs/service";
import { validateCallbackUrl } from "@/libs/api-keys.mjs";
import { getPostHog } from "@/libs/posthog/server";

// POST /api/v1/briefs — create (or regenerate) a brief.
//
// Agent-first differences from the legacy web route:
//   - Auth is a cookie session OR an API key (Authorization: Bearer pb_…).
//   - Duration and cost are resolved server-side in this call; no estimate +
//     HMAC round trip. Use `max_credits` to cap what you are willing to spend.
//   - `Idempotency-Key` header: a retry with the same key returns the same brief.
//   - A duplicate episode returns the existing brief with 200 and `existing: true`
//     instead of 409.
//   - FCaptcha applies to session callers only. API keys are the agent's proof.
//
// Body: { episode_url, max_credits?, callback_url?, regenerate?, fcaptchaToken? }
// (camelCase `episodeUrl` is accepted too.)

const VALID_STATUSES = new Set(["queued", "generating", "complete"]);

function sanitizeIdempotencyKey(raw) {
  if (!raw) return null;
  const key = String(raw).trim();
  return key.length > 0 && key.length <= 128 ? key : null;
}

async function respondWithBrief(row, { status, existing, creditsRemaining = null }) {
  const brief = await toBriefResponse(row);
  return NextResponse.json(
    { ...brief, existing, ...(creditsRemaining !== null ? { credits_remaining: creditsRemaining } : {}) },
    { status }
  );
}

export async function POST(req) {
  try {
    const identity = await resolveIdentity(req);
    if (identity.error) return identityErrorResponse(identity);
    if (!hasScope(identity, "briefs:write")) return scopeErrorResponse("briefs:write");

    const limited = await protectV1(req, { callerId: identity.callerId, kind: "write" });
    if (limited) return limited;

    let body;
    try {
      body = await req.json();
    } catch {
      return jsonError(400, "invalid_json", "Request body must be JSON");
    }

    const episodeUrl = typeof body.episode_url === "string" ? body.episode_url : body.episodeUrl;
    if (!episodeUrl) return jsonError(400, "missing_episode_url", "episode_url is required");

    if (identity.kind === "session") {
      const human = await verifyHuman(req, {
        token: extractFCaptchaToken(req, body),
        action: body.regenerate === true ? "brief_regenerate" : "brief_submit",
      });
      if (!human.ok) return humanCheckResponse(human);
    }

    if (body.callback_url != null) {
      const problem = validateCallbackUrl(body.callback_url);
      if (problem) return jsonError(422, "invalid_callback_url", problem);
    }
    const callbackUrl = body.callback_url ?? identity.apiKey?.callbackUrl ?? null;
    const apiKeyId = identity.apiKey?.id ?? null;

    const idempotencyKey = sanitizeIdempotencyKey(req.headers.get("idempotency-key"));
    if (idempotencyKey) {
      const existing = await findByIdempotencyKey(identity.profileId, idempotencyKey);
      if (existing) return respondWithBrief(existing, { status: 200, existing: true });
    }

    if (body.regenerate === true) {
      const r = await regenerateBrief({ profileId: identity.profileId, episodeUrl, apiKeyId, callbackUrl, idempotencyKey });
      const row = await getBriefForProfile(identity.profileId, r.briefId);
      return respondWithBrief(row, { status: 202, existing: false, creditsRemaining: r.creditsRemaining });
    }

    const { episode, creditsNeeded } = await quoteEpisode(episodeUrl);

    if (body.max_credits != null) {
      if (!Number.isInteger(body.max_credits) || body.max_credits < 0) {
        return jsonError(422, "invalid_max_credits", "max_credits must be a non-negative integer");
      }
      if (creditsNeeded > body.max_credits) {
        return jsonError(402, "max_credits_exceeded", `This episode costs ${creditsNeeded} credits, above your max_credits of ${body.max_credits}`, {
          credits_needed: creditsNeeded,
          max_credits: body.max_credits,
          duration_seconds: episode.durationSeconds,
        });
      }
    }

    if (identity.kind === "api_key" && identity.apiKey.monthlyCreditCap != null) {
      const used = await monthlyCreditsUsedByKey(identity.apiKey.id);
      if (used + creditsNeeded > identity.apiKey.monthlyCreditCap) {
        return jsonError(402, "api_key_cap_exceeded", "This API key's monthly credit cap would be exceeded", {
          credits_needed: creditsNeeded,
          credits_used_this_month: used,
          monthly_credit_cap: identity.apiKey.monthlyCreditCap,
        });
      }
    }

    let queued;
    try {
      queued = await queueBrief({
        profileId: identity.profileId,
        episodeUrl,
        durationSeconds: episode.durationSeconds,
        creditsToCharge: creditsNeeded,
        episodeTitle: episode.title,
        podcastName: episode.podcastName,
        apiKeyId,
        idempotencyKey,
        callbackUrl,
      });
    } catch (err) {
      // Agent-friendly dedup: hand back the brief that already exists.
      if (err instanceof ApiError && err.code === "already_exists") {
        const existing = await findExistingForUrl(identity.profileId, episodeUrl);
        if (existing) return respondWithBrief(existing, { status: 200, existing: true });
      }
      throw err;
    }

    const posthog = getPostHog();
    posthog?.capture({
      distinctId: identity.profileId,
      event: "brief_queued",
      properties: { episode_url: episodeUrl, source: identity.kind === "api_key" ? "api" : "web_v1" },
    });
    posthog?.flush().catch((e) => console.error("[posthog] flush failed:", e.message));

    const row = await getBriefForProfile(identity.profileId, queued.briefId);
    return respondWithBrief(row, { status: 202, existing: false, creditsRemaining: queued.creditsRemaining });
  } catch (err) {
    return handleRouteError(err, "POST /api/v1/briefs");
  }
}

// GET /api/v1/briefs?limit=20&status=complete&cursor=<created_at>
// Returns summaries (no markdown). Fetch /api/v1/briefs/:id for content.
export async function GET(req) {
  try {
    const identity = await resolveIdentity(req);
    if (identity.error) return identityErrorResponse(identity);
    if (!hasScope(identity, "briefs:read")) return scopeErrorResponse("briefs:read");

    const limited = await protectV1(req, { callerId: identity.callerId, kind: "read" });
    if (limited) return limited;

    const url = new URL(req.url);
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20));
    const status = url.searchParams.get("status");
    if (status && !VALID_STATUSES.has(status)) {
      return jsonError(422, "invalid_status", "status must be one of queued, generating, complete");
    }
    const cursor = url.searchParams.get("cursor");

    const { rows, nextCursor } = await listBriefs(identity.profileId, { limit, status, cursor });
    const data = await Promise.all(rows.map((row) => toBriefResponse(row, { includeContent: false })));

    return NextResponse.json({ object: "list", data, next_cursor: nextCursor, has_more: nextCursor !== null, top_up_url: billingUrl() });
  } catch (err) {
    return handleRouteError(err, "GET /api/v1/briefs");
  }
}