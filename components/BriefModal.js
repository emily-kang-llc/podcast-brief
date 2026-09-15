import { useState } from "react";
// import { useEffect } from "react";
import toast from "react-hot-toast";
import { useFCaptcha } from "@/libs/fcaptcha/useFCaptcha";
import apiClient from "@/libs/api";

export default function BriefModal({
  brief,
  isOpen,
  onClose,
  onRegenerate,
  onConfirm,
}) {
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const { enabled, ready, execute } = useFCaptcha();

  const handleRegenerate = async (e) => {
    e?.preventDefault();
    if (!brief?.input_url) return;
    
    setShowRegenerateConfirm(true);
  };

  const confirmRegenerate = async () => {
    if (!brief?.input_url) return;
    
    setIsRegenerating(true);
    setShowRegenerateConfirm(false);
    
    try {
      // Get the FCaptcha token for regeneration
      const fcaptchaToken = enabled && ready ? await execute("brief_regenerate") : null;
      
      const data = await apiClient.post("/jobs/brief", {
        episodeUrl: brief.input_url,
        regenerate: true,
        fcaptchaToken
      });
      
      if (onRegenerate) {
        onRegenerate(data);
      }
      
      toast.success("Brief regeneration queued");
      onClose();
    } catch (error) {
      console.error("Regenerate error:", error);
      toast.error("Failed to regenerate brief: " + (error.message || "Unknown error"));
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleConfirm = async (e) => {
    e?.preventDefault();
    if (!brief?.input_url) return;
    
    try {
      // Get the FCaptcha token if available
      const fcaptchaToken = enabled && ready ? await execute("brief_submit") : null;
      
      const data = await apiClient.post("/jobs/brief", {
        episodeUrl: brief.input_url,
        durationSeconds: brief.episode_duration_seconds,
        sig: brief.sig,  // This would need to be passed from a fresh estimate
        episodeTitle: brief.episode_title,
        podcastName: brief.podcast_name,
        fcaptchaToken
      });
      
      if (onConfirm) {
        onConfirm(data);
      }
      
      toast.success("Brief queued");
      onClose();
    } catch (error) {
      console.error("Submit error:", error);
      toast.error("Failed to submit brief: " + (error.message || "Unknown error"));
    }
  };

  return (
    <div className={`modal ${isOpen ? "modal-open" : ""}`}>
      <div className="modal-box max-w-3xl">
        <h3 className="font-bold text-lg">Brief Details</h3>
        
        {brief && (
          <div className="py-4">
            <p>
              <strong>Episode:</strong> {brief.episode_title}
            </p>
            <p>
              <strong>Podcast:</strong> {brief.podcast_name}
            </p>
            <p>
              <strong>Status:</strong> {brief.status}
            </p>
            <p>
              <strong>Duration:</strong> {Math.floor(brief.episode_duration_seconds / 60)}:{String(brief.episode_duration_seconds % 60).padStart(2, '0')}
            </p>
            <p>
              <strong>Created:</strong> {new Date(brief.created_at).toLocaleString()}
            </p>
            
            {brief.started_at && (
              <p>
                <strong>Started:</strong> {new Date(brief.started_at).toLocaleString()}
              </p>
            )}
            
            {brief.completed_at && (
              <p>
                <strong>Completed:</strong> {new Date(brief.completed_at).toLocaleString()}
              </p>
            )}
            
            {brief.output_markdown && (
              <div className="mt-4">
                <h4 className="font-bold">Brief Preview:</h4>
                <div className="mockup-code bg-base-200 p-2 mt-1">
                  <pre className="whitespace-pre-wrap">
                    <code>{brief.output_markdown.substring(0, 300)}{brief.output_markdown.length > 300 ? '...' : ''}</code>
                  </pre>
                </div>
              </div>
            )}
          </div>
        )}
        
        <div className="modal-action">
          <button className="btn" onClick={onClose}>Close</button>
          {brief?.status === "complete" && (
            <button 
              className="btn btn-secondary"
              onClick={handleRegenerate}
              disabled={isRegenerating}
            >
              {isRegenerating && <span className="loading loading-spinner loading-xs"></span>}
              Regenerate
            </button>
          )}
          {brief?.status !== "complete" && (
            <button 
              className="btn btn-primary"
              onClick={handleConfirm}
            >
              Generate Brief
            </button>
          )}
        </div>
      </div>
      
      {/* Regeneration confirmation modal */}
      {showRegenerateConfirm && (
        <div className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Confirm Regeneration</h3>
            <p className="py-4">
              This will regenerate the brief using the same episode URL. 
              Are you sure you want to continue?
            </p>
            <div className="modal-action">
              <button className="btn" onClick={() => setShowRegenerateConfirm(false)}>Cancel</button>
              <button 
                className="btn btn-error"
                onClick={confirmRegenerate}
                disabled={isRegenerating}
              >
                {isRegenerating && <span className="loading loading-spinner loading-xs"></span>}
                Regenerate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}