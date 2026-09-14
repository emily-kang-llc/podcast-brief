import { NextResponse } from "next/server";
import { resolveIdentity, identityErrorResponse } from "@/libs/auth/identity";
import { protectV1 } from "@/libs/arcjet/v1";
import { handleRouteError } from "@/libs/api/errors";
import { getBalance, monthlyCreditsUsedByKey, billingUrl } from "@/libs/briefs/service";

// GET /api/v1/me — who am I and what can I spend.
export async function GET(req) {
  try {
    const identity = await resolveIdentity(req);
    if (identity.error) return identityErrorResponse(identity);

    const limited = await protectV1(req, { callerId: identity.callerId, kind: "read" });
    if (limited) return limited;

    const credits = await getBalance(identity.profileId);
    const apiKey = identity.kind === "api_key"
      ? {
          id: identity.apiKey.id,
          name: identity.apiKey.name,
          scopes: identity.apiKey.scopes,
          monthly_credit_cap: identity.apiKey.monthlyCreditCap,
          credits_used_this_month: await monthlyCreditsUsedByKey(identity.apiKey.id),
          callback_url: identity.apiKey.callbackUrl,
        }
      : null;

    return NextResponse.json({
      object: "account",
      profile_id: identity.profileId,
      auth: identity.kind,
      credits_remaining: credits,
      top_up_url: billingUrl(),
      api_key: apiKey,
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/v1/me");
  }
}