-- Run after schema.sql. Lets the app keep its existing card ids and extra fields, and adds a small settings table.

alter table questions
  add column key text not null,                    -- the app's own card id (hash of deck + question), so re-importing keeps progress
  add column extra jsonb not null default '{}';    -- any other card fields (e.g. slide)
alter table questions add constraint questions_user_key unique (user_id, key);

create table meta (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  key text not null,
  value jsonb,
  primary key (user_id, key)
);
alter table meta enable row level security;
grant select, insert, update, delete on meta to authenticated;
create policy "own rows" on meta for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
