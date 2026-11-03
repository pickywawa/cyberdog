begin;
select set_config('space.a',public.cyberdog_bind_auth('00000000-0000-4000-8000-000000000011','space-a@fixture.invalid')::text,true);
select set_config('space.b',public.cyberdog_bind_auth('00000000-0000-4000-8000-000000000012','space-b@fixture.invalid')::text,true);
select set_config('space.pa',public.cyberdog_member_action('00000000-0000-4000-8000-000000000011','list')->>'personalSpaceId',true);
select set_config('space.pb',public.cyberdog_member_action('00000000-0000-4000-8000-000000000012','list')->>'personalSpaceId',true);
do $$begin
 if current_setting('space.pa')=current_setting('space.pb') then raise exception 'Shared personal space';end if;
 if public.cyberdog_member_action('00000000-0000-4000-8000-000000000011','list')->>'personalSpaceId'<>current_setting('space.pa') then raise exception 'Personal space not stable';end if;
 if jsonb_array_length(public.cyberdog_member_action('00000000-0000-4000-8000-000000000011','list')->'teams')<>0 then raise exception 'Personal space exposed as team';end if;
end $$;
create function pg_temp.denied(lic text,a text,p jsonb,e text) returns void language plpgsql as $$begin
 perform public.cyberdog_member_action(lic::uuid,a,p);raise exception 'TEST FAILED: allowed %',a;
 exception when others then if sqlerrm<>e then raise exception 'TEST FAILED: expected %, got %',e,sqlerrm;end if;
end $$;
select set_config('space.sid',public.cyberdog_member_action('00000000-0000-4000-8000-000000000011','server_save',jsonb_build_object('teamId',current_setting('space.pa'),'name','Private','host','private.test','user','me','port',22))->>'serverId',true);
select pg_temp.denied('00000000-0000-4000-8000-000000000012','server_get',jsonb_build_object('teamId',current_setting('space.pa'),'id',current_setting('space.sid')),'access_denied');
select pg_temp.denied('00000000-0000-4000-8000-000000000011','invite',jsonb_build_object('teamId',current_setting('space.pa'),'recipientId',current_setting('space.b')),'access_denied');
select pg_temp.denied('00000000-0000-4000-8000-000000000011','delete_team',jsonb_build_object('teamId',current_setting('space.pa')),'access_denied');
select set_config('space.tid',public.cyberdog_member_action('00000000-0000-4000-8000-000000000011','create_team','{"name":"Workspace security"}')->>'teamId',true);
select public.cyberdog_member_action('00000000-0000-4000-8000-000000000011','invite',jsonb_build_object('teamId',current_setting('space.tid'),'recipientId',current_setting('space.b')));
select public.cyberdog_member_action('00000000-0000-4000-8000-000000000012','accept_invite',jsonb_build_object('id',public.cyberdog_member_action('00000000-0000-4000-8000-000000000012','list')->'invitations'->0->>'id'));
select pg_temp.denied('00000000-0000-4000-8000-000000000012','server_save',jsonb_build_object('teamId',current_setting('space.tid'),'name','Denied','host','host','user','me','port',22),'server_write_required');
select public.cyberdog_member_action('00000000-0000-4000-8000-000000000011','set_server_permission',jsonb_build_object('teamId',current_setting('space.tid'),'userId',current_setting('space.b'),'canEditServers',true));
select set_config('space.shared',public.cyberdog_member_action('00000000-0000-4000-8000-000000000012','server_save',jsonb_build_object('teamId',current_setting('space.tid'),'name','Allowed','host','host','user','me','port',22))->>'serverId',true);
select public.cyberdog_member_action('00000000-0000-4000-8000-000000000011','set_server_permission',jsonb_build_object('teamId',current_setting('space.tid'),'userId',current_setting('space.b'),'canEditServers',false));
select public.cyberdog_member_action('00000000-0000-4000-8000-000000000012','server_get',jsonb_build_object('teamId',current_setting('space.tid'),'id',current_setting('space.shared')));
select pg_temp.denied('00000000-0000-4000-8000-000000000012','server_delete',jsonb_build_object('teamId',current_setting('space.tid'),'id',current_setting('space.shared')),'server_write_required');
select pg_temp.denied('00000000-0000-4000-8000-000000000012','server_save',jsonb_build_object('teamId',current_setting('space.pb'),'id',current_setting('space.shared'),'name','Steal','host','host','user','me','port',22),'access_denied');
select public.cyberdog_member_action('00000000-0000-4000-8000-000000000011','set_role',jsonb_build_object('teamId',current_setting('space.tid'),'userId',current_setting('space.b'),'role','admin'));
select pg_temp.denied('00000000-0000-4000-8000-000000000012','server_delete',jsonb_build_object('teamId',current_setting('space.tid'),'id',current_setting('space.shared')),'server_write_required');
select pg_temp.denied('00000000-0000-4000-8000-000000000012','set_server_permission',jsonb_build_object('teamId',current_setting('space.tid'),'userId',current_setting('space.b'),'canEditServers',true),'owner_required');
-- Explicitly sharing and unsharing a personal server changes its visibility atomically.
select public.cyberdog_member_action('00000000-0000-4000-8000-000000000011','server_save',jsonb_build_object('teamId',current_setting('space.tid'),'id',current_setting('space.sid'),'name','Share','host','private.test','user','me','port',22));
select public.cyberdog_member_action('00000000-0000-4000-8000-000000000012','server_get',jsonb_build_object('teamId',current_setting('space.tid'),'id',current_setting('space.sid')));
select public.cyberdog_member_action('00000000-0000-4000-8000-000000000011','server_save',jsonb_build_object('teamId',current_setting('space.pa'),'id',current_setting('space.sid'),'name','Private again','host','private.test','user','me','port',22));
select pg_temp.denied('00000000-0000-4000-8000-000000000012','server_get',jsonb_build_object('teamId',current_setting('space.tid'),'id',current_setting('space.sid')),'access_denied');
rollback;
