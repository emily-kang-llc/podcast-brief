-- Agent-first API (v1): API keys, machine-readable brief outcomes, completion
-- webhooks, and automatic refunds for failed briefs.
--
-- Everything here is additive. Existing rows get outcome = NULL, which the
-- serializer reads as "pre-API brief: derive from output_markdown", so the
-- dashboard and older briefs keep working unchanged.
-- ── briefs: outcome, provenance, webhook state ───────────────────────────────
alter table public.briefs
  add column if not exists outcome text,
  add column if not exists error_code text,
  add column if not exists error_message text,
  add column if not exists api_key_id uuid,
  add column if not exists idempotency_key text,
  add column if not exists callback_url text,
  add column if not exists refunded_at timestamptz,
  add column if not exists credits_refunded integer,
  add column if not exists webhook_attempts integer not null default 0,
  add column if not exists webhook_last_status integer,
  add column if not exists webhook_last_attempt_at timestamptz,
  add column if not exists webhook_delivered_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'briefs_outcome_check') then
    alter table public.briefs
      add constraint briefs_outcome_check
      check (outcome is null or outcome in ('succeeded', 'partial', 'failed'));
  end if;
end
$$;
-- One Idempotency-Key per caller per environment. Partial index, so the web app
-- (which never sends one) is unaffected.
create unique index if not exists briefs_idempotency_key_idx
  on public.briefs (profile_id, environment, idempotency_key)
  where idempotency_key is not null;
-- The worker's webhook retry loop scans this.
create index if not exists briefs_pending_webhook_idx
  on public.briefs (environment, completed_at)
  where callback_url is not null and webhook_delivered_at is null;
-- ── api_keys ─────────────────────────────────────────────────────────────────
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  name text not null default 'default',
  -- First 12 chars of the raw key, for display ("pb_live_3f9a…"). Not secret.
  key_prefix text not null,
  -- SHA-256 of the raw key. The raw key is never stored.
  key_hash text not null unique,
  scopes text[] not null default array['briefs:read', 'briefs:write'],
  -- NULL = unlimited. Enforced in the API layer against briefs.credits_charged
  -- for the current UTC month.
  monthly_credit_cap integer check (monthly_credit_cap is null or monthly_credit_cap >= 0),
  -- Default completion webhook for briefs created with this key.
  callback_url text,
  -- HMAC secret for X-PodcastBrief-Signature. Returned once at creation.
  callback_secret text,
  -- Keys are environment-scoped: a STAGING key cannot spend PRODUCTION credits.
  environment text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists api_keys_profile_id_idx on public.api_keys (profile_id);
alter table public.api_keys enable row level security;
drop policy if exists "read_own_api_keys" on public.api_keys;
create policy "read_own_api_keys"
  on public.api_keys for select to authenticated
  using (auth.uid() = profile_id);
-- No insert/update/delete policies on purpose: keys are minted and revoked only
-- through the API routes, which use the service-role client.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'briefs_api_key_id_fkey') then
    alter table public.briefs
      add constraint briefs_api_key_id_fkey
      foreign key (api_key_id) references public.api_keys (id) on delete set null;
  end if;
end
$$;
create index if not exists briefs_api_key_id_idx
  on public.briefs (api_key_id, created_at)
  where api_key_id is not null;
-- ── refund_brief_credits ─────────────────────────────────────────────────────
-- Atomic, idempotent refund of a brief's charge. Locks the brief row, so two
-- concurrent calls cannot double-refund. Service-role only, like the other
-- credit RPCs.
create or replace function public.refund_brief_credits(
  p_brief_id uuid,
  p_reason text default 'refund:brief_failure'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brief record;
  v_credits_left integer;
begin
  select id, profile_id, credits_charged, refunded_at, environment
    into v_brief
    from public.briefs
   where id = p_brief_id
   for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_brief.refunded_at is not null then
    return jsonb_build_object('error', 'already_refunded', 'credits_refunded', 0);
  end if;
  if coalesce(v_brief.credits_charged, 0) = 0 then
    update public.briefs set refunded_at = now(), credits_refunded = 0 where id = p_brief_id;
    return jsonb_build_object('credits_refunded', 0);
  end if;
  update public.profiles
     set credits = credits + v_brief.credits_charged
   where id = v_brief.profile_id
   returning credits into v_credits_left;
  insert into public.credit_ledger (profile_id, delta_credits, credits_left, reason, environment)
  values (v_brief.profile_id, v_brief.credits_charged, v_credits_left, p_reason, v_brief.environment);
  update public.briefs
     set refunded_at = now(), credits_refunded = v_brief.credits_charged
   where id = p_brief_id;
  return jsonb_build_object(
    'credits_refunded', v_brief.credits_charged,
    'credits_remaining', v_credits_left
  );
end;
$$;
revoke execute on function public.refund_brief_credits(uuid, text) from public, anon, authenticated;
grant execute on function public.refund_brief_credits(uuid, text) to service_role;