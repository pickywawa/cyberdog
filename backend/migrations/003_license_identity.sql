begin;
create table cyberdog_private.license_identities (
 license_id text primary key check(license_id ~ '^[0-9]+$'),
 user_id uuid unique not null default gen_random_uuid(),
 email text not null,
 test_mode boolean not null,
 active boolean not null,
 blocked boolean not null default false,
 expires_at timestamptz,
 checked_at timestamptz not null default now()
);
alter table cyberdog_private.license_identities enable row level security;
alter table cyberdog_private.teams drop constraint teams_owner_id_fkey;
alter table cyberdog_private.members drop constraint members_user_id_fkey;
-- Preserve legacy rows without making email-based accounts usable as licensed identities.
alter table cyberdog_private.teams add constraint teams_licensed_owner_fkey foreign key(owner_id) references cyberdog_private.license_identities(user_id) not valid;
alter table cyberdog_private.members add constraint members_licensed_user_fkey foreign key(user_id) references cyberdog_private.license_identities(user_id) not valid;
revoke all on cyberdog_private.license_identities from public,anon,authenticated;
alter table cyberdog_private.invites add column recipient_id uuid references cyberdog_private.license_identities(user_id);
create index invites_recipient_id on cyberdog_private.invites(recipient_id);
-- Old email invitations remain in storage but cannot enroll a licensed identity.
create or replace function cyberdog_private.premium(uid uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from cyberdog_private.license_identities l,cyberdog_private.settings s where l.user_id=uid and l.active and not l.blocked and l.test_mode=s.test_mode and (l.expires_at is null or l.expires_at>now()))
$$;
create or replace function public.cyberdog_account(action text default 'status', payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); v_email text; tid uuid; own uuid; actor_role text; target uuid; target_role text; result jsonb; sid uuid; inv record;
begin
 if uid is null then raise exception 'authentication_required'; end if;
 select l.email into v_email from cyberdog_private.license_identities l where l.user_id=uid;
 if v_email is null then raise exception 'license_required'; end if;
 if not cyberdog_private.premium(uid) then raise exception 'premium_required'; end if;
 if action='status' then
  return jsonb_build_object('email',v_email,'userId',uid,'premium',cyberdog_private.premium(uid),'testMode',(select s.test_mode from cyberdog_private.settings s));
 end if;
 if not cyberdog_private.premium(uid) then raise exception 'premium_required'; end if;
 if action='list' then
  select jsonb_build_object('teams',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'role',m.role)) from cyberdog_private.teams t join cyberdog_private.members m on m.team_id=t.id where m.user_id=uid),'[]'::jsonb),
   'servers',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'teamId',s.team_id,'name',s.name,'host',s.host,'port',s.port,'user',s.username)) from cyberdog_private.servers s join cyberdog_private.teams t on t.id=s.team_id join cyberdog_private.members m on m.team_id=t.id where m.user_id=uid),'[]'::jsonb),
   'invitations',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'name',t.name,'expiresAt',i.expires_at)) from cyberdog_private.invites i join cyberdog_private.teams t on t.id=i.team_id where i.recipient_id=uid and i.expires_at>now()),'[]'::jsonb)) into result;
  return result;
 end if;
 if action='create_team' then
  if length(trim(payload->>'name')) not between 1 and 80 or payload->>'name' is null then raise exception 'invalid_name'; end if;
  if (select count(*) from cyberdog_private.teams where owner_id=uid)>=20 then raise exception 'team_limit'; end if;
  insert into cyberdog_private.teams(name,owner_id) values(trim(payload->>'name'),uid) returning id into tid;
  insert into cyberdog_private.members values(tid,uid,'owner');
 elsif action='accept_invite' then
  select * into inv from cyberdog_private.invites where id=(payload->>'id')::uuid and recipient_id=uid and expires_at>now() for update;
  if not found then raise exception 'invitation_unavailable'; end if;
  tid:=inv.team_id;
  select owner_id into own from cyberdog_private.teams where id=tid for update;
  insert into cyberdog_private.members values(tid,uid,'member') on conflict do nothing;
  delete from cyberdog_private.invites where id=inv.id;
 else
  tid:=(payload->>'teamId')::uuid;
  select owner_id into own from cyberdog_private.teams where id=tid for update;
  select role into actor_role from cyberdog_private.members where team_id=tid and user_id=uid;
  if own is null or actor_role is null then raise exception 'access_denied'; end if;
  if action='details' then
   return jsonb_build_object('members',(select jsonb_agg(jsonb_build_object('id',m.user_id,'email',u.email,'role',m.role,'premium',cyberdog_private.premium(m.user_id))) from cyberdog_private.members m join cyberdog_private.license_identities u on u.user_id=m.user_id where m.team_id=tid),
    'invitations',case when actor_role in ('owner','admin') then coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'recipientId',i.recipient_id,'email',i.email,'expiresAt',i.expires_at)) from cyberdog_private.invites i where i.team_id=tid),'[]'::jsonb) else '[]'::jsonb end);
  elsif action='server_get' then
   select jsonb_build_object('id',s.id,'teamId',s.team_id,'name',s.name,'host',s.host,'port',s.port,'user',s.username) into result from cyberdog_private.servers s where s.team_id=tid and s.id=(payload->>'id')::uuid;
   if result is null then raise exception 'access_denied'; end if; return result;
  elsif action='leave_team' then
   if actor_role='owner' then raise exception 'transfer_ownership_first'; end if;
   delete from cyberdog_private.members where team_id=tid and user_id=uid;
  else
   if actor_role not in ('owner','admin') then raise exception 'admin_required'; end if;
   if action='invite' then
    target:=(payload->>'recipientId')::uuid;
    if not exists(select 1 from cyberdog_private.license_identities where user_id=target) then raise exception 'invalid_recipient'; end if;
    if target=uid or exists(select 1 from cyberdog_private.members where team_id=tid and user_id=target) then raise exception 'already_member'; end if;
    if (select count(*) from cyberdog_private.invites where team_id=tid)>=100 then raise exception 'invite_limit'; end if;
    insert into cyberdog_private.invites(team_id,email,recipient_id) values(tid,target::text,target) on conflict(team_id,email) do update set recipient_id=target,expires_at=now()+interval '7 days';
   elsif action='revoke_invite' then delete from cyberdog_private.invites where id=(payload->>'id')::uuid and team_id=tid;
   elsif action in ('remove_member','set_role','transfer_owner') then
    target:=(payload->>'userId')::uuid;
    select role into target_role from cyberdog_private.members where team_id=tid and user_id=target;
    if target_role is null or target_role='owner' or (actor_role<>'owner' and target_role<>'member') then raise exception 'access_denied'; end if;
    if action='remove_member' then delete from cyberdog_private.members where team_id=tid and user_id=target;
    else
     if actor_role<>'owner' then raise exception 'owner_required'; end if;
     if action='set_role' then
      if coalesce(payload->>'role','') not in ('admin','member') then raise exception 'invalid_role'; end if;
      update cyberdog_private.members set role=payload->>'role' where team_id=tid and user_id=target;
     else
      if not cyberdog_private.premium(target) then raise exception 'premium_required'; end if;
      update cyberdog_private.members set role='admin' where team_id=tid and user_id=uid;
      update cyberdog_private.members set role='owner' where team_id=tid and user_id=target;
      update cyberdog_private.teams set owner_id=target where id=tid;
     end if;
    end if;
   elsif action='rename_team' then
    if length(trim(payload->>'name')) not between 1 and 80 or payload->>'name' is null then raise exception 'invalid_name'; end if;
    update cyberdog_private.teams set name=trim(payload->>'name') where id=tid;
   elsif action='delete_team' then
    if actor_role<>'owner' then raise exception 'owner_required'; end if;
    delete from cyberdog_private.teams where id=tid;
   elsif action='server_save' then
    if payload ?| array['pass','password','key','privateKey','secret'] then raise exception 'secrets_forbidden'; end if;
    if coalesce(length(trim(payload->>'host')),0) not between 1 and 255 or coalesce(length(trim(payload->>'user')),0) not between 1 and 128 or coalesce(length(trim(payload->>'name')),0) not between 1 and 120 then raise exception 'invalid_server'; end if;
    if payload->>'id' is null then
     insert into cyberdog_private.servers(team_id,name,host,port,username) values(tid,trim(payload->>'name'),trim(payload->>'host'),(payload->>'port')::int,trim(payload->>'user')) returning id into sid;
    else
     update cyberdog_private.servers set name=trim(payload->>'name'),host=trim(payload->>'host'),port=(payload->>'port')::int,username=trim(payload->>'user'),updated_at=now() where id=(payload->>'id')::uuid and team_id=tid;
     if not found then raise exception 'access_denied'; end if;
    end if;
   elsif action='server_delete' then delete from cyberdog_private.servers where id=(payload->>'id')::uuid and team_id=tid;
   else raise exception 'unknown_action'; end if;
  end if;
 end if;
 insert into cyberdog_private.audit(actor,team_id,action) values(uid,tid,action);
 return jsonb_build_object('ok',true,'teamId',tid,'serverId',sid);
end $$;

revoke all on function public.cyberdog_account(text,jsonb) from public,anon,authenticated;
grant execute on function public.cyberdog_account(text,jsonb) to service_role;
-- Only the server holding the service key can bind a verified Lemon Squeezy license.
create function public.cyberdog_bind_license(license_id text, email text, test_mode boolean, expires_at timestamptz default null) returns uuid language plpgsql security definer set search_path='' as $$
declare identity_id uuid;
begin
 insert into cyberdog_private.license_identities(license_id,email,test_mode,active,expires_at)
 values(license_id,lower(email),test_mode,true,expires_at)
 on conflict on constraint license_identities_pkey do update set email=excluded.email,test_mode=excluded.test_mode,active=true,expires_at=excluded.expires_at,checked_at=now()
 returning license_identities.user_id into identity_id;
 return identity_id;
end $$;
revoke all on function public.cyberdog_bind_license(text,text,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.cyberdog_bind_license(text,text,boolean,timestamptz) to service_role;
create function public.cyberdog_licensed_action(license_id text, action text, payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid;
begin
 select l.user_id into uid from cyberdog_private.license_identities l where l.license_id=cyberdog_licensed_action.license_id and l.checked_at>now()-interval '60 seconds';
 if uid is null or not cyberdog_private.premium(uid) then raise exception 'premium_required'; end if;
 perform set_config('request.jwt.claim.sub',uid::text,true);
 return public.cyberdog_account(action,payload);
end $$;
revoke all on function public.cyberdog_licensed_action(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.cyberdog_licensed_action(text,text,jsonb) to service_role;
create function public.cyberdog_revoke_license(license_id text) returns void language sql security definer set search_path='' as $$
 update cyberdog_private.license_identities set active=false where license_id=cyberdog_revoke_license.license_id
$$;
revoke all on function public.cyberdog_revoke_license(text) from public,anon,authenticated;
grant execute on function public.cyberdog_revoke_license(text) to service_role;
commit;
