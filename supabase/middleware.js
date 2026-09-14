import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";

export async function updateSession(request) {
  const { pathname } = request.nextUrl;

  // Skip the cookie-session refresh where it cannot apply:
  //  - Stripe webhooks (server-to-server, no cookies)
  //  - API-key requests to /api/v1 (Authorization: Bearer pb_…). These carry no
  //    Supabase session; the route resolves identity from the key instead.
  const skipAuthRoutes = ["/api/webhook"];
  const authHeader = request.headers.get("authorization") || "";
  const isApiKeyRequest = pathname.startsWith("/api/v1") && /^Bearer\s+pb_/i.test(authHeader);

  if (isApiKeyRequest || skipAuthRoutes.some((route) => pathname.startsWith(route))) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // refreshing the auth token
  await supabase.auth.getUser();

  return supabaseResponse;
}