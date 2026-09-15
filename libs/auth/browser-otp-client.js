"use client";

import { createBrowserClient } from "@supabase/ssr";

// Auth-only browser Supabase client. PKCE verifier generation/storage stays in
// the browser (this client's cookie storage); only the /auth/v1/otp HTTP
// request is rerouted through our /api/auth/signin proxy, which verifies the
// FCaptcha token before forwarding to Supabase. customFetch must return a
// Fetch Response object because auth-js expects one — this is the one place
// raw fetch is allowed instead of apiClient.

export function createBrowserAuthClient(customFetch) {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      global: {
        fetch: customFetch,
      },
    }
  );
}

// Build the custom fetch that routes the OTP request through the proxy.
// The FCaptcha token is passed in the X-FCaptcha-Token header, separate from
// the Supabase OTP body (which carries the PKCE code_challenge untouched).
export function createOtpProxyFetch(fcaptchaToken) {
  return async (url, init) => {
    let pathname = "";
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = "";
    }

    if (pathname === "/auth/v1/otp") {
      const res = await fetch("/api/auth/signin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(fcaptchaToken ? { "X-FCaptcha-Token": fcaptchaToken } : {}),
        },
        body: init?.body ?? null,
      });
      // Relay the real status and body; auth-js only needs a Response.
      return new Response(await res.text(), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    return fetch(url, init);
  };
}
