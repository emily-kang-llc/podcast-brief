import { useState, useEffect } from "react";
import Link from "next/link";
import toast from "react-hot-toast";
import config from "@/config";
import apiClient from "@/libs/api";
import { useFCaptcha } from "@/libs/fcaptcha/useFCaptcha";
import { getRegenCost } from "@/libs/credits";

export default function BriefRequestForm({ episodeUrl, onSubmit, onCancel }) {
  const [isLoading, setIsLoading] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenCost, setRegenCost] = useState(null);
  const { enabled, ready, prepare, consume, invalidate } = useFCaptcha();

  // When the URL changes, reset state
  useEffect(() => {
    setEstimate(null);
    setRegenCost(null);
  }, [episodeUrl]);

  const handleEstimate = async (e) => {
    e?.preventDefault();
    if (!episodeUrl) return;
    
    setIsLoading(true);
    
    try {
      const data = await apiClient.post("/jobs/brief/estimate", { episodeUrl });
      setEstimate(data);
      
      // Prepare the token for brief submission when validated
      if (enabled && ready) {
        await prepare("brief_submit");
      }
    } catch (error) {
      console.error("Estimate error:", error);
      toast.error("Failed to estimate episode: " + (error.message || "Unknown error"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (!episodeUrl || !estimate) return;
    
    setIsLoading(true);
    
    try {
      // Get the FCaptcha token if available
      const fcaptchaToken = enabled && ready ? await prepare("brief_submit") : null;
      
      const data = await apiClient.post("/jobs/brief", {
        episodeUrl,
        durationSeconds: estimate.durationSeconds,
        sig: estimate.sig,
        episodeTitle: estimate.episodeTitle,
        podcastName: estimate.podcastName,
        fcaptchaToken
      });
      
      // Called on success
      if (onSubmit) {
        onSubmit(data);
      }
    } catch (error) {
      console.error("Submit error:", error);
      if (error.response?.status === 402) {
        toast.error("Insufficient credits");
      } else {
        toast.error("Failed to submit brief: " + (error.message || "Unknown error"));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegenerate = async (e) => {
    e?.preventDefault();
    if (!episodeUrl) return;
    
    setRegenerating(true);
    
    try {
      // Get the FCaptcha token for regeneration
      const fcaptchaToken = enabled && ready ? await prepare("brief_regenerate") : null;
      
      const data = await apiClient.post("/jobs/brief", {
        episodeUrl,
        regenerate: true,
        fcaptchaToken
      });
      
      // Called on success
      if (onSubmit) {
        onSubmit(data);
      }
    } catch (error) {
      console.error("Regenerate error:", error);
      toast.error("Failed to regenerate brief: " + (error.message || "Unknown error"));
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body">
        <h2 className="card-title">Submit Podcast Episode</h2>
        
        <div className="form-control w-full max-w-xs">
          <label className="label">
            <span className="label-text">Apple Podcasts URL</span>
          </label>
          <input
            type="text"
            placeholder="Enter Apple Podcasts URL"
            className="input input-bordered w-full max-w-xs"
            value={episodeUrl || ""}
            onChange={(e) => {
              if (onCancel) onCancel();
              setEstimate(null);
              setRegenCost(null);
              // Call callback with new URL
              if (onSubmit) onSubmit({ episodeUrl: e.target.value });
            }}
          />
        </div>
        
        <div className="flex flex-row gap-2 mt-2">
          <button
            className="btn btn-primary"
            onClick={handleEstimate}
            disabled={isLoading || !episodeUrl}
          >
            {isLoading && <span className="loading loading-spinner loading-xs"></span>}
            Estimate
          </button>
          
          {estimate && (
            <button
              className="btn btn-secondary"
              onClick={handleSubmit}
              disabled={isLoading}
            >
              {isLoading && <span className="loading loading-spinner loading-xs"></span>}
              Generate Brief
            </button>
          )}
          
          {estimate && (
            <button
              className="btn btn-accent"
              onClick={handleRegenerate}
              disabled={regenerating}
            >
              {regenerating && <span className="loading loading-spinner loading-xs"></span>}
              Regenerate
            </button>
          )}
        </div>
        
        {estimate && (
          <div className="mt-4">
            <p>
              <strong>Episode:</strong> {estimate.episodeTitle}
            </p>
            <p>
              <strong>Podcast:</strong> {estimate.podcastName}
            </p>
            <p>
              <strong>Duration:</strong> {Math.floor(estimate.durationSeconds / 60)}:{String(estimate.durationSeconds % 60).padStart(2, '0')}
            </p>
            <p>
              <strong>Estimated Credits:</strong> {estimate.creditsNeeded}
            </p>
            <p>
              <strong>Credits Remaining:</strong> {estimate.creditsRemaining}
            </p>
          </div>
        )}
        
        <div className="mt-4">
          <p className="text-sm opacity-70">
            Briefs are generated using AI and may contain inaccuracies. 
            The process typically takes 1-3 minutes.
          </p>
        </div>
      </div>
    </div>
  );
}