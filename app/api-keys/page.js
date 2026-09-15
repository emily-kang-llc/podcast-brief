"use client";

import { useState, useEffect } from "react";
import apiClient from "@/libs/api";
import { useFCaptcha } from "@/libs/fcaptcha/useFCaptcha";
import toast from "react-hot-toast";

export default function ApiKeysPage() {
  const [apiKeys, setApiKeys] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newRawKey, setNewRawKey] = useState(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const { prepare, consume } = useFCaptcha();

  useEffect(() => {
    fetchApiKeys();
  }, []);

  const fetchApiKeys = async () => {
    setIsLoading(true);
    try {
      const data = await apiClient.get("/api/v1/keys");
      setApiKeys(data);
    } catch (error) {
      console.error("Failed to fetch API keys:", error);
      toast.error("Failed to fetch API keys");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateKey = async (e) => {
    e.preventDefault();

    try {
      // Consume the pre-minted single-use token (prepared when the form
      // opened); falls back to minting if the background prepare didn't land.
      const fcaptchaToken = await consume("api_key_create");

      const data = await apiClient.post("/api/v1/keys", {
        description: newKeyName,
        fcaptchaToken,
      });
      
      // Show the raw key to the user (once only)
      toast.success("API key created successfully");
      setApiKeys(prev => [{ id: data.id, description: newKeyName, key_prefix: data.prefix, created_at: new Date().toISOString(), revoked_at: null }, ...prev]);
      setNewRawKey(data.raw);
      setNewKeyName("");
      setShowCreateForm(false);
    } catch (error) {
      console.error("Failed to create API key:", error);
      toast.error("Failed to create API key");
    }
  };

  const handleRevokeKey = async (id) => {
    try {
      await apiClient.delete(`/api/v1/keys/${id}`);
      setApiKeys(prev => prev.filter(key => key.id !== id));
      toast.success("API key revoked");
    } catch (error) {
      console.error("Failed to revoke API key:", error);
      toast.error("Failed to revoke API key");
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">API Keys</h1>
        <button
          className="btn btn-primary"
          onClick={() => {
            setShowCreateForm(true);
            // Pre-mint the token in the background so the final click never
            // waits on it.
            prepare("api_key_create").catch(() => {});
          }}
        >
          Create New Key
        </button>
      </div>

      {showCreateForm && (
        <div className="card bg-base-100 shadow-xl mb-6">
          <div className="card-body">
            <h2 className="card-title">Create New API Key</h2>
            <form onSubmit={handleCreateKey}>
              <div className="form-control mb-4">
                <label className="label">
                  <span className="label-text">Key Name (Optional)</span>
                </label>
                <input
                  type="text"
                  placeholder="Enter a name for this key"
                  className="input input-bordered"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="btn btn-primary"
                >
                  Create Key
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowCreateForm(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-8">
          <span className="loading loading-spinner loading-lg"></span>
        </div>
      ) : (
        <div className="bg-base-100 rounded-xl shadow-lg overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key Prefix</th>
                <th>Created</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {apiKeys.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-8">
                    No API keys created yet.
                  </td>
                </tr>
              ) : (
                apiKeys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.description || "Unnamed Key"}</td>
                    <td>
                      <span className="font-mono">{key.key_prefix}...</span>
                    </td>
                    <td>{new Date(key.created_at).toLocaleString()}</td>
                    <td>
                      {key.revoked_at ? (
                        <span className="badge badge-error">Revoked</span>
                      ) : (
                        <span className="badge badge-success">Active</span>
                      )}
                    </td>
                    <td>
                      {key.revoked_at ? null : (
                        <button
                          className="btn btn-sm btn-error"
                          onClick={() => handleRevokeKey(key.id)}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {newRawKey && (
        <div className="card bg-warning/10 border border-warning mb-6">
          <div className="card-body">
            <h2 className="card-title text-warning">Save your API key now</h2>
            <p className="text-sm">
              This is the only time the full key is shown. Store it somewhere
              safe — you will not be able to see it again.
            </p>
            <div className="flex items-center gap-2 mt-2">
              <code className="font-mono text-sm bg-base-200 p-2 rounded break-all flex-1">
                {newRawKey}
              </code>
              <button
                className="btn btn-sm btn-outline"
                onClick={() => copyToClipboard(newRawKey)}
              >
                {copiedKey ? "Copied!" : "Copy"}
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => setNewRawKey(null)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {copiedKey && (
        <div className="fixed bottom-4 right-4 bg-green-500 text-white p-4 rounded-lg shadow-lg">
          Copied to clipboard!
        </div>
      )}
    </div>
  );
}