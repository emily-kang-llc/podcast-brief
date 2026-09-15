import { NextResponse } from "next/server";
import { resolveIdentity, identityErrorResponse, hasScope, scopeErrorResponse } from "@/libs/auth/identity";
import { protectV1 } from "@/libs/arcjet/v1";
import { jsonError, handleRouteError } from "@/libs/api/error";
import { quoteEpisode, getBalance, billingUrl } from "@/libs/briefs/service";

// POST /api/v1/quotes { episode_url } — price an episode without committing.
// Free; reserves nothing. Agents should call this when they need to show a
// human the cost, or skip it and pass max_credits to POST /api/v1/briefs.
export async function POST(req) {
  try {
    const identity = await resolveIdentity(req);
    if (identity.error) return identityErrorResponse(identity);
    if (!hasScope(identity, "briefs:read")) return scopeErrorResponse("briefs:read");

    const limited = await protectV1(req, { callerId: identity.callerId, kind: "read" });
    if (limited) return limited;

    let body;
    try {
      body = await req.json();
    } catch {
      return jsonError(400, "invalid_json", "Request body must be JSON");
    }
    const episodeUrl = typeof body.episode_url === "string" ? body.episode_url : body.episodeUrl;
    if (!episodeUrl) return jsonError(400, "missing_episode_url", "episode_url is required");

    const [{ episode, creditsNeeded }, remaining] = await Promise.all([
      quoteEpisode(episodeUrl),
      getBalance(identity.profileId),
    ]);

    return NextResponse.json({
      object: "quote",
      episode: {
        url: episodeUrl,
        title: episode.title,
        podcast: episode.podcastName,
        duration_seconds: episode.durationSeconds,
      },
      credits_needed: creditsNeeded,
      credits_remaining: remaining,
      sufficient: remaining >= creditsNeeded,
      top_up_url: billingUrl(),
    });
  } catch (err) {
    return handleRouteError(err, "POST /api/v1/quotes");
  }
}