// Pure action-token manager (no React) so the single-use token contract is
// unit-testable in Node. useFCaptcha wraps this for components.

// In-flight token promise cache by action
const inFlightMints = new Map();
// Prepared (unused) tokens by action
const preparedTokens = new Map();

let loadPromise = null;

function clientConfig() {
  // Unset vars mean disabled, not a crash.
  const serverUrl = (process.env.NEXT_PUBLIC_FCAPTCHA_URL || "").replace(/\/+$/, "");
  const siteKey = process.env.NEXT_PUBLIC_FCAPTCHA_SITE_KEY || "";
  return { serverUrl, siteKey, enabled: Boolean(serverUrl && siteKey) };
}

export function fcaptchaEnabled() {
  return clientConfig().enabled;
}

function loadWidget(serverUrl) {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.FCaptcha) {
    window.FCaptcha.configure({ serverUrl });
    return Promise.resolve(window.FCaptcha);
  }
  if (!loadPromise) {
    loadPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = `${serverUrl}/fcaptcha.js`;
      script.async = true;
      script.onload = () => {
        try {
          window.FCaptcha?.configure({ serverUrl });
        } catch (err) {
          console.warn("[fcaptcha] configure failed:", err);
        }
        resolve(window.FCaptcha || null);
      };
      script.onerror = () => {
        console.warn("[fcaptcha] widget failed to load from", serverUrl);
        resolve(null);
      };
      document.head.appendChild(script);
    });
  }
  return loadPromise;
}

async function mintToken(action, { serverUrl, siteKey }) {
  const fc = await loadWidget(serverUrl);
  if (!fc) return null;

  try {
    const result = await fc.execute(siteKey, { action });
    if (result?.token) {
      return result.token;
    }
  } catch (err) {
    console.warn("[fcaptcha] execute failed:", err);
  }
  return null;
}

// Idempotently mint (or return the already prepared) token for an action.
export async function prepareToken(action) {
  const c = clientConfig();
  if (!c.enabled) return null;

  // One prepared (unused) token per action.
  const existing = preparedTokens.get(action);
  if (existing) return existing;

  // One in-flight mint per action.
  if (inFlightMints.has(action)) {
    return await inFlightMints.get(action);
  }

  const mintPromise = mintToken(action, c).then((token) => {
    if (token) preparedTokens.set(action, token);
    return token;
  });
  inFlightMints.set(action, mintPromise);

  try {
    return await mintPromise;
  } finally {
    inFlightMints.delete(action);
  }
}

// Single-use: remove the prepared token BEFORE returning it, even if the
// downstream request later fails — a retry gets a newly minted token.
export async function consumeToken(action) {
  const c = clientConfig();
  if (!c.enabled) return null;

  const existing = preparedTokens.get(action);
  if (existing) {
    preparedTokens.delete(action);
    return existing;
  }

  // Correctness fallback: mint on demand.
  const token = await prepareToken(action);
  if (token) preparedTokens.delete(action);
  return token;
}

export function invalidateToken(action) {
  preparedTokens.delete(action);
}

// Test seam: reset module state between cases.
export function __resetForTests() {
  inFlightMints.clear();
  preparedTokens.clear();
  loadPromise = null;
}
