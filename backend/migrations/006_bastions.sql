begin;
alter table cyberdog_private.servers add column bastion_id uuid references cyberdog_private.servers(id) on delete restrict;
create index servers_bastion on cyberdog_private.servers(bastion_id) where bastion_id is not null;
create function cyberdog_private.route_id(value jsonb) returns uuid language plpgsql immutable set search_path='' as $$
begin
 if value is null or value='null'::jsonb then return null;end if;
 if jsonb_typeof(value)<>'object' or value->>'version' is distinct from '1' or jsonb_typeof(value->'version') is distinct from 'number' then raise exception 'bastion.invalid_route';end if;
 if value->>'mode'='direct' and value- 'version'-'mode'='{}'::jsonb then return null;end if;
 if value->>'mode' is distinct from 'bastion' or value- 'version'-'mode'-'bastionId'<>'{}'::jsonb or value->>'bastionId' is null then raise exception 'bastion.invalid_route';end if;
 begin return (value->>'bastionId')::uuid;exception when invalid_text_representation then raise exception 'bastion.invalid_route';end;
end $$;
revoke all on function cyberdog_private.route_id(jsonb) from public,anon,authenticated;
create function cyberdog_private.guard_bastion() returns trigger language plpgsql security definer set search_path='' as $$
declare b cyberdog_private.servers;
begin
 perform pg_advisory_xact_lock(792064116::bigint);
 if TG_OP='DELETE' then
  if not exists(select 1 from cyberdog_private.teams where id=old.team_id) then return old;end if;
  if exists(select 1 from cyberdog_private.servers where bastion_id=old.id) then raise exception 'bastion.in_use';end if;return old;
 end if;
 if exists(select 1 from cyberdog_private.servers s where s.bastion_id=new.id and (new.bastion_id is not null or s.team_id<>new.team_id)) then raise exception 'bastion.in_use';end if;
 if new.bastion_id is not null then
  select * into b from cyberdog_private.servers where id=new.bastion_id;
  if not found or b.id=new.id then raise exception 'bastion.missing';end if;
  if b.team_id<>new.team_id then raise exception 'bastion.scope';end if;
  if b.bastion_id is not null then raise exception 'bastion.chain';end if;
 end if;
 return new;
end $$;
revoke all on function cyberdog_private.guard_bastion() from public,anon,authenticated;
create trigger validate_bastion before insert or update or delete on cyberdog_private.servers for each row execute function cyberdog_private.guard_bastion();
create or replace function cyberdog_private.snapshot_server() returns trigger language plpgsql security definer set search_path='' as $$
declare r cyberdog_private.servers; op text; actor uuid:=auth.uid();
begin
 op:=nullif(current_setting('cyberdog.history_operation',true),'');
 if TG_OP='UPDATE' and row(new.name,new.host,new.port,new.username,new.team_id,new.group_id,new.bastion_id) is not distinct from row(old.name,old.host,old.port,old.username,old.team_id,old.group_id,old.bastion_id) and op is distinct from 'restore' then return new;end if;
 if TG_OP='DELETE' then r:=old;else r:=new;end if;
 if TG_OP='DELETE' and not exists(select 1 from cyberdog_private.teams where id=r.team_id) then return old;end if;
 op:=coalesce(op,case TG_OP when 'INSERT' then 'create' when 'DELETE' then 'delete' else case when old.team_id<>new.team_id then 'move' else 'update' end end);
 insert into cyberdog_private.server_revisions(server_id,team_id,operation,actor_id,actor_email,snapshot) values(r.id,r.team_id,op,actor,(select email from cyberdog_private.license_identities where user_id=actor),jsonb_build_object('name',r.name,'host',r.host,'port',r.port,'user',r.username,'group',r.group_id,'networkAccess',case when r.bastion_id is null then jsonb_build_object('version',1,'mode','direct') else jsonb_build_object('version',1,'mode','bastion','bastionId',r.bastion_id) end));
 if TG_OP='DELETE' then return old;end if;return new;
end $$;
create or replace function public.cyberdog_account(action text default 'status', payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); v_email text; tid uuid; own uuid; actor_role text; target uuid; target_role text; result jsonb; sid uuid; inv record; can_write boolean; source_tid uuid; source_role text; source_write boolean; personal boolean; asset record; ver record; restore_group uuid; route_target jsonb; route_bastion jsonb; route_bid uuid;
begin
 if uid is null then raise exception 'authentication_required'; end if;
 select l.email into v_email from cyberdog_private.license_identities l where l.user_id=uid;
 if v_email is null then raise exception 'license_required'; end if;
 if not cyberdog_private.premium(uid) then raise exception 'premium_required'; end if;
 if action='status' then
  return jsonb_build_object('email',v_email,'userId',uid,'premium',cyberdog_private.premium(uid),'testMode',(select s.test_mode from cyberdog_private.settings s));
 end if;
 if not cyberdog_private.premium(uid) then raise exception 'premium_required'; end if;
 if action='route_get' then
  route_target:=public.cyberdog_account('server_get',payload||jsonb_build_object('routeVersion',1));
  route_bid:=cyberdog_private.route_id(route_target->'networkAccess');
  if route_bid is null then raise exception 'bastion.missing';end if;
  route_bastion:=public.cyberdog_account('server_get',jsonb_build_object('teamId',route_target->>'teamId','id',route_bid,'routeVersion',1));
  if cyberdog_private.route_id(route_bastion->'networkAccess') is not null then raise exception 'bastion.chain';end if;
  return jsonb_build_object('target',route_target,'bastion',route_bastion);
 end if;
 if action='list' then
  insert into cyberdog_private.teams(name,owner_id,is_personal) values('Personal',uid,true) on conflict(owner_id) where is_personal do nothing;
  insert into cyberdog_private.members(team_id,user_id,role,can_edit_servers) select id,uid,'owner',true from cyberdog_private.teams where owner_id=uid and is_personal on conflict do nothing;
  select jsonb_build_object('personalSpaceId',(select id from cyberdog_private.teams where owner_id=uid and is_personal),'teams',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'role',m.role,'canEditServers',(m.role='owner' or m.can_edit_servers))) from cyberdog_private.teams t join cyberdog_private.members m on m.team_id=t.id where m.user_id=uid and not t.is_personal),'[]'::jsonb),
   'servers',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'teamId',s.team_id,'name',s.name,'host',s.host,'port',s.port,'user',s.username,'group',s.group_id,'networkAccess',case when s.bastion_id is null then jsonb_build_object('version',1,'mode','direct') else jsonb_build_object('version',1,'mode','bastion','bastionId',s.bastion_id) end,'canEditServers',(m.role='owner' or m.can_edit_servers),'personal',t.is_personal)) from cyberdog_private.servers s join cyberdog_private.teams t on t.id=s.team_id join cyberdog_private.members m on m.team_id=t.id where m.user_id=uid and (not t.is_personal or t.owner_id=uid)),'[]'::jsonb),
   'assets',coalesce((select jsonb_agg(a.body||jsonb_build_object('id',a.id,'teamId',a.team_id,'name',a.name,'kind',a.kind,'canEditServers',(m.role='owner' or m.can_edit_servers),'personal',t.is_personal)) from cyberdog_private.assets a join cyberdog_private.teams t on t.id=a.team_id join cyberdog_private.members m on m.team_id=t.id where m.user_id=uid and (not t.is_personal or t.owner_id=uid)),'[]'::jsonb),
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
  if personal and (own<>uid or action not in ('server_get','server_save','server_delete','asset_get','asset_save','asset_delete','history_list','history_restore')) then raise exception 'access_denied'; end if;
  if action='details' then
   return jsonb_build_object('members',(select jsonb_agg(jsonb_build_object('id',m.user_id,'email',u.email,'role',m.role,'canEditServers',(m.role='owner' or m.can_edit_servers),'premium',cyberdog_private.premium(m.user_id))) from cyberdog_private.members m join cyberdog_private.license_identities u on u.user_id=m.user_id where m.team_id=tid),
    'invitations',case when actor_role in ('owner','admin') then coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'recipientId',i.recipient_id,'email',i.email,'expiresAt',i.expires_at)) from cyberdog_private.invites i where i.team_id=tid),'[]'::jsonb) else '[]'::jsonb end);
  elsif action='server_get' then
   select jsonb_build_object('id',s.id,'teamId',s.team_id,'name',s.name,'host',s.host,'port',s.port,'user',s.username,'group',s.group_id,'networkAccess',case when s.bastion_id is null then jsonb_build_object('version',1,'mode','direct') else jsonb_build_object('version',1,'mode','bastion','bastionId',s.bastion_id) end) into result from cyberdog_private.servers s where s.team_id=tid and s.id=(payload->>'id')::uuid;
   if result is null then raise exception 'access_denied'; end if; if result->'networkAccess'->>'mode'='bastion' and payload->>'routeVersion' is distinct from '1' then raise exception 'bastion.route_unsupported';end if; return result;
  elsif action='asset_get' then
   select a.body||jsonb_build_object('id',a.id,'teamId',a.team_id,'name',a.name,'kind',a.kind) into result from cyberdog_private.assets a where a.id=(payload->>'id')::uuid and a.team_id=tid;
   if result is null then raise exception 'access_denied'; end if;return result;
  elsif action='history_list' then
   select coalesce(jsonb_agg(x.entry order by x.seq desc),'[]'::jsonb) into result from (
    select r.seq,jsonb_build_object('id',r.id,'serverId',r.server_id,'teamId',r.team_id,'operation',r.operation,'sequence',r.seq,'at',r.created_at,'actorId',r.actor_id,'actorEmail',r.actor_email,'snapshot',r.snapshot) as entry
    from cyberdog_private.server_revisions r
    where r.team_id=tid and (payload->>'before' is null or r.seq<(payload->>'before')::bigint) and (payload->>'id' is null or r.server_id=(payload->>'id')::uuid)
     and not exists(select 1 from cyberdog_private.servers s where s.id=r.server_id and s.team_id<>tid)
     and (select last.team_id from cyberdog_private.server_revisions last where last.server_id=r.server_id order by last.seq desc limit 1)=tid
    order by r.seq desc limit 100
   ) x;
   return result;
  elsif action='leave_team' then
   if actor_role='owner' then raise exception 'transfer_ownership_first'; end if;
   delete from cyberdog_private.members where team_id=tid and user_id=uid;
  else
   if action in ('server_save','server_delete','asset_save','asset_delete','history_restore') then
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
   elsif action='asset_save' then
    if coalesce(payload->>'kind','') not in ('groups','actions','paths') or coalesce(length(trim(payload->>'name')),0) not between 1 and 120 then raise exception 'invalid_asset'; end if;
    if payload->>'kind'='actions' and coalesce(length(payload->>'script'),0) not between 1 and 60000 then raise exception 'invalid_asset'; end if;
    if payload->>'kind'='paths' then
     if coalesce(payload->>'path','') !~ '^(/|~(/|$))' or length(payload->>'path')>4096 then raise exception 'invalid_asset'; end if;
     if payload->>'serverId' is not null and not exists(select 1 from cyberdog_private.servers where id=(payload->>'serverId')::uuid and team_id=tid) then raise exception 'access_denied'; end if;
    end if;
    if payload->>'id' is not null then
     select * into asset from cyberdog_private.assets where id=(payload->>'id')::uuid for update;
     if not found or asset.kind<>payload->>'kind' then raise exception 'access_denied'; end if;
     if asset.team_id<>tid then
      perform 1 from cyberdog_private.teams where id=asset.team_id for update;
      select (m.role='owner' or m.can_edit_servers) into source_write from cyberdog_private.members m join cyberdog_private.teams t on t.id=m.team_id where m.team_id=asset.team_id and m.user_id=uid and (not t.is_personal or t.owner_id=uid);
      if source_write is distinct from true then raise exception 'access_denied'; end if;
      if asset.kind='groups' and exists(select 1 from cyberdog_private.servers where group_id=asset.id) then raise exception 'group_in_use'; end if;
     end if;
    end if;
    result:=case payload->>'kind' when 'actions' then jsonb_build_object('script',payload->>'script') when 'paths' then jsonb_build_object('path',payload->>'path','serverId',payload->>'serverId') else '{}'::jsonb end;
    if payload->>'id' is null then
     insert into cyberdog_private.assets(team_id,kind,name,body) values(tid,payload->>'kind',trim(payload->>'name'),result) returning id into sid;
    else
     update cyberdog_private.assets set team_id=tid,name=trim(payload->>'name'),body=result,updated_at=now() where id=asset.id returning id into sid;
    end if;
   elsif action='asset_delete' then
    select * into asset from cyberdog_private.assets where id=(payload->>'id')::uuid and team_id=tid for update;
    if not found then raise exception 'access_denied'; end if;
    if asset.kind='groups' then update cyberdog_private.servers set group_id=null where group_id=asset.id; end if;
    delete from cyberdog_private.assets where id=asset.id;
   elsif action='history_restore' then
    select * into ver from cyberdog_private.server_revisions where id=(payload->>'versionId')::uuid and team_id=tid;
    if not found then raise exception 'access_denied'; end if;
    select team_id into source_tid from cyberdog_private.servers where id=ver.server_id for update;
    if source_tid is not null and source_tid<>tid then raise exception 'access_denied'; end if;
    if (select r.team_id from cyberdog_private.server_revisions r where r.server_id=ver.server_id order by r.seq desc limit 1)<>tid then raise exception 'access_denied'; end if;
    restore_group:=(ver.snapshot->>'group')::uuid;
    if restore_group is not null and not exists(select 1 from cyberdog_private.assets where id=restore_group and team_id=tid and kind='groups') then restore_group:=null;end if;
    perform set_config('cyberdog.history_operation','restore',true);
    insert into cyberdog_private.servers(id,team_id,name,host,port,username,group_id,bastion_id) values(ver.server_id,tid,ver.snapshot->>'name',ver.snapshot->>'host',(ver.snapshot->>'port')::int,ver.snapshot->>'user',restore_group,cyberdog_private.route_id(ver.snapshot->'networkAccess'))
    on conflict(id) do update set name=excluded.name,host=excluded.host,port=excluded.port,username=excluded.username,group_id=excluded.group_id,bastion_id=excluded.bastion_id,updated_at=now() where servers.team_id=tid;
    if not found then raise exception 'access_denied';end if;
    sid:=ver.server_id;
    perform set_config('cyberdog.history_operation','',true);
   elsif action='server_save' then
    route_bid:=cyberdog_private.route_id(payload->'networkAccess');
    if not(payload?'networkAccess') and exists(select 1 from cyberdog_private.servers where id=(payload->>'id')::uuid and bastion_id is not null) then raise exception 'bastion.route_unsupported';end if;
    if payload ?| array['pass','password','key','privateKey','secret'] then raise exception 'secrets_forbidden'; end if;
    if coalesce(length(trim(payload->>'host')),0) not between 1 and 255 or coalesce(length(trim(payload->>'user')),0) not between 1 and 128 or coalesce(length(trim(payload->>'name')),0) not between 1 and 120 then raise exception 'invalid_server'; end if;
    restore_group:=(payload->>'group')::uuid;
    if restore_group is not null and not exists(select 1 from cyberdog_private.assets where id=restore_group and team_id=tid and kind='groups') then raise exception 'invalid_group';end if;
    if payload->>'id' is null then
     insert into cyberdog_private.servers(team_id,name,host,port,username,group_id,bastion_id) values(tid,trim(payload->>'name'),trim(payload->>'host'),(payload->>'port')::int,trim(payload->>'user'),restore_group,route_bid) returning id into sid;
    else
     select team_id into source_tid from cyberdog_private.servers where id=(payload->>'id')::uuid for update;
     if source_tid is null then raise exception 'access_denied'; end if;
     if source_tid<>tid then
      perform 1 from cyberdog_private.teams where id=source_tid for update;
      select m.role,(m.role='owner' or m.can_edit_servers) into source_role,source_write from cyberdog_private.members m join cyberdog_private.teams t on t.id=m.team_id where m.team_id=source_tid and m.user_id=uid and (not t.is_personal or t.owner_id=uid);
      if source_role is null or not source_write then raise exception 'access_denied'; end if;
     end if;
     update cyberdog_private.servers set team_id=tid,group_id=restore_group,bastion_id=route_bid,name=trim(payload->>'name'),host=trim(payload->>'host'),port=(payload->>'port')::int,username=trim(payload->>'user'),updated_at=now() where id=(payload->>'id')::uuid and team_id=source_tid;
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
