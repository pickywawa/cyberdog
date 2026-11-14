begin;
create function pg_temp.fails(sql text,e text) returns void language plpgsql as $$begin
 execute sql;raise exception 'TEST FAILED: allowed %',sql;
 exception when others then if sqlerrm<>e then raise exception 'TEST FAILED: expected %, got %',e,sqlerrm;end if;
end $$;
do $$begin if public.cyberdog_mfa_is_verified('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001') then raise exception 'unverified session accepted';end if;end $$;
select pg_temp.fails($q$select public.cyberdog_mfa_attempt('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001')$q$,'otp_expired');
select public.cyberdog_mfa_begin('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001');
select pg_temp.fails($q$select public.cyberdog_mfa_begin('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001')$q$,'rate_limited');
-- A challenge belongs to one user and one session.
select pg_temp.fails($q$select public.cyberdog_mfa_attempt('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000002')$q$,'otp_expired');
select pg_temp.fails($q$select public.cyberdog_mfa_attempt('00000000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-000000000001')$q$,'otp_expired');
do $$begin for i in 1..5 loop perform public.cyberdog_mfa_attempt('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001');end loop;end $$;
select pg_temp.fails($q$select public.cyberdog_mfa_attempt('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001')$q$,'otp_expired');
update cyberdog_private.login_challenges set sent_at=now()-interval '1 minute';
select public.cyberdog_mfa_begin('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001');
update cyberdog_private.login_challenges set expires_at=now()-interval '1 second';
select pg_temp.fails($q$select public.cyberdog_mfa_attempt('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001')$q$,'otp_expired');
select public.cyberdog_mfa_complete('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001');
do $$begin
 if not public.cyberdog_mfa_is_verified('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001') then raise exception 'verified session rejected';end if;
 if public.cyberdog_mfa_is_verified('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000002') then raise exception 'verification leaked to another user';end if;
 if public.cyberdog_mfa_is_verified('00000000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-000000000001') then raise exception 'verification leaked to another session';end if;
end $$;
select public.cyberdog_mfa_prune();
do $$begin if public.cyberdog_mfa_is_verified('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001') then raise exception 'orphan session still verified';end if;end $$;
set local role authenticated;
do $$begin
 begin perform public.cyberdog_mfa_complete('00000000-0000-4000-8000-0000000000a9','00000000-0000-4000-8000-000000000001');raise exception 'client could self-verify';exception when insufficient_privilege then null;end;
end $$;
rollback;
