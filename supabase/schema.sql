-- ankidote database. Paste into Supabase -> SQL Editor -> Run.
-- Every table is private per user (row level security). Deleting a user deletes all their rows.

create table folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  unique (user_id, name)
);

create table decks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  folder_id uuid references folders on delete set null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

-- an uploaded slide PDF; a deck can have many. The file itself lives in Storage bucket "slides".
create table slide_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  deck_id uuid not null references decks on delete cascade,
  file_name text not null,
  storage_path text not null,
  week int,
  page_count int
);

-- one row per slide page: extracted text, so questions can pick pages / weeks and link back to them
create table slides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  file_id uuid not null references slide_files on delete cascade,
  page int not null,
  week int,
  body text not null default '',
  unique (file_id, page)
);

-- a question plus its own spaced-repetition state (same fields the app uses today)
-- options: [{ "text": "...", "why": "why this option is right or wrong" }, ...]
create table questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  deck_id uuid not null references decks on delete cascade,
  stem text not null,
  options jsonb not null,
  answer int not null,
  explanation text not null default '',
  source_file_id uuid references slide_files on delete set null,
  source_pages int[] not null default '{}',
  ease real not null default 2.5,
  interval real not null default 0,
  due bigint not null default 0,
  reps int not null default 0,
  lapses int not null default 0
);

create table review_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  question_id uuid references questions on delete set null,
  at bigint not null,
  data jsonb not null default '{}'
);

-- pages generated per month, for the per-user limit. Written only by the server function, read by the user.
create table usage (
  user_id uuid not null references auth.users on delete cascade,
  month text not null,
  pages int not null default 0,
  primary key (user_id, month)
);

create index on decks (user_id);
create index on slides (file_id);
create index on questions (user_id, deck_id);
create index on questions (user_id, due);
create index on review_logs (user_id, at);

-- security: automatic exposure is off, so grant access explicitly, then lock rows to their owner
alter table folders enable row level security;
alter table decks enable row level security;
alter table slide_files enable row level security;
alter table slides enable row level security;
alter table questions enable row level security;
alter table review_logs enable row level security;
alter table usage enable row level security;

grant select, insert, update, delete on folders, decks, slide_files, slides, questions, review_logs to authenticated;
grant select on usage to authenticated;

do $$ declare t text; begin
  foreach t in array array['folders','decks','slide_files','slides','questions','review_logs'] loop
    execute format('create policy "own rows" on %I for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
  end loop;
end $$;
create policy "own usage" on usage for select to authenticated using ((select auth.uid()) = user_id);

-- private bucket for slide PDFs; each user only reaches the folder named after their id
insert into storage.buckets (id, name, public) values ('slides', 'slides', false);
create policy "own slide files" on storage.objects for all to authenticated
  using (bucket_id = 'slides' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'slides' and (storage.foldername(name))[1] = (select auth.uid())::text);
