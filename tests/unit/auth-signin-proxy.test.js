import { describe, it, expect, vi, beforeEach } from "vitest";

// Behavioral tests for the /api/auth/signin OTP proxy: it must verify FCaptcha
// BEFORE touching Supabase, reject bodies without a PKCE code_challenge
// (browser-owned PKCE is the design), reject unexpected fields (not an open
// proxy), and forward the exact body to the fixed upstream with the anon key.

vi.mock("@arcjet/next", () => ({
  default: () => ({
    protect: vi.fn().mockResolvedValue({ isDenied: () => false }),
  }),
  shield: () => ({}),
  slidingWindow: () => ({}),
}));

vi.mock("@/libs/fcaptcha/server", () => ({
  verifyHuman: vi.fn().mockResolvedValue({ ok: true, mode: "off", checked: false }),
  extractFCaptchaToken: vi.fn(() => "tok"),
  humanCheckResponse: vi.fn((r) => new Response(JSON.stringify(r), { status: 403 })),
}));

import { POST } from "@/app/api/auth/signin/route";
import { verifyHuman } from "@/libs/fcaptcha/server";

function makeRequest(body, headers = {}) {
  return new Request("http://localhost:3000/api/auth/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const validBody = {
  email: "tom@cruise.com",
  create_user: true,
  code_challenge: "browser-generated-challenge",
  code_challenge_method: "s256",
};

describe("signin OTP proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "anon-key";
    vi.stubGlobal("fetch", vi.fn());
  });

  it("forwards the exact challenge-bearing body to the fixed Supabase OTP endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://supabase.test/auth/v1/otp");
    expect(init.headers.apikey).toBe("anon-key");
    expect(JSON.parse(init.body)).toEqual(validBody);
  });

  it("rejects an OTP body without a code_challenge", async () => {
    const { code_challenge, ...noChallenge } = validBody;
    const res = await POST(makeRequest(noChallenge));
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unexpected fields (not an open proxy)", async () => {
    const res = await POST(makeRequest({ ...validBody, evil: true }));
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing email", async () => {
    const { email, ...noEmail } = validBody;
    const res = await POST(makeRequest(noEmail));
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not call Supabase when FCaptcha verification fails", async () => {
    vi.mocked(verifyHuman).mockResolvedValueOnce({
      ok: false,
      reason: "captcha_missing",
    });

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("relays the upstream status code", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ code: "over_email_send_rate_limit", msg: "..." }), { status: 429 })
    );

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("over_email_send_rate_limit");
  });
});
