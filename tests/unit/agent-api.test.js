import { describe, it, expect, vi, beforeEach } from "vitest";

// Route-level tests for the agent API v0. All collaborators are mocked; the
// assertions check the HTTP contract: bearer identity, no FCaptcha on bearer
// calls, 409 dedup without a second queue/charge, 402 shape, 202 with
// Location/Retry-After, and ownership scoping on reads.

const mockQueueBrief = vi.fn();
const mockQuoteEpisode = vi.fn();
const mockGetBalance = vi.fn();
const mockGetBriefForProfile = vi.fn();
const mockResolveIdentity = vi.fn();

vi.mock("@/libs/briefs/service", () => ({
  queueBrief: (...a) => mockQueueBrief(...a),
  quoteEpisode: (...a) => mockQuoteEpisode(...a),
  getBalance: (...a) => mockGetBalance(...a),
  getBriefForProfile: (...a) => mockGetBriefForProfile(...a),
  billingUrl: () => "https://www.podcastbrief.app/billing",
}));

vi.mock("@/libs/auth/identity", () => ({
  resolveIdentity: (...a) => mockResolveIdentity(...a),
  identityErrorResponse: (identity) =>
    new Response(JSON.stringify({ error: identity.error.code }), {
      status: identity.error.status,
    }),
}));

vi.mock("@/libs/arcjet/v1", () => ({
  protectV1: vi.fn().mockResolvedValue(null),
}));

// Chainable supabase query stub.
function chain(result) {
  const c = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    single: vi.fn().mockResolvedValue(result),
  };
  return c;
}
// Consecutive results for successive from("briefs") calls, in order.
const fromResults = [];
const mockFrom = vi.fn(() => {
  const r = fromResults.length ? fromResults.shift() : { data: null, error: null };
  return chain(r);
});

vi.mock("@/libs/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({ from: (...a) => mockFrom(...a) }),
}));

vi.mock("@/libs/fcaptcha/server", () => ({
  verifyHuman: vi.fn(),
  extractFCaptchaToken: vi.fn(),
  humanCheckResponse: vi.fn(),
}));

import { POST as createBrief } from "@/app/api/v1/briefs/route";
import { GET as getBrief } from "@/app/api/v1/briefs/[id]/route";
import { verifyHuman } from "@/libs/fcaptcha/server";

const apiKeyIdentity = {
  kind: "api_key",
  profileId: "profile-a",
  callerId: "key-1",
  apiKey: { id: "key-1", scopes: ["briefs:read", "briefs:write"] },
};

function makeRequest(body) {
  return new Request("http://localhost:3000/api/v1/briefs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer pb_test_abc",
    },
    body: JSON.stringify(body),
  });
}

describe("agent API v0", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_ENV = "DEVELOPMENT";
    process.env.NEXT_PUBLIC_DOMAIN_NAME = "www.podcastbrief.app";
  });

  it("returns 401 when the bearer key is invalid", async () => {
    mockResolveIdentity.mockResolvedValueOnce({
      error: { code: "invalid_api_key", message: "Invalid API key", status: 401 },
    });

    const res = await createBrief(makeRequest({ episodeUrl: "https://pod.link/e/1" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when the key lacks briefs:write", async () => {
    mockResolveIdentity.mockResolvedValueOnce({
      ...apiKeyIdentity,
      apiKey: { id: "key-1", scopes: ["briefs:read"] },
    });

    const res = await createBrief(makeRequest({ episodeUrl: "https://pod.link/e/1" }));
    expect(res.status).toBe(403);
  });

  it("returns 409 brief_already_queued without queueing or charging again", async () => {
    mockResolveIdentity.mockResolvedValueOnce(apiKeyIdentity);
    mockQuoteEpisode.mockResolvedValueOnce({
      episode: { title: "T", podcastName: "P", durationSeconds: 600 },
      creditsNeeded: 1,
    });
    mockGetBalance.mockResolvedValueOnce(5);
    fromResults.push({ data: { id: "brief-existing", status: "generating" }, error: null });

    const res = await createBrief(makeRequest({ episodeUrl: "https://pod.link/e/1" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("brief_already_queued");
    expect(body.brief_id).toBe("brief-existing");
    expect(body.status_url).toContain("/api/v1/briefs/brief-existing");
    expect(mockQueueBrief).not.toHaveBeenCalled();
  });

  it("returns 402 insufficient_credits with top_up_url", async () => {
    mockResolveIdentity.mockResolvedValueOnce(apiKeyIdentity);
    mockQuoteEpisode.mockResolvedValueOnce({
      episode: { title: "T", podcastName: "P", durationSeconds: 600 },
      creditsNeeded: 3,
    });
    mockGetBalance.mockResolvedValueOnce(1);
    // No existing brief.
    fromResults.push({ data: null, error: null });

    const res = await createBrief(makeRequest({ episodeUrl: "https://pod.link/e/1" }));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("insufficient_credits");
    expect(body.credits_needed).toBe(3);
    expect(body.credits_remaining).toBe(1);
    expect(body.top_up_url).toBe("https://www.podcastbrief.app/billing");
    expect(mockQueueBrief).not.toHaveBeenCalled();
  });

  it("returns 202 with Location and Retry-After after a durable queue", async () => {
    mockResolveIdentity.mockResolvedValueOnce(apiKeyIdentity);
    mockQuoteEpisode.mockResolvedValueOnce({
      episode: { title: "T", podcastName: "P", durationSeconds: 600 },
      creditsNeeded: 1,
    });
    mockGetBalance.mockResolvedValueOnce(5);
    fromResults.push({ data: null, error: null });
    mockQueueBrief.mockResolvedValueOnce({
      briefId: "brief-new",
      creditsCharged: 1,
      creditsRemaining: 4,
    });

    const res = await createBrief(makeRequest({ episodeUrl: "https://pod.link/e/1" }));
    expect(res.status).toBe(202);
    expect(res.headers.get("Location")).toContain("/api/v1/briefs/brief-new");
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = await res.json();
    expect(body.brief_id).toBe("brief-new");
    expect(body.status).toBe("queued");
    expect(mockQueueBrief).toHaveBeenCalledTimes(1);
  });

  it("never invokes FCaptcha for bearer callers", async () => {
    mockResolveIdentity.mockResolvedValueOnce(apiKeyIdentity);
    mockQuoteEpisode.mockResolvedValueOnce({
      episode: { title: "T", podcastName: "P", durationSeconds: 600 },
      creditsNeeded: 1,
    });
    mockGetBalance.mockResolvedValueOnce(5);
    fromResults.push({ data: null, error: null });
    mockQueueBrief.mockResolvedValueOnce({ briefId: "b", creditsCharged: 1 });

    await createBrief(makeRequest({ episodeUrl: "https://pod.link/e/1" }));
    expect(verifyHuman).not.toHaveBeenCalled();
  });

  it("scopes reads to the key owner's profile (404 for others' briefs)", async () => {
    mockResolveIdentity.mockResolvedValueOnce(apiKeyIdentity);
    mockGetBriefForProfile.mockResolvedValueOnce(null);

    const req = new Request("http://localhost:3000/api/v1/briefs/brief-b", {
      headers: { Authorization: "Bearer pb_test_abc" },
    });
    const res = await getBrief(req, { params: { id: "brief-b" } });
    expect(res.status).toBe(404);
    expect(mockGetBriefForProfile).toHaveBeenCalledWith("profile-a", "brief-b");
  });

  it("returns safe fields only on read", async () => {
    mockResolveIdentity.mockResolvedValueOnce(apiKeyIdentity);
    mockGetBriefForProfile.mockResolvedValueOnce({
      id: "brief-x",
      status: "complete",
      episode_title: "T",
      podcast_name: "P",
      output_markdown: "# hi",
      error_log: "secret internal error",
      created_at: "2026-09-14T00:00:00Z",
    });

    const req = new Request("http://localhost:3000/api/v1/briefs/brief-x", {
      headers: { Authorization: "Bearer pb_test_abc" },
    });
    const res = await getBrief(req, { params: { id: "brief-x" } });
    const body = await res.json();
    expect(body.id).toBe("brief-x");
    expect(body.error_log).toBeUndefined();
  });
});
