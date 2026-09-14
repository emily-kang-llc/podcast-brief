import express from "express";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { writeFileSync } from "fs";
import { mkdir, rm } from "fs/promises";
import supabase from "./libs/supabase/admin.mjs";
import { setupExpressErrorHandler } from "posthog-node";
import { getPostHog } from "./libs/posthog/server.mjs";
import { run as transcribe } from "./scripts/transcribe.mjs";
import { run as generateBrief } from "./scripts/generate-brief.mjs";
import { run as enrichReferences } from "./scripts/enrich-references.mjs";
import { run as validateReferences } from "./scripts/validate-references.mjs";
import { run as mergeReferences } from "./scripts/merge-references.mjs";
import { briefHasAllSections, briefHasReferences } from "./scripts/validate_pipeline.mjs";
import { cleanUrl } from "./libs/url.mjs";
import { sendBriefEmail } from "./libs/email/briefEmail.mjs";
import { toPublicBrief, classifyPipelineError } from "./libs/briefs/serialize.mjs";
import { webhookSignatureHeader } from "./libs/api-keys.mjs";

const APP_ENV = process.env.APP_ENV || "DEVELOPMENT";
const STALE_JOB_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

// Completion webhooks (agent-first API). One immediate attempt after the brief
// completes; failures are retried by retryPendingWebhooks on the recovery
// interval until delivered or WEBHOOK_MAX_ATTEMPTS is reached.
const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_MAX_ATTEMPTS = 8;
const WEBHOOK_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function logError(...args) {
  const ts = new Date().toISOString();
  console.error(`[${ts}]`, ...args);
}

// Retry prompt additions keyed by validation failure type
const RETRY_PROMPTS = {
  noReferences:
    "Ensure the brief includes a REFERENCES section with at least one real, citable reference mentioned in the episode. Do not hallucinate references.",
  missingSections:
    "Ensure the brief includes all required sections (SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, CLAIMS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS) with substantive content in each.",
};

const posthog = getPostHog();
log(`[posthog] initialized: ${posthog !== null}`);

const app = express();
app.use(express.json());

// Health check — must be before auth middleware so Railway can reach it unauthenticated
app.get("/status", async (req, res) => {
  const { data: generating, error } = await supabase
    .from("briefs")
    .select("id, created_at")
    .eq("status", "generating")
    .eq("environment", APP_ENV)
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const { data: queued, error: queuedError } = await supabase
    .from("briefs")
    .select("id, created_at")
    .eq("status", "queued")
    .eq("environment", APP_ENV)
    .order("created_at", { ascending: true });

  if (queuedError) return res.status(500).json({ error: queuedError.message });

  res.json({
    activeJobs: generating.length,
    queuedJobs: queued.length,
    jobs: generating,
    queued,
  });
});

// Catches Express-level errors (malformed JSON, auth failures, etc.)
// Pipeline errors are fire-and-forget so they're caught in runPipeline's catch block instead.
if (posthog) setupExpressErrorHandler(posthog, app);

// Closes out a brief row regardless of outcome. Pass outputMarkdown + references on
// success; omit them on failure — the row still flips to "complete" so the user isn't
// left hanging. `outcome`/`errorCode`/`errorMessage` are the agent-facing verdict
// (see libs/briefs/serialize.mjs); `errorLog` remains developer-only.
async function completeBrief(
  briefId,
  {
    outputMarkdown = null,
    references = null,
    errorLog = null,
    completedAt = null,
    outcome = null,
    errorCode = null,
    errorMessage = null,
  } = {}
) {
  const { error } = await supabase
    .from("briefs")
    .update({
      status: "complete",
      completed_at: completedAt || new Date().toISOString(),
      ...(outputMarkdown !== null && { output_markdown: outputMarkdown }),
      ...(references !== null && { references }),
      ...(errorLog !== null && { error_log: errorLog }),
      ...(outcome !== null && { outcome }),
      error_code: errorCode,
      error_message: errorMessage,
    })
    .eq("id", briefId);

  if (error) {
    logError(`Failed to complete brief ${briefId}:`, error.message);
  }
}

// Sends a webhook alert to the developer on pipeline failure or degradation.
async function alertDeveloper({ briefId, jobId, error, episodeUrl, context }) {
  if (!process.env.WEBHOOK_URL) return;
  await fetch(cleanUrl("WEBHOOK_URL"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      briefId,
      jobId,
      error,
      episodeUrl,
      context,
      timestamp: new Date().toISOString(),
    }),
  }).catch((err) => logError(`[webhook error] ${err.message}`));
}

// Automatic refund for a brief that failed with no usable output. Only first
// runs are refunded automatically: a failed regeneration may have been free
// (24h window) while credits_charged still reflects the original run, so the
// RPC could over-refund. Those go to the developer alert for manual handling.
async function refundFailedBrief({ briefId, regenerationCount, episodeUrl, jobId }) {
  if ((regenerationCount ?? 0) > 0) {
    await alertDeveloper({
      briefId,
      jobId,
      error: "Regeneration failed — check whether a manual refund is due",
      episodeUrl,
      context: { regenerationCount },
    });
    return;
  }
  const { data, error } = await supabase.rpc("refund_brief_credits", {
    p_brief_id: briefId,
    p_reason: "refund:brief_failure",
  });
  if (error) {
    logError(`[refund] RPC failed for ${briefId}:`, error.message);
    return;
  }
  if (data?.error && data.error !== "already_refunded") {
    logError(`[refund] ${briefId}: ${data.error}`);
    return;
  }
  log(`[refund] ${briefId}: refunded ${data?.credits_refunded ?? 0} credit(s)`);
}

// Delivers the brief.completed webhook for one brief. Re-reads the row so the
// payload reflects the final state. Signed with the API key's callback_secret
// when the brief was created by a key; unsigned otherwise (callback_url supplied
// by a session caller). Returns true when the receiver answered 2xx.
async function deliverBriefWebhook(briefId) {
  const { data: brief, error } = await supabase.from("briefs").select("*").eq("id", briefId).single();
  if (error || !brief) {
    logError(`[webhook] could not load brief ${briefId}:`, error?.message);
    return false;
  }
  if (!brief.callback_url || brief.webhook_delivered_at || brief.status !== "complete") return false;

  let secret = null;
  if (brief.api_key_id) {
    const { data: key } = await supabase
      .from("api_keys")
      .select("callback_secret")
      .eq("id", brief.api_key_id)
      .maybeSingle();
    secret = key?.callback_secret ?? null;
  }

  const payload = JSON.stringify({
    id: `evt_${randomUUID()}`,
    type: "brief.completed",
    created_at: new Date().toISOString(),
    data: toPublicBrief(brief),
  });

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "PodcastBrief-Webhooks/1.0",
    "X-PodcastBrief-Event": "brief.completed",
    "X-PodcastBrief-Brief-Id": brief.id,
  };
  if (secret) headers["X-PodcastBrief-Signature"] = webhookSignatureHeader(secret, payload);

  let status = 0;
  let ok = false;
  try {
    const res = await fetch(brief.callback_url, {
      method: "POST",
      headers,
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    status = res.status;
    ok = res.ok;
  } catch (err) {
    logError(`[webhook] delivery to ${brief.callback_url} failed for ${brief.id}:`, err.message);
  }

  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("briefs")
    .update({
      webhook_attempts: (brief.webhook_attempts ?? 0) + 1,
      webhook_last_status: status,
      webhook_last_attempt_at: now,
      ...(ok && { webhook_delivered_at: now }),
    })
    .eq("id", brief.id);
  if (updateError) logError(`[webhook] failed to record attempt for ${brief.id}:`, updateError.message);

  log(`[webhook] ${brief.id} → ${status} (${ok ? "delivered" : "will retry"})`);
  return ok;
}

// Retries undelivered webhooks for briefs completed in the last 24h. Runs on the
// recovery interval (5 min), so effective retry spacing is ~5 min × 8 attempts.
async function retryPendingWebhooks() {
  const since = new Date(Date.now() - WEBHOOK_RETRY_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("briefs")
    .select("id")
    .eq("environment", APP_ENV)
    .eq("status", "complete")
    .not("callback_url", "is", null)
    .is("webhook_delivered_at", null)
    .lt("webhook_attempts", WEBHOOK_MAX_ATTEMPTS)
    .gt("completed_at", since)
    .order("completed_at", { ascending: true })
    .limit(20);
  if (error) {
    logError(`[webhook] retry scan failed: ${error.message}`);
    return;
  }
  for (const row of data || []) {
    await deliverBriefWebhook(row.id).catch((e) => logError(`[webhook] retry error for ${row.id}:`, e.message));
  }
}

// Generates a brief and validates it, retrying once with a targeted prompt if sections or
// references are missing. On second failure, patches a placeholder REFERENCES section so the
// pipeline can continue rather than hard-failing.
async function generateBriefWithValidation({
  transcriptId,
  transcriptPath,
  profileId,
  briefId,
  outputDir,
  errorLog,
  posthogCtx,
}) {
  let { outputPath, outputMd } = await generateBrief({
    transcriptId,
    transcriptPath,
    profileId,
    briefId,
    outputDir,
    ...posthogCtx,
  });

  const sectionsCheck = briefHasAllSections(outputMd);
  const refsCheck = briefHasReferences(outputMd);
  if (sectionsCheck.valid && refsCheck.valid) return { outputPath, outputMd };

  const reasons = [sectionsCheck, refsCheck].filter((c) => !c.valid).map((c) => c.reason);
  const promptAddition = !refsCheck.valid ? RETRY_PROMPTS.noReferences : RETRY_PROMPTS.missingSections;
  errorLog.push({ step: "validate-output", attempt: 1, reasons });
  logError(`[retry] Brief validation failed: ${reasons.join("; ")} — retrying generateBrief`);

  ({ outputPath, outputMd } = await generateBrief({
    transcriptId,
    transcriptPath,
    profileId,
    briefId,
    force: true,
    promptAddition,
    outputDir,
    ...posthogCtx,
  }));

  const refsCheck2 = briefHasReferences(outputMd);
  if (!refsCheck2.valid) {
    errorLog.push({ step: "validate-output", attempt: 2, reason: refsCheck2.reason });
    outputMd += "\n\n## REFERENCES\n\nNo references found.\n";
    writeFileSync(outputPath, outputMd, "utf-8");
  }

  return { outputPath, outputMd };
}

async function runPipeline(episodeUrl, profileId, briefId) {
  const jobId = randomUUID();
  const traceId = randomUUID();
  const pipelineSpanId = randomUUID();
  const pipelineStart = Date.now();
  const jobDir = path.join(os.tmpdir(), `podcast-brief-${jobId}`);
  await mkdir(jobDir, { recursive: true });
  const errorLog = [];
  const posthogCtx = { posthog, traceId, pipelineSpanId };

  // Tracks which stage threw, so the catch block can emit a stable error_code.
  let step = "transcribe";

  try {
    const { episodeId, transcriptPath, podcastName, episodeTitle } = await transcribe(episodeUrl, { outputDir: jobDir });

    const { error: metaError } = await supabase
      .from("briefs")
      .update({ podcast_name: podcastName, episode_title: episodeTitle })
      .eq("id", briefId);
    if (metaError) logError(`[metadata] Failed to save episode metadata for brief ${briefId}:`, metaError.message);

    step = "generate";
    const { outputPath, outputMd } = await generateBriefWithValidation({
      transcriptId: episodeId,
      transcriptPath,
      profileId,
      briefId,
      outputDir: jobDir,
      errorLog,
      posthogCtx,
    });

    step = "enrich";
    const { referencesJsonPath } = await enrichReferences(outputPath, {
      outputDir: jobDir,
      profileId,
      ...posthogCtx,
    });

    let finalBriefMd = outputMd;
    let referencesJson = null;

    if (referencesJsonPath) {
      step = "validate-references";
      const { referencesMdPath, referencesJson: validated } = await validateReferences(referencesJsonPath);
      referencesJson = validated;
      step = "merge";
      ({ finalBriefMd } = await mergeReferences({
        briefPath: outputPath,
        referencesPath: referencesMdPath,
        outputDir: jobDir,
      }));
    }

    step = "complete";
    const completedAt = new Date().toISOString();
    // LLM validation retries (errorLog "validate-output" entries) do not change
    // the outcome: the user got a full brief. They remain visible in error_log.
    await completeBrief(briefId, {
      outputMarkdown: finalBriefMd,
      references: referencesJson,
      errorLog: errorLog.length > 0 ? errorLog : null,
      completedAt,
      outcome: "succeeded",
    });

    // Awaited but non-blocking — errors caught, don't crash pipeline
    if (finalBriefMd) {
      await sendBriefEmail({
        briefId,
        profileId,
        outputMarkdown: finalBriefMd,
        episodeTitle,
        podcastName,
        completedAt,
      }).catch((err) => logError(`[email] Failed to send brief email for ${briefId}:`, err.message));
    }

    await deliverBriefWebhook(briefId).catch((e) => logError(`[webhook] ${briefId}:`, e.message));

    if (errorLog.length > 0) {
      await alertDeveloper({
        briefId,
        jobId,
        error: "Pipeline completed with degradation",
        episodeUrl,
        context: errorLog,
      });
    }

    posthog?.capture({
      distinctId: profileId,
      event: "$ai_span",
      properties: {
        $ai_trace_id: traceId,
        $ai_span_id: pipelineSpanId,
        $ai_span_name: "brief-pipeline",
        $ai_latency: (Date.now() - pipelineStart) / 1000,
        $ai_is_error: errorLog.length > 0,
        $ai_input_state: { episodeUrl },
        $ai_output_state: { briefId },
      },
    });
    if (posthog) {
      log(`[posthog] flushing ${traceId}`);
      await posthog.flush().catch((e) => logError(`[posthog] flush failed: ${e.message}`));
      log(`[posthog] flushed`);
    }

    log(`[pipeline] complete [job=${jobId}]${errorLog.length > 0 ? " (degraded)" : ""}`);
  } catch (err) {
    logError(`[pipeline error] step=${step} ${err.message}`);
    errorLog.push({ step: "unrecoverable", failedStep: step, error: err.message, stack: err.stack });
    posthog?.captureException(err, profileId, {
      briefId,
      jobId,
      episodeUrl,
      pipeline_step: step,
    });

    // Read what survived (output_markdown is written mid-pipeline as crash
    // insurance) BEFORE closing the row, so the outcome can be decided in one write.
    const { data: partialBrief } = await supabase
      .from("briefs")
      .select("output_markdown, podcast_name, episode_title, regeneration_count")
      .eq("id", briefId)
      .single();

    const hasContent = Boolean(partialBrief?.output_markdown);
    const classified = classifyPipelineError(step, err);
    const errorCompletedAt = new Date().toISOString();

    await completeBrief(briefId, {
      errorLog,
      completedAt: errorCompletedAt,
      outcome: hasContent ? "partial" : "failed",
      errorCode: classified.code,
      errorMessage: classified.message,
    }).catch((e) => logError("[cleanup] Failed to update brief status:", e.message));

    if (hasContent) {
      await sendBriefEmail({
        briefId,
        profileId,
        outputMarkdown: partialBrief.output_markdown,
        completedAt: errorCompletedAt,
        episodeTitle: partialBrief.episode_title,
        podcastName: partialBrief.podcast_name,
      }).catch((emailErr) => logError(`[email] Failed to send brief email for ${briefId}:`, emailErr.message));
    } else {
      await refundFailedBrief({
        briefId,
        regenerationCount: partialBrief?.regeneration_count ?? 0,
        episodeUrl,
        jobId,
      }).catch((e) => logError(`[refund] ${briefId}:`, e.message));
    }

    await deliverBriefWebhook(briefId).catch((e) => logError(`[webhook] ${briefId}:`, e.message));

    await alertDeveloper({ briefId, jobId, error: err.message, episodeUrl, context: errorLog });
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch((e) =>
      logError("[cleanup] Failed to remove job dir:", e.message)
    );
  }
}

// ── Supabase polling ──────────────────────────────────────────────────────────

// Reset stale generating jobs back to queued. Does NOT filter on output_markdown —
// a row with partial content that never got completeBrief()'d is still stuck.
// Re-running the pipeline will overwrite the partial content with the full result.
async function recoverStaleJobs() {
  let query = supabase
    .from("briefs")
    .update({ status: "queued", started_at: null })
    .eq("status", "generating")
    .eq("environment", APP_ENV)
    .lt("started_at", new Date(Date.now() - STALE_JOB_TIMEOUT_MS).toISOString());
  if (currentJobId) query = query.neq("id", currentJobId);
  const { data, error } = await query.select("id");
  if (error) logError(`[recovery] Error recovering stale jobs: ${error.message}`);
  if (data?.length) log(`[recovery] Reset ${data.length} stale generating job(s) to queued`);
}

let isProcessing = false;
let currentJobId = null;

// Finds the oldest queued job and atomically claims it via UPDATE ... WHERE status='queued'.
// Under a two-worker race, only one UPDATE affects a row (Postgres row-level locking) — the
// loser's .select() returns empty and it moves on. Extracted from pollForWork so it can be
// exercised directly in tests without pollForWork's recursive setTimeout scheduling.
async function claimNextJob() {
  const { data: jobs } = await supabase
    .from("briefs")
    .select("id, input_url, profile_id")
    .eq("status", "queued")
    .eq("environment", APP_ENV)
    .order("created_at", { ascending: true })
    .limit(1);

  if (!jobs?.length) return null;
  const job = jobs[0];

  const { data: claimed } = await supabase
    .from("briefs")
    .update({ status: "generating", started_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("status", "queued")
    .select("id, input_url, profile_id");

  return claimed?.length ? claimed[0] : null; // empty = another worker claimed it first
}

async function pollForWork() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const claimedJob = await claimNextJob();
    if (!claimedJob) return;

    currentJobId = claimedJob.id;
    await runPipeline(claimedJob.input_url, claimedJob.profile_id, claimedJob.id);
  } catch (err) {
    logError(`[pipeline error] ${err.message}`);
  } finally {
    currentJobId = null;
    isProcessing = false;
  }

  // Immediately check for more work instead of waiting for next interval
  setTimeout(pollForWork, 0);
}

// Test-only: pollForWork() is the only normal way currentJobId gets set, but calling
// pollForWork() directly in a test starts its recursive setTimeout(pollForWork, 0) chain
// forever. This lets tests exercise recoverStaleJobs' own-in-flight-job exclusion without that.
function __setCurrentJobIdForTesting(id) {
  currentJobId = id;
}

// Run stale job recovery (and webhook retries) every 5 minutes — not just on boot.
// Railway blue-green deploys can kill the old container mid-pipeline, leaving
// briefs stuck at "generating". The startup recovery misses them if they're
// too fresh (<20min). Periodic recovery catches them on the next pass.
const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

const PORT = process.env.PORT || 3001;

// Guards the boot sequence (HTTP listen + polling loops) so importing this module — e.g. from
// a test — never starts a live server or background polling. Only runs when server.mjs is
// executed directly (`node server.mjs`), matching Railway's startCommand.
const isMainModule = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  app.listen(PORT, async () => {
    log(`Worker listening on port ${PORT} (env: ${APP_ENV})`);
    await recoverStaleJobs();
    await retryPendingWebhooks();
    setInterval(recoverStaleJobs, RECOVERY_INTERVAL_MS);
    setInterval(retryPendingWebhooks, RECOVERY_INTERVAL_MS);
    setInterval(pollForWork, POLL_INTERVAL_MS);
    pollForWork(); // check immediately on boot
  });

  process.on("SIGTERM", async () => {
    await posthog?.shutdown();
    process.exit(0);
  });
}

export {
  app,
  claimNextJob,
  recoverStaleJobs,
  retryPendingWebhooks,
  deliverBriefWebhook,
  pollForWork,
  runPipeline,
  STALE_JOB_TIMEOUT_MS,
  __setCurrentJobIdForTesting,
};