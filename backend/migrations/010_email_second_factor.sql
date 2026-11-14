-- E-mail code as second sign-in factor, enforced by the gateway.
-- A Supabase session (identified by the verified JWT claim session_id) is only usable once its id is in
-- verified_sessions. The code itself is generated, e-mailed and checked by Supabase Auth (OTP); this schema
-- only records throttling, attempt limits and which sessions passed. Nothing here is reachable by clients.
begin;
create table cyberdog_private.verified_sessions (
 session_id uuid primary key,
 user_id uuid not null,
 verified_at timestamptz not null default now()
);
create table cyberdog_private.login_challenges (
 session_id uuid primary key,
 user_id uuid not null,
 sent_at timestamptz not null default now(),
 expires_at timestamptz not null,
 attempts integer not null default 0
);
alter table cyberdog_private.verified_sessions enable row level security;
alter table cyberdog_private.login_challenges enable row level security;
revoke all on cyberdog_private.verified_sessions from public,anon,authenticated;
revoke all on cyberdog_private.login_challenges from public,anon,authenticated;

create function public.cyberdog_mfa_is_verified(sid uuid, uid uuid) returns boolean language sql security definer set search_path='' stable as $$
 select exists(select 1 from cyberdog_private.verified_sessions v where v.session_id=sid and v.user_id=uid and v.verified_at>now()-interval '90 days');
$$;

-- Starts (or restarts) a challenge. At most one code per 45 seconds per session.
create function public.cyberdog_mfa_begin(sid uuid, uid uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 delete from cyberdog_private.verified_sessions where verified_at<=now()-interval '90 days';
 delete from cyberdog_private.login_challenges where expires_at<now()-interval '1 day';
 if exists(select 1 from cyberdog_private.login_challenges c where c.session_id=sid and c.sent_at>now()-interval '45 seconds') then raise exception 'rate_limited'; end if;
 insert into cyberdog_private.login_challenges(session_id,user_id,sent_at,expires_at,attempts) values(sid,uid,now(),now()+interval '10 minutes',0)
 on conflict (session_id) do update set user_id=excluded.user_id,sent_at=excluded.sent_at,expires_at=excluded.expires_at,attempts=0;
end $$;

-- Counts one guess before the code is checked, so a failed guess can never be retried for free.
create function public.cyberdog_mfa_attempt(sid uuid, uid uuid) returns void language plpgsql security definer set search_path='' as $$
declare c cyberdog_private.login_challenges;
begin
 select * into c from cyberdog_private.login_challenges where session_id=sid and user_id=uid for update;
 if not found then raise exception 'otp_expired'; end if;
 if c.expires_at<now() then delete from cyberdog_private.login_challenges where session_id=sid; raise exception 'otp_expired'; end if;
 if c.attempts>=5 then raise exception 'otp_expired'; end if;
 update cyberdog_private.login_challenges set attempts=attempts+1 where session_id=sid;
end $$;

create function public.cyberdog_mfa_complete(sid uuid, uid uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 insert into cyberdog_private.verified_sessions(session_id,user_id) values(sid,uid) on conflict (session_id) do update set user_id=excluded.user_id,verified_at=now();
 delete from cyberdog_private.login_challenges where session_id=sid;
end $$;

-- Sessions that no longer exist in Supabase Auth (signed out, revoked) lose their verification.
create function public.cyberdog_mfa_prune() returns void language sql security definer set search_path='' as $$
 delete from cyberdog_private.verified_sessions v where not exists(select 1 from auth.sessions s where s.id=v.session_id);
$$;

revoke all on function public.cyberdog_mfa_is_verified(uuid,uuid) from public,anon,authenticated;
revoke all on function public.cyberdog_mfa_begin(uuid,uuid) from public,anon,authenticated;
revoke all on function public.cyberdog_mfa_attempt(uuid,uuid) from public,anon,authenticated;
revoke all on function public.cyberdog_mfa_complete(uuid,uuid) from public,anon,authenticated;
revoke all on function public.cyberdog_mfa_prune() from public,anon,authenticated;
grant execute on function public.cyberdog_mfa_is_verified(uuid,uuid) to service_role;
grant execute on function public.cyberdog_mfa_begin(uuid,uuid) to service_role;
grant execute on function public.cyberdog_mfa_attempt(uuid,uuid) to service_role;
grant execute on function public.cyberdog_mfa_complete(uuid,uuid) to service_role;
grant execute on function public.cyberdog_mfa_prune() to service_role;
commit;
