import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOtpProxyFetch } from "@/libs/auth/browser-otp-client";

// The transport is the load-bearing piece of the PKCE-safe signin design:
// the OTP request body (which carries the SDK-generated code_challenge) must
// be forwarded untouched to /api/auth/signin with the FCaptcha token in a
// separate header, and every other Supabase request must use normal fetch.

describe("browser otp client transport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("routes the OTP request through /api/auth/signin with the token header", async () => {
    const otpBody = JSON.stringify({
      email: "tom@cruise.com",
      code_challenge: "generated-by-supabase-js",
      code_challenge_method: "s256",
    });
    const proxy = vi.mocked(fetch).mockResolvedValue(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    );

    const transport = createOtpProxyFetch("captcha-token");
    const res = await transport("https://supabase.example.co/auth/v1/otp", {
      method: "POST",
      body: otpBody,
    });

    expect(res.status).toBe(200);
    // Called the proxy endpoint, not Supabase directly.
    expect(proxy).toHaveBeenCalledWith(
      "/api/auth/signin",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-FCaptcha-Token": "captcha-token" }),
        // The PKCE challenge-bearing body is forwarded untouched.
        body: otpBody,
      })
    );
  });

  it("passes non-OTP requests straight through to Supabase", async () => {
    const proxy = vi.mocked(fetch).mockResolvedValue(
      new Response("{}", { status: 200 })
    );

    const transport = createOtpProxyFetch("captcha-token");
    await transport("https://supabase.example.co/auth/v1/token?grant_type=pkce", {
      method: "POST",
      body: "{}",
    });

    expect(proxy).toHaveBeenCalledWith(
      "https://supabase.example.co/auth/v1/token?grant_type=pkce",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("relays the upstream status code", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "denied" }), { status: 403 })
    );

    const transport = createOtpProxyFetch("captcha-token");
    const res = await transport("https://supabase.example.co/auth/v1/otp", {
      method: "POST",
      body: "{}",
    });

    expect(res.status).toBe(403);
  });
});
