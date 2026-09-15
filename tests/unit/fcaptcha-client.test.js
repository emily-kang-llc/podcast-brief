import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The action-token manager's contract: one prepared single-use token per
// action, one in-flight mint per action, and disabled behavior when FCaptcha
// is unconfigured. Tests target the pure module (no React needed); node env
// gets the browser globals loadWidget() touches.

import {
  prepareToken,
  consumeToken,
  invalidateToken,
  fcaptchaEnabled,
  __resetForTests,
} from "@/libs/fcaptcha/tokens";

function stubWidget(execute) {
  globalThis.window.FCaptcha = { configure: vi.fn(), execute };
}

describe("fcaptcha client manager", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    __resetForTests();
    globalThis.window = { FCaptcha: undefined };
    globalThis.document = {
      createElement: vi.fn(() => ({ async: false, onload: null, onerror: null })),
      head: { appendChild: vi.fn() },
    };
    process.env.NEXT_PUBLIC_FCAPTCHA_URL = "https://fcaptcha.test";
    process.env.NEXT_PUBLIC_FCAPTCHA_SITE_KEY = "test-site-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.window;
    delete globalThis.document;
    delete process.env.NEXT_PUBLIC_FCAPTCHA_URL;
    delete process.env.NEXT_PUBLIC_FCAPTCHA_SITE_KEY;
  });

  it("reports disabled when unconfigured and mints nothing", async () => {
    delete process.env.NEXT_PUBLIC_FCAPTCHA_URL;
    expect(fcaptchaEnabled()).toBe(false);
    expect(await prepareToken("signup")).toBeNull();
    expect(await consumeToken("signup")).toBeNull();
  });

  it("prepare mints once and caches; consume is single-use", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ token: "tok-1" })
      .mockResolvedValueOnce({ token: "tok-2" });
    stubWidget(execute);

    const first = await prepareToken("brief_submit");
    expect(first).toBe("tok-1");
    // Cached: no second mint.
    expect(await prepareToken("brief_submit")).toBe("tok-1");
    expect(execute).toHaveBeenCalledTimes(1);

    // consume returns and removes the prepared token.
    expect(await consumeToken("brief_submit")).toBe("tok-1");
    // A second consume must mint a fresh token, not replay tok-1.
    const fresh = await consumeToken("brief_submit");
    expect(fresh).not.toBe("tok-1");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("invalidate drops a prepared token", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ token: "tok-a" })
      .mockResolvedValueOnce({ token: "tok-b" });
    stubWidget(execute);

    await prepareToken("brief_submit");
    invalidateToken("brief_submit");
    // Token was dropped before use, so consume mints a new one.
    expect(await consumeToken("brief_submit")).toBe("tok-b");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
