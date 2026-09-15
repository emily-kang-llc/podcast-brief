import { NextResponse } from "next/server";

// Machine-readable description of the v1 API for agents and SDK generators.
// Kept in code (not a static file) so it can reflect the deployed domain.
// v0 scope: create + poll + identity + human key management. No webhooks,
// callbacks, refunds, quotes, idempotency keys, or list pagination.

function spec() {
  const domain = process.env.NEXT_PUBLIC_DOMAIN_NAME || "www.podcastbrief.app";
  const brief = { $ref: "#/components/schemas/Brief" };
  const error = { $ref: "#/components/schemas/Error" };

  return {
    openapi: "3.1.0",
    info: {
      title: "PodcastBrief API",
      version: "1.0.0",
      description:
        "Turn an Apple Podcasts episode into a structured, cited brief. Briefs are asynchronous: POST once, then poll GET /briefs/{id} per the Retry-After header until status=complete. Pricing: 1 credit per hour of audio, rounded up. Credits are prepaid by a human at " +
        `https://${domain}/billing.`,
    },
    servers: [{ url: `https://${domain}/api` }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "API key created at POST /v1/keys (by a signed-in human). Format: pb_live_<48 hex>. Keys are environment-scoped and revocable.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string", description: "Stable machine-readable code" },
            message: { type: "string" },
          },
          additionalProperties: true,
        },
        Brief: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["queued", "generating", "complete"] },
            episode_title: { type: ["string", "null"] },
            podcast_name: { type: ["string", "null"] },
            output_markdown: {
              type: ["string", "null"],
              description: "Brief content when status=complete; null otherwise. No internal error details are exposed.",
            },
            created_at: { type: "string", format: "date-time" },
          },
        },
      },
    },
    paths: {
      "/v1/me": {
        get: {
          summary: "Identity, scopes, and credit balance",
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      identity_type: { type: "string", enum: ["api_key", "session"] },
                      scopes: { type: "array", items: { type: "string", enum: ["briefs:read", "briefs:write"] } },
                      credits_remaining: { type: "integer" },
                    },
                  },
                },
              },
            },
            401: { description: "Unauthorized", content: { "application/json": { schema: error } } },
          },
        },
      },
      "/v1/briefs": {
        post: {
          summary: "Create a brief (asynchronous)",
          description:
            "Resolves the episode, charges credits atomically, and queues processing. Retrying the same episode URL while it is queued or generating returns 409 brief_already_queued — keep polling the returned status_url instead of re-POSTing. A completed episode returns 409 brief_already_exists with its brief_id.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["episodeUrl"],
                  properties: {
                    episodeUrl: { type: "string", format: "uri", description: "Apple Podcasts episode link containing ?i=" },
                  },
                },
              },
            },
          },
          responses: {
            202: {
              description: "Accepted and durably queued",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      brief_id: { type: "string", format: "uuid" },
                      status: { type: "string", const: "queued" },
                      credits_charged: { type: "integer" },
                      credits_remaining: { type: "integer" },
                    },
                  },
                },
              },
              headers: {
                Location: { schema: { type: "string" }, description: "Poll this URL for brief status" },
                "Retry-After": { schema: { type: "string" }, description: "Recommended seconds before the next poll" },
              },
            },
            400: { description: "Malformed request", content: { "application/json": { schema: error } } },
            401: { description: "Invalid or revoked API key", content: { "application/json": { schema: error } } },
            402: {
              description: "insufficient_credits — the human owner must top up manually at top_up_url; no automatic purchase",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      error: { type: "string", const: "insufficient_credits" },
                      credits_needed: { type: "integer" },
                      credits_remaining: { type: "integer" },
                      top_up_url: { type: "string", format: "uri" },
                    },
                  },
                },
              },
            },
            403: { description: "insufficient_scope", content: { "application/json": { schema: error } } },
            409: {
              description: "brief_already_queued (in-flight duplicate; poll status_url) | brief_already_exists (completed duplicate)",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      error: { type: "string", enum: ["brief_already_queued", "brief_already_exists"] },
                      brief_id: { type: "string", format: "uuid" },
                      status: { type: "string" },
                      status_url: { type: "string" },
                    },
                  },
                },
              },
            },
            422: { description: "Episode could not be used", content: { "application/json": { schema: error } } },
            429: { description: "rate_limited; respect Retry-After" },
          },
        },
      },
      "/v1/briefs/{id}": {
        get: {
          summary: "Poll one owned brief",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: brief } } },
            401: { description: "Unauthorized", content: { "application/json": { schema: error } } },
            404: { description: "not_found (or not owned by this key)", content: { "application/json": { schema: error } } },
          },
        },
      },
      "/v1/keys": {
        get: { summary: "List API keys, non-secret metadata only (signed-in humans only)", responses: { 200: { description: "OK" }, 401: { description: "Unauthorized" } } },
        post: {
          summary: "Create an API key (signed-in humans only; protected by an invisible human check)",
          responses: {
            200: { description: "Created; raw key returned exactly once" },
            401: { description: "Unauthorized" },
            403: { description: "Human verification failed" },
            503: { description: "Human verification unavailable; try again shortly" },
          },
        },
      },
      "/v1/keys/{id}": {
        delete: {
          summary: "Revoke an API key (signed-in humans only; idempotent)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { 200: { description: "Revoked" }, 401: { description: "Unauthorized" } },
        },
      },
    },
  };
}

export async function GET() {
  return NextResponse.json(spec(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
