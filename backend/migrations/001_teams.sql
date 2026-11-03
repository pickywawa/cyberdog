begin;
create schema if not exists cyberdog_private;
revoke all on schema cyberdog_private from public, anon, authenticated;
create table cyberdog_private.settings (singleton boolean primary key default true check(singleton), test_mode boolean not null default true);
insert into cyberdog_private.settings values(true,true);
create table cyberdog_private.grants (user_id uuid primary key references auth.users(id) on delete cascade, source text not null check(source in ('enterprise','manual')), expires_at timestamptz not null, revoked boolean not null default false);
create table cyberdog_private.purchases (id text primary key, email text not null, user_id uuid references auth.users(id) on delete set null, active boolean not null, expires_at timestamptz, updated_at timestamptz not null, test_mode boolean not null, source text not null);
create table cyberdog_private.teams (id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 80), owner_id uuid not null references auth.users(id), created_at timestamptz not null default now());
create table cyberdog_private.members (team_id uuid references cyberdog_private.teams on delete cascade, user_id uuid references auth.users on delete cascade, role text not null check(role in ('owner','admin','member')), primary key(team_id,user_id));
create unique index one_owner on cyberdog_private.members(team_id) where role='owner';
create table cyberdog_private.invites (id uuid primary key default gen_random_uuid(), team_id uuid not null references cyberdog_private.teams on delete cascade, email text not null, created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '7 days', unique(team_id,email));
create table cyberdog_private.servers (id uuid primary key default gen_random_uuid(), team_id uuid not null references cyberdog_private.teams on delete cascade, name text not null, host text not null, port integer not null check(port between 1 and 65535), username text not null, updated_at timestamptz not null default now());
create table cyberdog_private.audit (id bigint generated always as identity primary key, actor uuid, team_id uuid, action text not null, created_at timestamptz not null default now());
-- Defense in depth: no client table grants, plus RLS without client policies.
alter table cyberdog_private.grants enable row level security;
alter table cyberdog_private.purchases enable row level security;
alter table cyberdog_private.teams enable row level security;
alter table cyberdog_private.members enable row level security;
alter table cyberdog_private.invites enable row level security;
alter table cyberdog_private.servers enable row level security;
alter table cyberdog_private.audit enable row level security;
alter table cyberdog_private.settings enable row level security;
revoke all on all tables in schema cyberdog_private from public, anon, authenticated;
create function cyberdog_private.premium(uid uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from cyberdog_private.grants g where g.user_id=uid and not g.revoked and g.expires_at>now())
 or exists(select 1 from cyberdog_private.purchases p,cyberdog_private.settings s where p.user_id=uid and p.active and p.test_mode=s.test_mode and (p.expires_at is null or p.expires_at>now()))
$$;
revoke all on function cyberdog_private.premium(uuid) from public,anon,authenticated;
create function public.cyberdog_account(action text default 'status', payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); v_email text; tid uuid; own uuid; actor_role text; target uuid; target_role text; result jsonb; sid uuid; inv record;
begin
 if uid is null then raise exception 'authentication_required'; end if;
 select lower(u.email) into v_email from auth.users u where u.id=uid and u.email_confirmed_at is not null and u.deleted_at is null and (u.banned_until is null or u.banned_until<now());
 if v_email is null then raise exception 'verified_email_required'; end if;
 -- Claim an unassigned purchase only after proof of email ownership. Never reassign claimed purchases by email.
 update cyberdog_private.purchases p set user_id=uid where p.user_id is null and p.email=v_email;
 if action='status' then
  return jsonb_build_object('email',v_email,'userId',uid,'premium',cyberdog_private.premium(uid),'testMode',(select s.test_mode from cyberdog_private.settings s));
 end if;
 if not cyberdog_private.premium(uid) then raise exception 'premium_required'; end if;
 if action='list' then
  select jsonb_build_object('teams',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'role',m.role)) from cyberdog_private.teams t join cyberdog_private.members m on m.team_id=t.id where m.user_id=uid and cyberdog_private.premium(t.owner_id)),'[]'::jsonb),
   'servers',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'teamId',s.team_id,'name',s.name,'host',s.host,'port',s.port,'user',s.username)) from cyberdog_private.servers s join cyberdog_private.teams t on t.id=s.team_id join cyberdog_private.members m on m.team_id=t.id where m.user_id=uid and cyberdog_private.premium(t.owner_id)),'[]'::jsonb),
   'invitations',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'name',t.name,'expiresAt',i.expires_at)) from cyberdog_private.invites i join cyberdog_private.teams t on t.id=i.team_id where i.email=v_email and i.expires_at>now() and cyberdog_private.premium(t.owner_id)),'[]'::jsonb)) into result;
  return result;
 end if;
 if action='create_team' then
  if length(trim(payload->>'name')) not between 1 and 80 or payload->>'name' is null then raise exception 'invalid_name'; end if;
  if (select count(*) from cyberdog_private.teams where owner_id=uid)>=20 then raise exception 'team_limit'; end if;
  insert into cyberdog_private.teams(name,owner_id) values(trim(payload->>'name'),uid) returning id into tid;
  insert into cyberdog_private.members values(tid,uid,'owner');
 elsif action='accept_invite' then
  select * into inv from cyberdog_private.invites where id=(payload->>'id')::uuid and invites.email=v_email and expires_at>now() for update;
  if not found then raise exception 'invitation_unavailable'; end if;
  tid:=inv.team_id;
  select owner_id into own from cyberdog_private.teams where id=tid for update;
  if not cyberdog_private.premium(own) then raise exception 'premium_required'; end if;
  insert into cyberdog_private.members values(tid,uid,'member') on conflict do nothing;
  delete from cyberdog_private.invites where id=inv.id;
 else
  tid:=(payload->>'teamId')::uuid;
  select owner_id into own from cyberdog_private.teams where id=tid for update;
  select role into actor_role from cyberdog_private.members where team_id=tid and user_id=uid;
  if own is null or actor_role is null or not cyberdog_private.premium(own) then raise exception 'access_denied'; end if;
  if action='details' then
   return jsonb_build_object('members',(select jsonb_agg(jsonb_build_object('id',m.user_id,'email',u.email,'role',m.role,'premium',cyberdog_private.premium(m.user_id))) from cyberdog_private.members m join auth.users u on u.id=m.user_id where m.team_id=tid),
    'invitations',case when actor_role in ('owner','admin') then coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'expiresAt',i.expires_at)) from cyberdog_private.invites i where i.team_id=tid),'[]'::jsonb) else '[]'::jsonb end);
  elsif action='server_get' then
   select jsonb_build_object('id',s.id,'teamId',s.team_id,'name',s.name,'host',s.host,'port',s.port,'user',s.username) into result from cyberdog_private.servers s where s.team_id=tid and s.id=(payload->>'id')::uuid;
   if result is null then raise exception 'access_denied'; end if; return result;
  elsif action='leave_team' then
   if actor_role='owner' then raise exception 'transfer_ownership_first'; end if;
   delete from cyberdog_private.members where team_id=tid and user_id=uid;
  else
   if actor_role not in ('owner','admin') then raise exception 'admin_required'; end if;
   if action='invite' then
    if length(payload->>'email')>254 or coalesce(payload->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'invalid_email'; end if;
    if (select count(*) from cyberdog_private.invites where team_id=tid)>=100 then raise exception 'invite_limit'; end if;
    insert into cyberdog_private.invites(team_id,email) values(tid,lower(trim(payload->>'email'))) on conflict(team_id,email) do update set expires_at=now()+interval '7 days';
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
revoke all on function public.cyberdog_account(text,jsonb) from public,anon;
grant execute on function public.cyberdog_account(text,jsonb) to authenticated;
-- Called exclusively by the signature-verifying webhook function. No client can grant Premium.
create function public.cyberdog_purchase(event jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 insert into cyberdog_private.purchases(id,email,active,expires_at,updated_at,test_mode,source)
 values(event->>'id',lower(event->>'email'),(event->>'active')::boolean,(event->>'expiresAt')::timestamptz,(event->>'updatedAt')::timestamptz,(event->>'testMode')::boolean,event->>'source')
 on conflict(id) do update set active=excluded.active,expires_at=excluded.expires_at,updated_at=excluded.updated_at
 where purchases.updated_at<excluded.updated_at;
end $$;
revoke all on function public.cyberdog_purchase(jsonb) from public,anon,authenticated;
grant execute on function public.cyberdog_purchase(jsonb) to service_role;
commit;
