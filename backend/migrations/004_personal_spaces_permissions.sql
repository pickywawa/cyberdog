begin;
alter table cyberdog_private.teams add column is_personal boolean not null default false;
create unique index one_personal_space on cyberdog_private.teams(owner_id) where is_personal;
alter table cyberdog_private.members add column can_edit_servers boolean not null default false;
update cyberdog_private.members set can_edit_servers=true where role in ('owner','admin');
create or replace function public.cyberdog_account(action text default 'status', payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); v_email text; tid uuid; own uuid; actor_role text; target uuid; target_role text; result jsonb; sid uuid; inv record; can_write boolean; source_tid uuid; source_role text; source_write boolean; personal boolean;
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
  insert into cyberdog_private.teams(name,owner_id,is_personal) values('Personal',uid,true) on conflict(owner_id) where is_personal do nothing;
  insert into cyberdog_private.members(team_id,user_id,role,can_edit_servers) select id,uid,'owner',true from cyberdog_private.teams where owner_id=uid and is_personal on conflict do nothing;
  select jsonb_build_object('personalSpaceId',(select id from cyberdog_private.teams where owner_id=uid and is_personal),'teams',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'role',m.role,'canEditServers',(m.role='owner' or m.can_edit_servers))) from cyberdog_private.teams t join cyberdog_private.members m on m.team_id=t.id where m.user_id=uid and not t.is_personal),'[]'::jsonb),
   'servers',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'teamId',s.team_id,'name',s.name,'host',s.host,'port',s.port,'user',s.username,'canEditServers',(m.role='owner' or m.can_edit_servers),'personal',t.is_personal)) from cyberdog_private.servers s join cyberdog_private.teams t on t.id=s.team_id join cyberdog_private.members m on m.team_id=t.id where m.user_id=uid and (not t.is_personal or t.owner_id=uid)),'[]'::jsonb),
   'invitations',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'name',t.name,'expiresAt',i.expires_at)) from cyberdog_private.invites i join cyberdog_private.teams t on t.id=i.team_id where i.recipient_id=uid and i.expires_at>now() and not t.is_personal),'[]'::jsonb)) into result;
  return result;
 end if;
 if action='create_team' then
  if length(trim(payload->>'name')) not between 1 and 80 or payload->>'name' is null then raise exception 'invalid_name'; end if;
  if (select count(*) from cyberdog_private.teams where owner_id=uid and not is_personal)>=20 then raise exception 'team_limit'; end if;
  insert into cyberdog_private.teams(name,owner_id) values(trim(payload->>'name'),uid) returning id into tid;
  insert into cyberdog_private.members(team_id,user_id,role,can_edit_servers) values(tid,uid,'owner',true);
 elsif action='accept_invite' then
  select * into inv from cyberdog_private.invites where id=(payload->>'id')::uuid and recipient_id=uid and expires_at>now() for update;
  if not found then raise exception 'invitation_unavailable'; end if;
  tid:=inv.team_id;
  select owner_id into own from cyberdog_private.teams where id=tid and not is_personal for update;
  if own is null then raise exception 'access_denied'; end if;
  insert into cyberdog_private.members(team_id,user_id,role,can_edit_servers) values(tid,uid,'member',false) on conflict do nothing;
  delete from cyberdog_private.invites where id=inv.id;
 else
  tid:=(payload->>'teamId')::uuid;
  select owner_id,is_personal into own,personal from cyberdog_private.teams where id=tid for update;
  select role,(role='owner' or can_edit_servers) into actor_role,can_write from cyberdog_private.members where team_id=tid and user_id=uid;
  if own is null or actor_role is null then raise exception 'access_denied'; end if;
  if personal and (own<>uid or action not in ('server_get','server_save','server_delete')) then raise exception 'access_denied'; end if;
  if action='details' then
   return jsonb_build_object('members',(select jsonb_agg(jsonb_build_object('id',m.user_id,'email',u.email,'role',m.role,'canEditServers',(m.role='owner' or m.can_edit_servers),'premium',cyberdog_private.premium(m.user_id))) from cyberdog_private.members m join cyberdog_private.license_identities u on u.user_id=m.user_id where m.team_id=tid),
    'invitations',case when actor_role in ('owner','admin') then coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'recipientId',i.recipient_id,'email',i.email,'expiresAt',i.expires_at)) from cyberdog_private.invites i where i.team_id=tid),'[]'::jsonb) else '[]'::jsonb end);
  elsif action='server_get' then
   select jsonb_build_object('id',s.id,'teamId',s.team_id,'name',s.name,'host',s.host,'port',s.port,'user',s.username) into result from cyberdog_private.servers s where s.team_id=tid and s.id=(payload->>'id')::uuid;
   if result is null then raise exception 'access_denied'; end if; return result;
  elsif action='leave_team' then
   if actor_role='owner' then raise exception 'transfer_ownership_first'; end if;
   delete from cyberdog_private.members where team_id=tid and user_id=uid;
  else
   if action in ('server_save','server_delete') then
    if not can_write then raise exception 'server_write_required'; end if;
   elsif actor_role not in ('owner','admin') then raise exception 'admin_required'; end if;
   if action='set_server_permission' then
    if actor_role<>'owner' then raise exception 'owner_required'; end if;
    if jsonb_typeof(payload->'canEditServers') is distinct from 'boolean' then raise exception 'invalid_permission'; end if;
    update cyberdog_private.members set can_edit_servers=(payload->>'canEditServers')::boolean where team_id=tid and user_id=(payload->>'userId')::uuid and role<>'owner';
    if not found then raise exception 'access_denied'; end if;
   elsif action='invite' then
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
      update cyberdog_private.members set role='admin',can_edit_servers=true where team_id=tid and user_id=uid;
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
     select team_id into source_tid from cyberdog_private.servers where id=(payload->>'id')::uuid for update;
     if source_tid is null then raise exception 'access_denied'; end if;
     if source_tid<>tid then
      perform 1 from cyberdog_private.teams where id=source_tid for update;
      select m.role,(m.role='owner' or m.can_edit_servers) into source_role,source_write from cyberdog_private.members m join cyberdog_private.teams t on t.id=m.team_id where m.team_id=source_tid and m.user_id=uid and (not t.is_personal or t.owner_id=uid);
      if source_role is null or not source_write then raise exception 'access_denied'; end if;
     end if;
     update cyberdog_private.servers set team_id=tid,name=trim(payload->>'name'),host=trim(payload->>'host'),port=(payload->>'port')::int,username=trim(payload->>'user'),updated_at=now() where id=(payload->>'id')::uuid and team_id=source_tid;
     if not found then raise exception 'access_denied'; end if;
    end if;
   elsif action='server_delete' then delete from cyberdog_private.servers where id=(payload->>'id')::uuid and team_id=tid;
   else raise exception 'unknown_action'; end if;
  end if;
 end if;
 insert into cyberdog_private.audit(actor,team_id,action) values(uid,tid,action);
 return jsonb_build_object('ok',true,'teamId',tid,'serverId',sid);
end $$;

commit;
