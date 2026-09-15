import { useState, useEffect } from "react";
import { useFCaptcha } from "@/libs/fcaptcha/useFCaptcha";
import apiClient from "@/libs/api";
import toast from "react-hot-toast";

export default function BriefModal({ brief, onRegenerate, onClose }) {
  const [isRegenerating, setIsRegenerating] = useState(false);
  const { prepare, consume } = useFCaptcha();

  // Pre-mint the regeneration token while the user reads the brief, so the
  // regenerate click never waits on it.
  useEffect(() => {
    if (brief?.status === "complete") {
      prepare("brief_regenerate").catch(() => {});
    }
  }, [brief?.status, prepare]);

  const handleRegenerate = async () => {
    if (!brief) return;
    
    setIsRegenerating(true);
    
    try {
      // Single-use: consume the pre-minted regeneration token.
      const fcaptchaToken = await consume("brief_regenerate");
      
      const data = await apiClient.post(`/jobs/brief/${brief.id}/regenerate`, {
        fcaptchaToken
      });
      
      // Called on success
      if (onRegenerate) {
        onRegenerate(data);
      }
    } catch (error) {
      console.error("Regenerate error:", error);
      toast.error("Failed to regenerate brief: " + (error.message || "Unknown error"));
    } finally {
      setIsRegenerating(false);
    }
  };

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-4xl max-h-[90vh] overflow-y-auto">
        <h3 className="font-bold text-lg mb-4">Generated Brief</h3>
        
        {brief && (
          <div>
            <div className="flex justify-between items-start mb-4">
              <div>
                <h2 className="text-xl font-semibold">{brief.episodeTitle}</h2>
                <p className="opacity-70">{brief.podcastName}</p>
              </div>
              
              <div className="flex gap-2">
                <button 
                  className="btn btn-outline btn-sm"
                  onClick={onClose}
                >
                  Close
                </button>
              </div>
            </div>
            
            {brief.status !== "complete" ? (
              <div>
                <p className="text-center py-8">
                  Brief is still being generated... 
                </p>
              </div>
            ) : (
              <div>
                <div className="prose max-w-none">
                  {brief.outputMarkdown && (
                    <div 
                      className="markdown-body"
                      dangerouslySetInnerHTML={{ __html: brief.outputMarkdown }} 
                    />
                  )}
                </div>
                
                <div className="mt-6 flex justify-end gap-2">
                  <button
                    className="btn btn-outline"
                    onClick={onClose}
                  >
                    Close
                  </button>
                  
                  <button
                    className="btn btn-primary"
                    onClick={handleRegenerate}
                    disabled={isRegenerating}
                  >
                    {isRegenerating && <span className="loading loading-spinner loading-xs"></span>}
                    Regenerate Brief
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        
        <div className="modal-action">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}