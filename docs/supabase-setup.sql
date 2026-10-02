-- Kvízy: nastavení databáze v Supabase
-- Spusť celé najednou v Supabase → SQL Editor → New query → Run.
-- Skript jde spustit i opakovaně.

-- ---------- Profily (přezdívky) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nickname text not null unique check (char_length(nickname) between 2 and 30),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: prihlaseni ctou" on public.profiles;
create policy "profiles: prihlaseni ctou" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles: kazdy meni svuj" on public.profiles;
create policy "profiles: kazdy meni svuj" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Profil se vytvoří automaticky při registraci z přezdívky v metadatech.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, trim(new.raw_user_meta_data ->> 'nickname'));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Kontrola přezdívky před registrací (smí volat i nepřihlášený).
create or replace function public.nickname_taken(n text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (select 1 from public.profiles where lower(nickname) = lower(trim(n)));
$$;

revoke all on function public.nickname_taken(text) from public;
grant execute on function public.nickname_taken(text) to anon, authenticated;

-- ---------- Kvízy ----------
create table if not exists public.quizzes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  questions jsonb,              -- otázky, když kvíz nemá heslo
  enc jsonb,                    -- zašifrované otázky, když kvíz má heslo
  locked boolean generated always as (enc is not null) stored,
  question_count int not null default 0 check (question_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (questions is not null or enc is not null),
  check (octet_length(coalesce(questions::text, enc::text)) < 200000)
);

create index if not exists quizzes_updated_at_idx on public.quizzes (updated_at desc);

alter table public.quizzes enable row level security;

drop policy if exists "quizzes: prihlaseni ctou" on public.quizzes;
create policy "quizzes: prihlaseni ctou" on public.quizzes
  for select to authenticated using (true);

drop policy if exists "quizzes: vytvaret svoje" on public.quizzes;
create policy "quizzes: vytvaret svoje" on public.quizzes
  for insert to authenticated with check (author_id = auth.uid());

drop policy if exists "quizzes: menit svoje" on public.quizzes;
create policy "quizzes: menit svoje" on public.quizzes
  for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());

drop policy if exists "quizzes: mazat svoje" on public.quizzes;
create policy "quizzes: mazat svoje" on public.quizzes
  for delete to authenticated using (author_id = auth.uid());

-- Nepřihlášení nevidí nic, přihlášení jen přes pravidla výše.
revoke all on public.profiles, public.quizzes from anon;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.quizzes to authenticated;
