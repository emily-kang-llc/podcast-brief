import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const routePath = new URL("../../app/api/auth/signin/route.js", import.meta.url);

describe("auth signin PKCE flow", () => {
  it("uses the cookie-bound Supabase server client to initiate OTP", async () => {
    const source = await readFile(routePath, "utf8");

    expect(source).toContain('import { createClient } from "@/libs/supabase/server"');
    expect(source).not.toContain("adminSupabase.auth.signInWithOtp");
    expect(source).toContain("const supabase = await createClient()");
    expect(source).toContain("supabase.auth.signInWithOtp");
  });
});
