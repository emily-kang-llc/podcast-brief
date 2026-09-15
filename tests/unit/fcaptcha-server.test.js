import { describe, it, expect, vi, beforeEach } from "vitest";

// verifyHuman reads env per call, so tests can set it per case.
import { verifyHuman, fcaptchaMode, extractFCaptchaToken } from "@/libs/fcaptcha/server";

global.fetch = vi.fn();

const mockRequest = {
  headers: new Headers({
    "x-forwarded-host": "example.com",
    host: "example.com",
  }),
};

function mockSiteverify(payload, ok = true) {
  vi.mocked(fetch).mockResolvedValue({
    ok,
    json: vi.fn().mockResolvedValue(payload),
  });
}

describe("fcaptcha server verifier", () => {
  const mockToken = "test-token";
  const mockAction = "brief_submit";

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.FCAPTCHA_URL = "https://fcaptcha.test";
    process.env.FCAPTCHA_VERIFY_SECRET = "test-secret";
    delete process.env.FCAPTCHA_MODE;
    delete process.env.FCAPTCHA_EXPECTED_HOSTNAMES;
  });

  it("returns early in 'off' mode", async () => {
    process.env.FCAPTCHA_MODE = "off";
    const result = await verifyHuman(mockRequest, { token: mockToken, action: mockAction });
    expect(result).toEqual({ ok: true, mode: "off", checked: false });
  });

  it("defaults to monitor when FCAPTCHA_URL is set", () => {
    expect(fcaptchaMode()).toBe("monitor");
  });

  it("passes in 'monitor' mode with valid token", async () => {
    process.env.FCAPTCHA_MODE = "monitor";
    mockSiteverify({
      success: true,
      hostname: "example.com",
      action: mockAction,
      score: 0.8,
    });

    const result = await verifyHuman(mockRequest, { token: mockToken, action: mockAction });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("monitor");
    expect(result.checked).toBe(true);
    expect(result.pass).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("logs and allows in 'monitor' mode with invalid token", async () => {
    process.env.FCAPTCHA_MODE = "monitor";
    mockSiteverify({ success: false, "error-codes": ["invalid-input-response"] });

    const result = await verifyHuman(mockRequest, { token: mockToken, action: mockAction });
    expect(result.ok).toBe(true);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("captcha_failed");
  });

  it("fails closed in 'enforce' mode with invalid token", async () => {
    process.env.FCAPTCHA_MODE = "enforce";
    mockSiteverify({ success: false, "error-codes": ["invalid-input-response"] });

    const result = await verifyHuman(mockRequest, { token: mockToken, action: mockAction });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("captcha_failed");
  });

  it("fails closed in 'enforce' mode with missing token", async () => {
    process.env.FCAPTCHA_MODE = "enforce";
    const result = await verifyHuman(mockRequest, { token: null, action: mockAction });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("captcha_missing");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails open on captcha_unavailable for brief_submit", async () => {
    process.env.FCAPTCHA_MODE = "enforce";
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    const result = await verifyHuman(mockRequest, { token: mockToken, action: "brief_submit" });
    expect(result.ok).toBe(true);
    expect(result.failedOpen).toBe(true);
    expect(result.reason).toBe("captcha_unavailable");
  });

  it("fails open on captcha_unavailable for brief_regenerate", async () => {
    process.env.FCAPTCHA_MODE = "enforce";
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    const result = await verifyHuman(mockRequest, { token: mockToken, action: "brief_regenerate" });
    expect(result.ok).toBe(true);
    expect(result.failedOpen).toBe(true);
  });

  it("fails CLOSED on captcha_unavailable for signup", async () => {
    process.env.FCAPTCHA_MODE = "enforce";
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    const result = await verifyHuman(mockRequest, { token: mockToken, action: "signup" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("captcha_unavailable");
  });

  it("fails CLOSED on captcha_unavailable for api_key_create", async () => {
    process.env.FCAPTCHA_MODE = "enforce";
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    const result = await verifyHuman(mockRequest, { token: mockToken, action: "api_key_create" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("captcha_unavailable");
  });

  it("fails closed on hostname mismatch even for fail-open actions", async () => {
    process.env.FCAPTCHA_MODE = "enforce";
    mockSiteverify({ success: true, hostname: "evil.example", action: mockAction, score: 0.9 });

    const result = await verifyHuman(mockRequest, { token: mockToken, action: mockAction });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("captcha_hostname_mismatch");
  });

  it("fails closed on action mismatch", async () => {
    process.env.FCAPTCHA_MODE = "enforce";
    mockSiteverify({ success: true, hostname: "example.com", action: "api_key_create", score: 0.9 });

    const result = await verifyHuman(mockRequest, { token: mockToken, action: mockAction });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("captcha_action_mismatch");
  });

  it("is misconfigured without a verify secret", async () => {
    process.env.FCAPTCHA_MODE = "enforce";
    delete process.env.FCAPTCHA_VERIFY_SECRET;
    const result = await verifyHuman(mockRequest, { token: mockToken, action: mockAction });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("captcha_misconfigured");
  });

  it("extracts token from header or body", () => {
    const req = { headers: new Headers({ "x-fcaptcha-token": "header-token" }) };
    expect(extractFCaptchaToken(req, {})).toBe("header-token");
    expect(extractFCaptchaToken({ headers: new Headers() }, { fcaptchaToken: "body-token" })).toBe("body-token");
    expect(extractFCaptchaToken(req, { fcaptchaToken: "body-token" })).toBe("body-token");
  });
});
