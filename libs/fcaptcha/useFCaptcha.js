"use client";

import { useCallback, useEffect, useState } from "react";

// Loads the FCaptcha widget from your self-hosted server and exposes
// execute(action) → token (invisible mode). Returns null when FCaptcha is not
// configured, the widget fails to load, or execution throws — the server
// decides what to do with a missing token based on FCAPTCHA_MODE.
//
// Usage:
//   const { execute } = useFCaptcha();
//   const fcaptchaToken = await execute("brief_submit");
//   await fetch("/api/jobs/brief", { body: JSON.stringify({ ...payload, fcaptchaToken }) });

const SERVER_URL = (process.env.NEXT_PUBLIC_FCAPTCHA_URL || "").replace(/\/+$/, "");
const SITE_KEY = process.env.NEXT_PUBLIC_FCAPTCHA_SITE_KEY || "";
const ENABLED = Boolean(SERVER_URL && SITE_KEY);

let loadPromise = null;

function loadWidget() {
  if (!ENABLED || typeof window === "undefined") return Promise.resolve(null);
  if (window.FCaptcha) {
    window.FCaptcha.configure({ serverUrl: SERVER_URL });
    return Promise.resolve(window.FCaptcha);
  }
  if (!loadPromise) {
    loadPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = `${SERVER_URL}/fcaptcha.js`;
      script.async = true;
      script.onload = () => {
        try {
          window.FCaptcha?.configure({ serverUrl: SERVER_URL });
        } catch (err) {
          console.warn("[fcaptcha] configure failed:", err);
        }
        resolve(window.FCaptcha || null);
      };
      script.onerror = () => {
        console.warn("[fcaptcha] widget failed to load from", SERVER_URL);
        resolve(null);
      };
      document.head.appendChild(script);
    });
  }
  return loadPromise;
}

export function useFCaptcha() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadWidget().then((fc) => {
      if (!cancelled) setReady(Boolean(fc));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const execute = useCallback(async (action) => {
    if (!ENABLED) return null;
    const fc = await loadWidget();
    if (!fc) return null;
    try {
      const result = await fc.execute(SITE_KEY, { action });
      return result?.token ?? null;
    } catch (err) {
      console.warn("[fcaptcha] execute failed:", err);
      return null;
    }
  }, []);

  return { enabled: ENABLED, ready, execute };
}