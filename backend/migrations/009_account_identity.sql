-- Identity is the Supabase Auth user id. The gateway verifies the user's access token,
-- binds that id here and only then calls cyberdog_member_action with the service key.
begin;
alter table cyberdog_private.license_identities drop constraint if exists license_identities_license_id_check;
create function public.cyberdog_bind_auth(auth_id uuid, email text) returns uuid language plpgsql security definer set search_path='' as $$
declare identity_id uuid;
begin
 insert into cyberdog_private.license_identities(license_id,user_id,email,test_mode,active,expires_at)
 select auth_id::text,auth_id,lower(email),s.test_mode,true,null from cyberdog_private.settings s
 on conflict on constraint license_identities_pkey do update set email=excluded.email,test_mode=excluded.test_mode,active=true,expires_at=null,checked_at=now()
 returning license_identities.user_id into identity_id;
 return identity_id;
end $$;
revoke all on function public.cyberdog_bind_auth(uuid,text) from public,anon,authenticated;
grant execute on function public.cyberdog_bind_auth(uuid,text) to service_role;
create function public.cyberdog_member_action(identity_id uuid, action text, payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid;
begin
 select l.user_id into uid from cyberdog_private.license_identities l where l.user_id=identity_id and l.checked_at>now()-interval '60 seconds';
 if uid is null or not cyberdog_private.premium(uid) then raise exception 'access_denied'; end if;
 perform set_config('request.jwt.claim.sub',uid::text,true);
 return public.cyberdog_account(action,payload);
end $$;
revoke all on function public.cyberdog_member_action(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.cyberdog_member_action(uuid,text,jsonb) to service_role;

-- Invitation links: only a SHA-256 hash of the secret token is stored.
create table cyberdog_private.invite_links (
 id uuid primary key default gen_random_uuid(),
 team_id uuid not null references cyberdog_private.teams on delete cascade,
 token_hash text unique not null,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '7 days',
 uses_left integer not null check(uses_left between 1 and 50)
);
create index invite_links_team on cyberdog_private.invite_links(team_id);
alter table cyberdog_private.invite_links enable row level security;
revoke all on cyberdog_private.invite_links from public,anon,authenticated;

create function cyberdog_private.can_admin(uid uuid, tid uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from cyberdog_private.members m join cyberdog_private.teams t on t.id=m.team_id where m.team_id=tid and m.user_id=uid and m.role in ('owner','admin') and not t.is_personal)
$$;
create function public.cyberdog_invite_link_create(uid uuid, tid uuid, hash text, uses integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare link record;
begin
 if not cyberdog_private.can_admin(uid,tid) then raise exception 'admin_required'; end if;
 if uses is null or uses not between 1 and 50 or hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_invite_link'; end if;
 delete from cyberdog_private.invite_links where expires_at<=now();
 if (select count(*) from cyberdog_private.invite_links where team_id=tid)>=100 then raise exception 'invite_limit'; end if;
 insert into cyberdog_private.invite_links(team_id,token_hash,created_by,uses_left) values(tid,hash,uid,uses) returning * into link;
 insert into cyberdog_private.audit(actor,team_id,action) values(uid,tid,'invite_link_create');
 return jsonb_build_object('id',link.id,'expiresAt',link.expires_at,'usesLeft',link.uses_left);
end $$;
create function public.cyberdog_invite_link_list(uid uuid, tid uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not cyberdog_private.can_admin(uid,tid) then raise exception 'admin_required'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'expiresAt',l.expires_at,'usesLeft',l.uses_left) order by l.created_at) from cyberdog_private.invite_links l where l.team_id=tid and l.expires_at>now()),'[]'::jsonb);
end $$;
create function public.cyberdog_invite_link_revoke(uid uuid, tid uuid, link_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not cyberdog_private.can_admin(uid,tid) then raise exception 'admin_required'; end if;
 delete from cyberdog_private.invite_links where id=link_id and team_id=tid;
 insert into cyberdog_private.audit(actor,team_id,action) values(uid,tid,'invite_link_revoke');
end $$;
create function public.cyberdog_invite_link_accept(uid uuid, hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare link record; team_name text;
begin
 if hash !~ '^[a-f0-9]{64}$' then raise exception 'invitation_unavailable'; end if;
 select * into link from cyberdog_private.invite_links where token_hash=hash and expires_at>now() for update;
 if not found then raise exception 'invitation_unavailable'; end if;
 if exists(select 1 from cyberdog_private.members where team_id=link.team_id and user_id=uid) then raise exception 'already_member'; end if;
 insert into cyberdog_private.members(team_id,user_id,role) values(link.team_id,uid,'member');
 if link.uses_left<=1 then delete from cyberdog_private.invite_links where id=link.id; else update cyberdog_private.invite_links set uses_left=uses_left-1 where id=link.id; end if;
 insert into cyberdog_private.audit(actor,team_id,action) values(uid,link.team_id,'invite_link_accept');
 select name into team_name from cyberdog_private.teams where id=link.team_id;
 return jsonb_build_object('teamId',link.team_id,'name',team_name);
end $$;
revoke all on function public.cyberdog_invite_link_create(uuid,uuid,text,integer),public.cyberdog_invite_link_list(uuid,uuid),public.cyberdog_invite_link_revoke(uuid,uuid,uuid),public.cyberdog_invite_link_accept(uuid,text) from public,anon,authenticated;
grant execute on function public.cyberdog_invite_link_create(uuid,uuid,text,integer),public.cyberdog_invite_link_list(uuid,uuid),public.cyberdog_invite_link_revoke(uuid,uuid,uuid),public.cyberdog_invite_link_accept(uuid,text) to service_role;
-- The member has to be a bound identity; the gateway guarantees it before calling.

-- Remove the former payment-provider integration.
drop function if exists public.cyberdog_bind_license(text,text,boolean,timestamptz);
drop function if exists public.cyberdog_licensed_action(text,text,jsonb);
drop function if exists public.cyberdog_revoke_license(text);
drop function if exists public.cyberdog_purchase(jsonb);
commit;
