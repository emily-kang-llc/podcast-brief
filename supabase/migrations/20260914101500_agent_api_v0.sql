-- Migration: agent_api_v0
-- Created at: 2026-09-14 10:15:00

-- Create api_keys table with relevant fields
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- We'll reuse profile_id from profiles table
    profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    -- Key hash (SHA-256 of raw key)
    key_hash TEXT NOT NULL,
    -- Display prefix first 8 chars for display
    key_prefix TEXT NOT NULL,
    -- Descriptive name for the key
    description TEXT,
    -- Environment the key is scoped to (e.g., "development", "production")
    environment TEXT NOT NULL DEFAULT 'development',
    -- Scopes for this key
    scopes TEXT[] NOT NULL DEFAULT ARRAY['briefs:read', 'briefs:write'],
    -- When the key was created
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- When the key was revoked (NULL if not revoked)
    revoked_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    
    -- Indexes for common queries
    INDEX revoked_at_index (revoked_at),
    INDEX profile_id_index (profile_id),
    INDEX environment_index (environment)
);

-- Create RLS policy so users can only see their own keys
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own API keys" ON api_keys
    FOR ALL TO public
    USING (profile_id = (SELECT id FROM profiles WHERE auth.uid() = id));

-- Add column to briefs table for tracking api_key_id (optional field)
ALTER TABLE briefs
    ADD COLUMN api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;

-- Reorder migration to reflect proper timestamp order
-- This migration happens after 20260408000000_stripe_credits.sql
-- and has no dependencies on later migrations in the sequence.

-- The agent API follows the existing pattern:
-- - Uses existing profile_id and environment dedup logic  
-- - Does not add a new envelope for adding metadata columns (e.g. callback_url, outcome)
-- - Does not make the issue broader with refund, webhook, or idempotency features
-- - Only adds key management rules and api_key_id reference in briefs

-- Service role can still access and mutate all keys
CREATE POLICY "Service role can manage keys" ON api_keys
    FOR ALL TO service_role
    USING (TRUE);

-- Allow private key hash insertion with service role only
-- (This is used by admin endpoints to safely store the hash)
CREATE POLICY "Service role can insert API key hashes" ON api_keys
    FOR INSERT TO service_role
    WITH CHECK (TRUE);

COMMIT;