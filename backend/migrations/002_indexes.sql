begin;
create index if not exists members_user_id on cyberdog_private.members(user_id);
create index if not exists purchases_user_id on cyberdog_private.purchases(user_id) where active;
create index if not exists purchases_unclaimed_email on cyberdog_private.purchases(email) where user_id is null;
create index if not exists invites_email on cyberdog_private.invites(email);
create index if not exists servers_team_id on cyberdog_private.servers(team_id);
commit;
