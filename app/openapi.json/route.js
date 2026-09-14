import { NextResponse } from "next/server";

// Machine-readable description of the v1 API for agents and SDK generators.
// Kept in code (not a static file) so it can reflect the deployed domain.

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
        "Turn an Apple Podcasts episode into a structured, cited brief. Briefs are asynchronous: create one, then poll GET /briefs/{id} or receive a signed webhook. Pricing: 1 credit per hour of audio, rounded up. Credits are prepaid by a human at " +
        `https://${domain}/billing.`,
    },
    servers: [{ url: `https://${domain}/api` }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "API key created at POST /v1/keys (by a signed-in human). Format: pb_live_<48 hex>.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error", "message"],
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
            object: { type: "string", const: "brief" },
            status: { type: "string", enum: ["queued", "generating", "complete"] },
            outcome: {
              type: ["string", "null"],
              enum: ["succeeded", "partial", "failed", null],
              description: "null until status is complete. partial = brief exists but a later step failed.",
            },
            error: {
              type: ["object", "null"],
              properties: {
                code: {
                  type: "string",
                  enum: ["episode_not_found", "audio_unreachable", "transcription_failed", "generation_failed", "reference_enrichment_failed", "internal_error"],
                },
                message: { type: "string" },
              },
            },
            episode: {
              type: "object",
              properties: {
                url: { type: "string" },
                title: { type: ["string", "null"] },
                podcast: { type: ["string", "null"] },
                duration_seconds: { type: ["integer", "null"] },
              },
            },
            credits: {
              type: "object",
              properties: { charged: { type: ["integer", "null"] }, refunded: { type: "integer" } },
            },
            regeneration_count: { type: "integer" },
            queue_position: { type: ["integer", "null"], description: "1-based, only while queued" },
            created_at: { type: "string", format: "date-time" },
            started_at: { type: ["string", "null"], format: "date-time" },
            completed_at: { type: ["string", "null"], format: "date-time" },
            has_output: { type: "boolean" },
            output: {
              type: ["object", "null"],
              description: "Omitted from list responses; null until content exists.",
              properties: {
                markdown: { type: "string" },
                sections: {
                  type: "object",
                  additionalProperties: {
                    type: "object",
                    properties: {
                      heading: { type: "string" },
                      text: { type: "string" },
                      items: { type: "array", items: { type: "string" } },
                    },
                  },
                },
                references: { type: "array", items: { type: "object" } },
              },
            },
          },
        },
      },
    },
    paths: {
      "/v1/me": {
        get: {
          summary: "Account and credit balance",
          responses: { 200: { description: "OK" }, 401: { description: "Unauthorized", content: { "application/json": { schema: error } } } },
        },
      },
      "/v1/quotes": {
        post: {
          summary: "Price an episode without creating a brief",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", required: ["episode_url"], properties: { episode_url: { type: "string", format: "uri" } } },
              },
            },
          },
          responses: {
            200: { description: "Quote with credits_needed, credits_remaining, sufficient" },
            422: { description: "invalid_episode_url | episode_not_found | duration_unknown | episode_too_long", content: { "application/json": { schema: error } } },
          },
        },
      },
      "/v1/briefs": {
        post: {
          summary: "Create a brief (asynchronous)",
          description:
            "Resolves the episode, charges credits atomically, and queues processing. Duplicate episode_url for the same account returns the existing brief with 200 and existing=true. Send Idempotency-Key to make retries safe.",
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 128 } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["episode_url"],
                  properties: {
                    episode_url: { type: "string", format: "uri", description: "Apple Podcasts episode link containing ?i=" },
                    max_credits: { type: "integer", minimum: 0, description: "Refuse (402) if the episode would cost more than this" },
                    callback_url: { type: "string", format: "uri", description: "HTTPS webhook for brief.completed; overrides the key's default" },
                    regenerate: { type: "boolean", description: "Re-run a completed brief (free within 24h, otherwise full price; once per brief)" },
                  },
                },
              },
            },
          },
          responses: {
            202: { description: "Queued", content: { "application/json": { schema: brief } } },
            200: { description: "Already exists (existing=true)", content: { "application/json": { schema: brief } } },
            402: { description: "insufficient_credits | max_credits_exceeded | api_key_cap_exceeded. Body includes top_up_url where applicable.", content: { "application/json": { schema: error } } },
            409: { description: "brief_in_progress | already_regenerated", content: { "application/json": { schema: error } } },
            422: { description: "Episode could not be used", content: { "application/json": { schema: error } } },
            429: { description: "rate_limited" },
          },
        },
        get: {
          summary: "List briefs (summaries, newest first)",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "status", in: "query", schema: { type: "string", enum: ["queued", "generating", "complete"] } },
            { name: "cursor", in: "query", schema: { type: "string" }, description: "next_cursor from the previous page" },
          ],
          responses: { 200: { description: "OK" } },
        },
      },
      "/v1/briefs/{id}": {
        get: {
          summary: "Get a brief with full content",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: brief } } },
            404: { description: "not_found", content: { "application/json": { schema: error } } },
          },
        },
      },
      "/v1/keys": {
        post: { summary: "Create an API key (signed-in humans only)", responses: { 201: { description: "Key returned once" } } },
        get: { summary: "List API keys (signed-in humans only)", responses: { 200: { description: "OK" } } },
      },
      "/v1/keys/{id}": {
        delete: {
          summary: "Revoke an API key (signed-in humans only)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { 200: { description: "Revoked" } },
        },
      },
    },
    "x-webhooks": {
      "brief.completed": {
        description:
          "POST to callback_url when a brief reaches status=complete. Headers: X-PodcastBrief-Event, X-PodcastBrief-Brief-Id, X-PodcastBrief-Signature (t=<unix>,v1=<hex hmac-sha256(callback_secret, `${t}.${rawBody}`)>). Retried every 5 minutes for up to 8 attempts until a 2xx.",
        payload: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { type: "string", const: "brief.completed" },
            created_at: { type: "string", format: "date-time" },
            data: brief,
          },
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