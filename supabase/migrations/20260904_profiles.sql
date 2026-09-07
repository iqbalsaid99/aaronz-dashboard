create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'user',
  propspace_agent_id text,
  propspace_agent_name text,
  manager_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can read their own profile"
on public.profiles
for select
to authenticated
using (auth.uid() = id);

create policy "Admins can read all profiles"
on public.profiles
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('admin', 'super_admin')
  )
);

create policy "Users can update their own profile"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

create policy "Admins can update profiles"
on public.profiles
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('admin', 'super_admin')
  )
);

-- Create the row for the currently signed-in user after you have copied the auth.id
-- from the query below:
--
-- select id, email from auth.users where email = 'web@aaronz.co';
--
-- insert into public.profiles (
--   id,
--   email,
--   full_name,
--   role,
--   is_active
-- )
-- values (
--   'PASTE_USER_ID_HERE',
--   'web@aaronz.co',
--   'Aaronz Admin',
--   'super_admin',
--   true
-- )
-- on conflict (id) do update
-- set
--   email = excluded.email,
--   full_name = excluded.full_name,
--   role = excluded.role,
--   is_active = excluded.is_active,
--   updated_at = now();
