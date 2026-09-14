// Two-step brief request: estimate (duration + cost preview) → confirm (atomic credit deduction).
"use client";

import { useState } from "react";
import apiClient from "@/libs/api";
import { formatDuration } from "@/libs/credits";
import CreditPackModal from "@/components/CreditPackModal";


export default function BriefRequestForm({ onSuccess }) {
  const [url, setUrl] = useState("");
  const [estimateResult, setEstimateResult] = useState(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [inlineError, setInlineError] = useState(null);
  const [inlineErrorCode, setInlineErrorCode] = useState(null);
  const [showInsufficientModal, setShowInsufficientModal] = useState(false);
  const [creditData, setCreditData] = useState(null);

  async function handleEstimate() {
    setEstimateLoading(true);
    setInlineError(null);
    setInlineErrorCode(null);
    setEstimateResult(null);

    try {
      const data = await apiClient.post("/jobs/brief/estimate", { episodeUrl: url });
      setEstimateResult(data);
    } catch (err) {
      if (err.creditData) {
        // 402 — insufficient credits
        setCreditData(err.creditData);
        setShowInsufficientModal(true);
      } else if (err.response?.status === 422 || err.response?.status === 500) {
        setInlineError(
          err.response.data?.message || "Something went wrong. Please try again."
        );
        setInlineErrorCode(err.response.data?.error || null);
      }
      // 401 handled by apiClient (redirect), other errors toasted by apiClient
    } finally {
      setEstimateLoading(false);
    }
  }

  async function handleConfirm() {
    setConfirmLoading(true);

    try {
      await apiClient.post("/jobs/brief", {
        episodeUrl: url,
        durationSeconds: estimateResult.durationSeconds,
        sig: estimateResult.sig,
        episodeTitle: estimateResult.episodeTitle,
        podcastName: estimateResult.podcastName,
      });
      setUrl("");
      setEstimateResult(null);
      if (onSuccess) onSuccess();
    } catch (err) {
      if (err.creditData) {
        setCreditData(err.creditData);
        setShowInsufficientModal(true);
      }
      // 409/other errors toasted by apiClient
    } finally {
      setConfirmLoading(false);
    }
  }

  function handleReset() {
    setEstimateResult(null);
    setInlineError(null);
    setInlineErrorCode(null);
  }


  return (
    <>
      <form onSubmit={(e) => { e.preventDefault(); estimateResult ? handleConfirm() : handleEstimate(); }} className="space-y-4">
        <input
          type="url"
          value={url}
          onChange={(e) => { setUrl(e.target.value); if (estimateResult) handleReset(); }}
          placeholder="https://podcasts.apple.com/..."
          className="input input-bordered w-full"
          disabled={confirmLoading}
        />

        {inlineError && (
          <div className="text-error text-sm space-y-2">
            <p>{inlineError}</p>
            {inlineErrorCode === "episode_too_long" && (
              <a
                href={`mailto:emily@podcastbrief.app?subject=${encodeURIComponent("Interest in longer episode support")}&body=${encodeURIComponent("Hi, I'm interested in getting briefs for episodes longer than 4 hours.\n\nFor example:\n- (Insert podcasts here, optional)")}`}
                className="btn btn-sm btn-outline"
              >
                Let us know you want longer episodes
              </a>
            )}
          </div>
        )}

        {estimateResult && (
          <div className="bg-base-200 rounded-lg p-4 space-y-1">
            <p className="font-semibold">{estimateResult.episodeTitle}</p>
            <p className="text-sm text-base-content/60">
              {formatDuration(estimateResult.durationSeconds)} &middot; {estimateResult.creditsNeeded} credit{estimateResult.creditsNeeded === 1 ? "" : "s"}
            </p>
            <p className="text-sm text-base-content/60">
              You will have {estimateResult.creditsRemaining - estimateResult.creditsNeeded} credit{estimateResult.creditsRemaining - estimateResult.creditsNeeded === 1 ? "" : "s"} remaining
            </p>
          </div>
        )}

        {estimateResult ? (
          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={confirmLoading}
          >
            {confirmLoading ? "Generating..." : `Generate Brief (${estimateResult.creditsNeeded} credit${estimateResult.creditsNeeded === 1 ? "" : "s"})`}
          </button>
        ) : (
          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={estimateLoading || !url.trim()}
          >
            {estimateLoading ? "Checking..." : "Check Episode"}
          </button>
        )}
      </form>

      <CreditPackModal
        isOpen={showInsufficientModal}
        onClose={() => setShowInsufficientModal(false)}
        title="Not enough credits"
        subtitle={creditData?.message}
      />
    </>
  );
}
