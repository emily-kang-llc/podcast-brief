"use client";

import { useEffect, useState } from "react";
import { prepareToken, consumeToken, invalidateToken, fcaptchaEnabled } from "@/libs/fcaptcha/tokens";

// React wrapper around the pure action-token manager in ./tokens.js.
//
// Usage:
//   const { prepare, consume, enabled } = useFCaptcha();
//   await prepare("brief_submit");               // background, after estimate
//   const token = await consume("brief_submit"); // final click
//
// Tokens are single-use: consume() removes the prepared token before
// returning it, and a rejected/expired token is dropped via invalidate().
// `enabled`/`ready` are diagnostics only — never gate a submit button on
// them; a missing widget must not block the action (the server decides).

export function useFCaptcha() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(fcaptchaEnabled());
  }, []);

  return {
    enabled,
    ready: enabled,
    prepare: prepareToken,
    consume: consumeToken,
    invalidate: invalidateToken,
  };
}
