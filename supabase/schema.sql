-- Neighborhood Map: tables and row-level security.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: everything is created "if not exists" or replaced.

-- ---------------------------------------------------------------------------
-- Who may use the app. Only user IDs in this table can read or write anything.
-- Being logged in is not enough on its own.
-- ---------------------------------------------------------------------------
create table if not exists public.allowed_users (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table public.allowed_users enable row level security;
-- No policies on purpose: the app can't read or change this list.
-- Only is_allowed() below (and you, in the dashboard) can see it.

create or replace function public.is_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.allowed_users where user_id = auth.uid());
$$;
revoke all on function public.is_allowed() from public, anon;
grant execute on function public.is_allowed() to authenticated;

-- ---------------------------------------------------------------------------
-- One row per lot, keyed by the county parcel number. The lot's outline lives
-- here too (not in the public site), so nothing public reveals where it is.
-- ---------------------------------------------------------------------------
create table if not exists public.households (
  parcel        text primary key,
  address       text not null,
  geometry      jsonb,                          -- GeoJSON Polygon/MultiPolygon of the lot
  display_name  text,                           -- map label override; blank = built from adults
  introduced    boolean not null default false, -- names stay hidden until we've met them
  pets          text,
  how_we_know   text,
  notes         text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid default auth.uid()
);

-- Adults and kids living at a household.
create table if not exists public.people (
  id          uuid primary key default gen_random_uuid(),
  parcel      text not null references public.households (parcel) on delete cascade,
  first_name  text not null,
  last_name   text,
  role        text not null default 'adult' check (role in ('adult', 'child')),
  age_grade   text,
  job         text,
  phone       text,
  email       text,
  notes       text,
  sort        int not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
-- Columns added after the first version; harmless if they already exist.
alter table public.people add column if not exists job text;
alter table public.households add column if not exists geometry jsonb;
alter table public.households add column if not exists introduced boolean not null default false;
-- Photos were removed from the app; drop the old column if it is still there.
alter table public.people drop column if exists photo_path;
-- The tax-bill name was removed too.
alter table public.households drop column if exists tax_name;
create index if not exists people_parcel_idx on public.people (parcel);

-- Keep updated_at/updated_by current; the app uses updated_at to detect
-- when the other person changed a record after you opened it.
create or replace function public.touch_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists households_touch on public.households;
create trigger households_touch before update on public.households
  for each row execute function public.touch_row();

drop trigger if exists people_touch on public.people;
create trigger people_touch before update on public.people
  for each row execute function public.touch_row();

-- ---------------------------------------------------------------------------
-- Row-level security: allowed users only, for every operation.
-- ---------------------------------------------------------------------------
alter table public.households enable row level security;
alter table public.people     enable row level security;

-- Supabase grants every privilege by default; TRUNCATE in particular ignores
-- row-level security, so grant back only the four the app uses.
revoke all on public.households, public.people, public.allowed_users from anon, authenticated;
grant select, insert, update, delete on public.households, public.people to authenticated;

drop policy if exists "allowed users" on public.households;
create policy "allowed users" on public.households
  for all to authenticated
  using (public.is_allowed())
  with check (public.is_allowed());

drop policy if exists "allowed users" on public.people;
create policy "allowed users" on public.people
  for all to authenticated
  using (public.is_allowed())
  with check (public.is_allowed());

-- ---------------------------------------------------------------------------
-- Photos were removed from the app. Clean up the old storage rules if present;
-- delete the empty "photos" bucket itself in the dashboard (Storage).
-- ---------------------------------------------------------------------------
drop policy if exists "photos: allowed users read"   on storage.objects;
drop policy if exists "photos: allowed users write"  on storage.objects;
drop policy if exists "photos: allowed users update" on storage.objects;
drop policy if exists "photos: allowed users delete" on storage.objects;

-- ---------------------------------------------------------------------------
-- Keep-alive: a tiny function the weekly GitHub Action calls so the free
-- project doesn't pause. It returns nothing about your data.
-- ---------------------------------------------------------------------------
create or replace function public.ping()
returns text
language sql
stable
as $$ select 'ok'::text; $$;
grant execute on function public.ping() to anon, authenticated;
