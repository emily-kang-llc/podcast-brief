import { describe, it, expect } from "vitest";

// Route/spec parity: the served OpenAPI document must advertise exactly the
// implemented v0 routes — no more (agents following nonexistent endpoints),
// no less. Imports the real GET handler and parses its JSON body.

import { GET } from "@/app/openapi.json/route";

const EXPECTED = new Set([
  "GET /v1/me",
  "POST /v1/briefs",
  "GET /v1/briefs/{id}",
  "GET /v1/keys",
  "POST /v1/keys",
  "DELETE /v1/keys/{id}",
]);

async function loadSpec() {
  const res = await GET();
  return res.json();
}

describe("openapi routes", () => {
  it("advertises exactly the implemented v0 route set", async () => {
    const spec = await loadSpec();
    const advertised = new Set();
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      for (const method of Object.keys(methods)) {
        advertised.add(`${method.toUpperCase()} ${path}`);
      }
    }

    const missing = [...EXPECTED].filter((r) => !advertised.has(r));
    const extra = [...advertised].filter((r) => !EXPECTED.has(r));
    expect(missing, "missing from OpenAPI").toEqual([]);
    expect(extra, "advertised but not implemented").toEqual([]);
  });

  it("documents the async contract on POST /v1/briefs", async () => {
    const spec = await loadSpec();
    const post = spec.paths["/v1/briefs"].post;
    expect(post.responses[202]).toBeDefined();
    expect(post.responses[202].headers.Location).toBeDefined();
    expect(post.responses[202].headers["Retry-After"]).toBeDefined();
    expect(post.responses[402]).toBeDefined();
    expect(post.responses[409]).toBeDefined();
  });

  it("contains no webhook, callback, refund, idempotency, or list surface", async () => {
    const spec = await loadSpec();
    const raw = JSON.stringify(spec);
    expect(raw).not.toMatch(/webhook|callback_url|refund|Idempotency-Key/);
    expect(spec.paths["/v1/briefs"].get).toBeUndefined();
    expect(spec["x-webhooks"]).toBeUndefined();
  });
});
