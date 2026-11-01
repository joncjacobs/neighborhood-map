-- Neighborhood Map: tables, row-level security and photo storage.
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
  tax_name      text,                           -- name on the 2026 tax bill (reference only)
  pets          text,
  how_we_know   text,
  notes         text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid default auth.uid()
);

-- Adults and kids living at a household. One optional photo per person.
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
  photo_path  text,                             -- path inside the private "photos" bucket
  sort        int not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
-- Columns added after the first version; harmless if they already exist.
alter table public.people add column if not exists job text;
alter table public.households add column if not exists geometry jsonb;
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
-- Photos: a private bucket. Files are only reachable through short-lived
-- signed links, and only allowed users can create those links.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "photos: allowed users read"   on storage.objects;
drop policy if exists "photos: allowed users write"  on storage.objects;
drop policy if exists "photos: allowed users update" on storage.objects;
drop policy if exists "photos: allowed users delete" on storage.objects;

create policy "photos: allowed users read" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and public.is_allowed());
create policy "photos: allowed users write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and public.is_allowed());
create policy "photos: allowed users update" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos' and public.is_allowed())
  with check (bucket_id = 'photos' and public.is_allowed());
create policy "photos: allowed users delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and public.is_allowed());

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
