-- Plans: 7-day trial with a small AI allowance, then a paid plan for AI generation. Manual deck features never check this.
-- Users can only read their own row. Only the server (service_role) writes it: the generate function, and later the payment webhook.

create table subscriptions (
  user_id uuid primary key references auth.users on delete cascade,
  trial_ends_at timestamptz not null default now() + interval '7 days',
  trial_generations_used int not null default 0,
  status text not null default 'trial' check (status in ('trial', 'active', 'canceled')),
  current_period_end timestamptz,   -- paid access lasts until this moment
  provider text,                    -- 'paymob', 'kashier', or 'manual'
  provider_ref text
);

alter table subscriptions enable row level security;
grant select on subscriptions to authenticated;
grant select, insert, update on subscriptions to service_role;
create policy "own subscription" on subscriptions for select to authenticated using ((select auth.uid()) = user_id);

-- every new account starts its trial automatically
create function public.start_trial() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.subscriptions (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_signup_start_trial after insert on auth.users for each row execute function public.start_trial();

-- accounts that already exist get a trial starting now
insert into subscriptions (user_id) select id from auth.users on conflict do nothing;
