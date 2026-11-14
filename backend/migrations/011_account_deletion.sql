-- In-app account deletion (App Store guideline 5.1.1(v)).
-- The gateway calls this with the verified Auth user id, then deletes the Auth user itself.
begin;
create function public.cyberdog_delete_account(uid uuid) returns void language plpgsql security definer set search_path='' as $$
declare mail text;
begin
 if uid is null then raise exception 'auth_required'; end if;
 -- A shared team must not disappear for its other members: its owner transfers it or deletes it first.
 if exists(select 1 from cyberdog_private.teams t where t.owner_id=uid and not t.is_personal
   and exists(select 1 from cyberdog_private.members m where m.team_id=t.id and m.user_id<>uid)) then
  raise exception 'transfer_ownership_first';
 end if;
 select l.email into mail from cyberdog_private.license_identities l where l.user_id=uid limit 1;
 -- Owned teams (personal space and teams without other members) cascade to their servers,
 -- credentials, groups, actions, revisions, invitations and links.
 delete from cyberdog_private.teams where owner_id=uid;
 delete from cyberdog_private.members where user_id=uid;
 delete from cyberdog_private.invites where recipient_id=uid or (mail is not null and lower(email)=mail);
 delete from cyberdog_private.invite_links where created_by=uid;
 update cyberdog_private.server_revisions set actor_id=null,actor_email=null where actor_id=uid;
 update cyberdog_private.audit set actor=null where actor=uid;
 delete from cyberdog_private.login_challenges where user_id=uid;
 delete from cyberdog_private.verified_sessions where user_id=uid;
 delete from cyberdog_private.purchases where user_id=uid;
 delete from cyberdog_private.license_identities where user_id=uid;
end $$;
revoke all on function public.cyberdog_delete_account(uuid) from public,anon,authenticated;
grant execute on function public.cyberdog_delete_account(uuid) to service_role;
commit;
