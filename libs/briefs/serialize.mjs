// Agent-facing shape of a brief, shared by the Next.js v1 routes and the Railway
// worker (webhook payloads). Universal .mjs: nothing Next-specific here.
export const BRIEF_ERROR_CODES = Object.freeze({
  episode_not_found: "The episode could not be resolved from the Apple Podcasts URL.",
  audio_unreachable: "The episode's audio file could not be fetched.",
  transcription_failed: "Transcription failed.",
  generation_failed: "The brief could not be generated from the transcript.",
  reference_enrichment_failed:
    "The brief was generated, but reference enrichment failed. Links may be missing.",
  internal_error: "An unexpected error occurred while processing the episode.",
});
// Maps a pipeline step + thrown error to a stable, user-safe error code. The raw
// message and stack stay in briefs.error_log (developer-only); agents get this.
export function classifyPipelineError(step, err) {
  const raw = (err && err.message) || String(err || "");
  let code;
  switch (step) {
    case "transcribe":
      if (/^\[422\]/.test(raw) && /audio/i.test(raw)) code = "audio_unreachable";
      else if (/^\[422\]/.test(raw)) code = "episode_not_found";
      else if (/download|CDN|No audio URL/i.test(raw)) code = "audio_unreachable";
      else code = "transcription_failed";
      break;
    case "generate":
      code = "generation_failed";
      break;
    case "enrich":
    case "validate-references":
    case "merge":
      code = "reference_enrichment_failed";
      break;
    default:
      code = "internal_error";
  }
  return { code, message: BRIEF_ERROR_CODES[code] };
}
// Splits brief markdown on "## HEADING" lines into
// { summary: { heading, text, items }, ideas: {...}, ... }.
// Keys are lowercased with non-alphanumerics collapsed to "_", so
// "ONE-SENTENCE TAKEAWAY" → "one_sentence_takeaway".
export function parseBriefSections(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) return {};
  const sections = {};
  let current = null;
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const title = heading[1].trim();
      const key = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      current = { heading: title, text: "", items: [] };
      sections[key] = current;
      continue;
    }
    if (!current) continue;
    current.text += (current.text ? "\n" : "") + line;
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (bullet) current.items.push(bullet[1].trim());
  }
  for (const s of Object.values(sections)) s.text = s.text.trim();
  return sections;
}
// Pre-API briefs have outcome = NULL; derive it the way the dashboard badge does.
export function deriveOutcome(row) {
  if (row.status !== "complete") return null;
  if (row.outcome) return row.outcome;
  return row.output_markdown ? "succeeded" : "failed";
}
export function toPublicBrief(row, { includeContent = true, queuePosition = null } = {}) {
  const outcome = deriveOutcome(row);
  let error = null;
  if (row.error_code) {
    error = {
      code: row.error_code,
      message: row.error_message || BRIEF_ERROR_CODES[row.error_code] || BRIEF_ERROR_CODES.internal_error,
    };
  } else if (outcome === "failed") {
    error = { code: "internal_error", message: BRIEF_ERROR_CODES.internal_error };
  }
  const hasOutput = Boolean(row.output_markdown);
  return {
    id: row.id,
    object: "brief",
    status: row.status, // queued | generating | complete
    outcome, // null while in progress; succeeded | partial | failed once complete
    error,
    episode: {
      url: row.input_url,
      title: row.episode_title ?? null,
      podcast: row.podcast_name ?? null,
      duration_seconds: row.episode_duration_seconds ?? null,
    },
    credits: {
      charged: row.credits_charged ?? null,
      refunded: row.credits_refunded ?? 0,
    },
    regeneration_count: row.regeneration_count ?? 0,
    queue_position: row.status === "queued" ? queuePosition : null,
    created_at: row.created_at,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
    has_output: hasOutput,
    output:
      includeContent && hasOutput
        ? {
            markdown: row.output_markdown,
            sections: parseBriefSections(row.output_markdown),
            references: Array.isArray(row.references) ? row.references : [],
          }
        : null,
  };
}