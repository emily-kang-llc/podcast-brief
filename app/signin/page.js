"use client";

import Link from "next/link";
import { useState } from "react";
import toast from "react-hot-toast";
import config from "@/config";
import apiClient from "@/libs/api";
import { useFCaptcha } from "@/libs/fcaptcha/useFCaptcha";

// Login/signup page for Supabase Auth. The OTP send goes through our
// /api/auth/signin proxy (which verifies FCaptcha) instead of the browser
// calling Supabase directly. The magic-link click is processed by
// /api/auth/callback where the code exchange happens.
export default function Login() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isDisabled, setIsDisabled] = useState(false);
  const { execute } = useFCaptcha();

  const handleSignup = async (e) => {
    e?.preventDefault();

    setIsLoading(true);

    try {
      const fcaptchaToken = await execute("signup");
      const data = await apiClient.post("/auth/signin", { email, fcaptchaToken });

      // The route returns 200 with { error } (supabase-js shape) so the
      // apiClient interceptor doesn't double-toast. Handle it like Supabase did.
      if (data.error) {
        console.error(data.error);
        if (data.error.code === "over_email_send_rate_limit") {
          toast.error("Too many attempts — wait a minute, then try again.");
        } else {
          toast.error("Couldn't send the sign-in link. Please try again.");
        }
        return;
      }

      toast.success("Check your emails!");

      setIsDisabled(true);
    } catch (error) {
      // 4xx/5xx (captcha block, rate limit, server error) are already toasted
      // by the apiClient interceptor; only network-level failures reach here.
      console.error(error);
      if (error.response) {
        console.error("Response status:", error.response.status);
      } else {
        toast.error("Couldn't send the sign-in link. Please try again.");
      }
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
