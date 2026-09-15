"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import config from "@/config";
import { useFCaptcha } from "@/libs/fcaptcha/useFCaptcha";
import { createBrowserAuthClient, createOtpProxyFetch } from "@/libs/auth/browser-otp-client";

// Login/signup page for Supabase Auth. The OTP send goes through our
// /api/auth/signin proxy (which verifies FCaptcha) instead of the browser
// calling Supabase directly. The PKCE verifier is generated and stored by
// Supabase JS in this browser; only the OTP HTTP request is rerouted.
// The magic-link click is processed by /api/auth/callback, unchanged.
export default function Login() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isDisabled, setIsDisabled] = useState(false);
  const { prepare, consume, enabled: fcaptchaEnabled } = useFCaptcha();
  const debounceRef = useRef(null);

  // Prepare the signup token in the background once the email looks valid, so
  // the final click never waits on token minting.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!fcaptchaEnabled || !valid) return;
    debounceRef.current = setTimeout(() => {
      prepare("signup").catch(() => {});
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [email, fcaptchaEnabled, prepare]);

  const handleSignup = async (e) => {
    e?.preventDefault();

    setIsLoading(true);

    try {
      // Consume the pre-minted token (single-use). Falls back to minting one
      // if the background prepare did not finish.
      const fcaptchaToken = await consume("signup");

      // The auth client keeps PKCE in the browser; its OTP request is
      // intercepted and sent through our FCaptcha-verifying proxy.
      const authClient = createBrowserAuthClient(createOtpProxyFetch(fcaptchaToken));

      const { error } = await authClient.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: new URL("/api/auth/callback", window.location.origin).toString(),
        },
      });

      if (error) {
        console.error(error);
        if (error.code === "over_email_send_rate_limit") {
          toast.error("Too many attempts — wait a minute, then try again.");
        } else {
          toast.error("Couldn't send the sign-in link. Please try again.");
        }
        return;
      }

      toast.success("Check your emails!");
      setIsDisabled(true);
    } catch (error) {
      console.error(error);
      toast.error("Couldn't send the sign-in link. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="p-8 md:p-24" data-theme={config.colors.theme}>
      <div className="text-center mb-4">
        <Link href="/" className="btn btn-ghost btn-sm">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-5 h-5"
          >
            <path
              fillRule="evenodd"
              d="M15 10a.75.75 0 01-.75.75H7.612l2.158 1.96a.75.75 0 11-1.04 1.08l-3.5-3.25a.75.75 0 010-1.08l3.5-3.25a.75.75 0 111.04 1.08L7.612 9.25h6.638A.75.75 0 0115 10z"
              clipRule="evenodd"
            />
          </svg>
          Home
        </Link>
      </div>
      <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-center mb-12">
        Sign in or create your account
      </h1>

      <div className="space-y-8 max-w-xl mx-auto">
        <form className="form-control w-full space-y-4" onSubmit={handleSignup}>
          <input
            required
            type="email"
            value={email}
            autoComplete="email"
            placeholder="tom@cruise.com"
            className="input input-bordered w-full placeholder:opacity-60"
            onChange={(e) => setEmail(e.target.value)}
          />

          <button
            className="btn btn-primary btn-block"
            disabled={isLoading || isDisabled}
            type="submit"
          >
            {isLoading && <span className="loading loading-spinner loading-xs"></span>}
            Continue with email
          </button>
        </form>

        <p className="text-sm opacity-70 text-center">
          We&apos;ll email you a link — no password needed. New accounts start with 3 free
          credits.
        </p>
      </div>
    </main>
  );
}
