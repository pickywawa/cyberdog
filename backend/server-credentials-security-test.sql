begin;
select set_config('bastion.a',public.cyberdog_bind_auth('00000000-0000-4000-8000-000000001101','route-a@fixture.invalid')::text,true);
select set_config('bastion.b',public.cyberdog_bind_auth('00000000-0000-4000-8000-000000001102','route-b@fixture.invalid')::text,true);
select set_config('bastion.pa',public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','list')->>'personalSpaceId',true);
select set_config('bastion.pb',public.cyberdog_member_action('00000000-0000-4000-8000-000000001102','list')->>'personalSpaceId',true);
create function pg_temp.route_denied(lic text,a text,p jsonb,e text) returns void language plpgsql as $$begin
 perform public.cyberdog_member_action(lic,a,p);raise exception 'TEST FAILED allowed %',a;
 exception when others then if sqlerrm<>e then raise exception 'TEST FAILED expected %, got %',e,sqlerrm;end if;
end $$;
select set_config('bastion.jump',public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.pa'),'name','Jump','host','jump.test','port',22,'user','jump'))->>'serverId',true);
select set_config('bastion.target',public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.pa'),'name','Target','host','target.test','port',22,'user','deploy','website','https://example.com','tags',jsonb_build_array('production','linux'),'downloadDir','/tmp/downloads','networkAccess',jsonb_build_object('version',1,'mode','bastion','bastionId',current_setting('bastion.jump'))))->>'serverId',true);
do $$declare p jsonb;begin
 p:=public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','route_get',jsonb_build_object('teamId',current_setting('bastion.pa'),'id',current_setting('bastion.target')));
 if p->'bastion'->>'id'<>current_setting('bastion.jump') or p->'target'->>'id'<>current_setting('bastion.target') then raise exception 'Wrong route';end if;
 if p->'target' ?| array['password','privateKey','pass','key'] or p->'bastion' ?| array['password','privateKey','pass','key'] then raise exception 'Secrets in route';end if;
end $$;
-- Non-secret preferences are scoped, synchronized and revisioned atomically.
do $$declare p jsonb; v uuid;begin
 p:=public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','server_get',jsonb_build_object('teamId',current_setting('bastion.pa'),'id',current_setting('bastion.target'),'routeVersion',1));
 if p->>'website'<>'https://example.com' or p->'tags'<>jsonb_build_array('production','linux') or p->>'downloadDir'<>'/tmp/downloads' then raise exception 'Preferences missing from server_get';end if;
 p:=public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','list');
 if not exists(select 1 from jsonb_array_elements(p->'servers') s where s->>'id'=current_setting('bastion.target') and s->>'website'='https://example.com') then raise exception 'Preferences missing from list';end if;
 select id into v from cyberdog_private.server_revisions where server_id=current_setting('bastion.target')::uuid order by seq desc limit 1;
 perform public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.pa'),'id',current_setting('bastion.target'),'name','Target','host','target.test','port',22,'user','deploy','website','https://changed.example.com','networkAccess',jsonb_build_object('version',1,'mode','bastion','bastionId',current_setting('bastion.jump'))));
 p:=public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','server_get',jsonb_build_object('teamId',current_setting('bastion.pa'),'id',current_setting('bastion.target'),'routeVersion',1));
 if p->'tags'<>jsonb_build_array('production','linux') then raise exception 'Partial update lost preferences';end if;
 perform public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','history_restore',jsonb_build_object('teamId',current_setting('bastion.pa'),'versionId',v));
 p:=public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','server_get',jsonb_build_object('teamId',current_setting('bastion.pa'),'id',current_setting('bastion.target'),'routeVersion',1));
 if p->>'website'<>'https://example.com' then raise exception 'Restore lost preferences';end if;
end $$;
select pg_temp.route_denied('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.pa'),'name','Invalid','host','target.test','port',22,'user','deploy','website','javascript:alert(1)'),'invalid_server_options');
select pg_temp.route_denied('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.pa'),'name','Invalid','host','target.test','port',22,'user','deploy','tags','oops'),'invalid_server_options');
select pg_temp.route_denied('00000000-0000-4000-8000-000000001102','route_get',jsonb_build_object('teamId',current_setting('bastion.pa'),'id',current_setting('bastion.target')),'access_denied');
select pg_temp.route_denied('00000000-0000-4000-8000-000000001101','server_get',jsonb_build_object('teamId',current_setting('bastion.pa'),'id',current_setting('bastion.target')),'bastion.route_unsupported');
select pg_temp.route_denied('00000000-0000-4000-8000-000000001101','server_delete',jsonb_build_object('teamId',current_setting('bastion.pa'),'id',current_setting('bastion.jump')),'bastion.in_use');
select pg_temp.route_denied('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.pa'),'id',current_setting('bastion.target'),'name','Target','host','target.test','port',22,'user','deploy'),'bastion.route_unsupported');
select pg_temp.route_denied('00000000-0000-4000-8000-000000001102','server_save',jsonb_build_object('teamId',current_setting('bastion.pb'),'name','Cross scope','host','target.test','port',22,'user','deploy','networkAccess',jsonb_build_object('version',1,'mode','bastion','bastionId',current_setting('bastion.jump'))),'bastion.scope');
select pg_temp.route_denied('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.pa'),'id',current_setting('bastion.jump'),'name','Jump','host','jump.test','port',22,'user','jump','networkAccess',jsonb_build_object('version',1,'mode','bastion','bastionId',current_setting('bastion.target'))),'bastion.in_use');
select pg_temp.route_denied('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.pa'),'name','Invalid route','host','jump.test','port',22,'user','jump','networkAccess',jsonb_build_object('mode','bastion','bastionId',current_setting('bastion.jump'))),'bastion.invalid_route');
select pg_temp.route_denied('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.pa'),'name','Null mode','host','jump.test','port',22,'user','jump','networkAccess',jsonb_build_object('version',1,'mode',null,'bastionId',current_setting('bastion.jump'))),'bastion.invalid_route');
-- A previous routed revision cannot resurrect a removed dependency.
select set_config('bastion.version',(select id::text from cyberdog_private.server_revisions where server_id=current_setting('bastion.target')::uuid order by seq desc limit 1),true);
select public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.pa'),'id',current_setting('bastion.target'),'name','Target','host','target.test','port',22,'user','deploy','networkAccess',jsonb_build_object('version',1,'mode','direct')));
select public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','server_delete',jsonb_build_object('teamId',current_setting('bastion.pa'),'id',current_setting('bastion.jump')));
select pg_temp.route_denied('00000000-0000-4000-8000-000000001101','history_restore',jsonb_build_object('teamId',current_setting('bastion.pa'),'versionId',current_setting('bastion.version')),'bastion.missing');
-- Shared read-only member may resolve, but cannot modify, a route.
select set_config('bastion.team',public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','create_team','{"name":"Route fixture team"}')->>'teamId',true);
select public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','invite',jsonb_build_object('teamId',current_setting('bastion.team'),'recipientId',current_setting('bastion.b')));
select public.cyberdog_member_action('00000000-0000-4000-8000-000000001102','accept_invite',jsonb_build_object('id',public.cyberdog_member_action('00000000-0000-4000-8000-000000001102','list')->'invitations'->0->>'id'));
select set_config('bastion.teamjump',public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.team'),'name','Team jump','host','jump.test','port',22,'user','jump'))->>'serverId',true);
select set_config('bastion.teamtarget',public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.team'),'name','Team target','host','target.test','port',22,'user','deploy','networkAccess',jsonb_build_object('version',1,'mode','bastion','bastionId',current_setting('bastion.teamjump'))))->>'serverId',true);
select public.cyberdog_member_action('00000000-0000-4000-8000-000000001102','route_get',jsonb_build_object('teamId',current_setting('bastion.team'),'id',current_setting('bastion.teamtarget')));
select pg_temp.route_denied('00000000-0000-4000-8000-000000001102','server_save',jsonb_build_object('teamId',current_setting('bastion.team'),'id',current_setting('bastion.teamtarget'),'name','Changed','host','target.test','port',22,'user','deploy','networkAccess',jsonb_build_object('version',1,'mode','direct')),'server_write_required');
-- Credential envelopes are separate from the configuration, catalog and history.
select public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.team'),'id',current_setting('bastion.teamtarget'),'name','Team target','host','target.test','port',22,'user','deploy','authMode','password','networkAccess',jsonb_build_object('version',1,'mode','bastion','bastionId',current_setting('bastion.teamjump')),'_credentialEnvelope',jsonb_build_object('v',1,'iv','AAAAAAAAAAAAAAAA','data','fixture-ciphertext')));
do $$declare p jsonb;begin
 p:=public.cyberdog_member_action('00000000-0000-4000-8000-000000001102','server_get',jsonb_build_object('teamId',current_setting('bastion.team'),'id',current_setting('bastion.teamtarget'),'routeVersion',1));
 if p->'credentialEnvelope'->>'data'<>'fixture-ciphertext' or p->>'hasSyncedCredential'<>'true' then raise exception 'Authorized read failed';end if;
 p:=public.cyberdog_member_action('00000000-0000-4000-8000-000000001102','list');if p::text like '%fixture-ciphertext%' then raise exception 'Ciphertext leaked into catalog';end if;
 p:=public.cyberdog_member_action('00000000-0000-4000-8000-000000001102','history_list',jsonb_build_object('teamId',current_setting('bastion.team')));if p::text like '%fixture-ciphertext%' then raise exception 'Secret entered history';end if;
 if has_table_privilege('anon','cyberdog_private.server_credentials','select') or has_table_privilege('authenticated','cyberdog_private.server_credentials','select') then raise exception 'Direct secret table access';end if;
end $$;
select pg_temp.route_denied('00000000-0000-4000-8000-000000001102','server_save',jsonb_build_object('teamId',current_setting('bastion.team'),'id',current_setting('bastion.teamtarget'),'name','Changed','host','target.test','port',22,'user','deploy','networkAccess',jsonb_build_object('version',1,'mode','direct'),'_credentialEnvelope',null),'server_write_required');
-- Turning synchronization off deletes the server-side envelope atomically.
select public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','server_save',jsonb_build_object('teamId',current_setting('bastion.team'),'id',current_setting('bastion.teamtarget'),'name','Team target','host','target.test','port',22,'user','deploy','networkAccess',jsonb_build_object('version',1,'mode','bastion','bastionId',current_setting('bastion.teamjump')),'_credentialEnvelope',null));
do $$begin if exists(select 1 from cyberdog_private.server_credentials where server_id=current_setting('bastion.teamtarget')::uuid) then raise exception 'Unsync retained ciphertext';end if;end $$;
select public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','remove_member',jsonb_build_object('teamId',current_setting('bastion.team'),'userId',current_setting('bastion.b')));
select pg_temp.route_denied('00000000-0000-4000-8000-000000001102','route_get',jsonb_build_object('teamId',current_setting('bastion.team'),'id',current_setting('bastion.teamtarget')),'access_denied');
select public.cyberdog_member_action('00000000-0000-4000-8000-000000001101','delete_team',jsonb_build_object('teamId',current_setting('bastion.team')));
update cyberdog_private.license_identities set active=false where license_id='00000000-0000-4000-8000-000000001101';
select pg_temp.route_denied('00000000-0000-4000-8000-000000001101','route_get',jsonb_build_object('teamId',current_setting('bastion.pa'),'id',current_setting('bastion.target')),'access_denied');
rollback;
