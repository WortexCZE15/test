-- Kvízy: nastavení databáze v Supabase
-- Spusť celé najednou v Supabase → SQL Editor → New query → Run.
-- Skript jde spustit opakovaně a převede i starší verzi databáze (bez kreditů).

-- =========================================================
-- Profily (přezdívky, kredity, správce)
-- =========================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nickname text not null unique check (char_length(nickname) between 2 and 30),
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists credits int not null default 0;
alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.profiles drop constraint if exists profiles_credits_check;
alter table public.profiles add constraint profiles_credits_check check (credits >= 0);
-- Přezdívka je unikátní bez ohledu na velká a malá písmena (Petra = petra).
create unique index if not exists profiles_nickname_lower_idx on public.profiles (lower(nickname));

alter table public.profiles enable row level security;

drop policy if exists "profiles: prihlaseni ctou" on public.profiles;
create policy "profiles: prihlaseni ctou" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles: kazdy meni svuj" on public.profiles;
create policy "profiles: kazdy meni svuj" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Je přihlášený uživatel správce?
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

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

-- =========================================================
-- Kvízy (veřejné údaje: název, cena, počet otázek)
-- =========================================================
create table if not exists public.quizzes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  question_count int not null default 0 check (question_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.quizzes add column if not exists price int not null default 0;
alter table public.quizzes drop constraint if exists quizzes_price_check;
alter table public.quizzes add constraint quizzes_price_check check (price between 0 and 10000);

create index if not exists quizzes_updated_at_idx on public.quizzes (updated_at desc);
create index if not exists quizzes_author_idx on public.quizzes (author_id);

-- Obsah kvízu (otázky) je zvlášť, aby placené otázky neviděl, kdo kvíz nekoupil.
create table if not exists public.quiz_content (
  quiz_id uuid primary key references public.quizzes (id) on delete cascade,
  questions jsonb,              -- otázky, když kvíz nemá heslo
  enc jsonb,                    -- zašifrované otázky, když kvíz má heslo
  check (questions is not null or enc is not null),
  check (octet_length(coalesce(questions::text, enc::text)) < 200000)
);

-- Převod ze starší verze: otázky byly přímo v tabulce quizzes.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'quizzes' and column_name = 'enc') then
    insert into public.quiz_content (quiz_id, questions, enc)
      select id, questions, enc from public.quizzes
      on conflict (quiz_id) do nothing;
    alter table public.quizzes drop column if exists locked;
    alter table public.quizzes drop column questions;
    alter table public.quizzes drop column enc;
  end if;
end;
$$;

alter table public.quizzes add column if not exists locked boolean not null default false;
update public.quizzes q set locked = true
  from public.quiz_content c
  where c.quiz_id = q.id and c.enc is not null and not q.locked;

-- =========================================================
-- Nákupy a historie kreditů
-- =========================================================
create table if not exists public.purchases (
  buyer_id uuid not null references public.profiles (id) on delete cascade,
  quiz_id uuid not null references public.quizzes (id) on delete cascade,
  price int not null,
  created_at timestamptz not null default now(),
  primary key (buyer_id, quiz_id)
);

create table if not exists public.credit_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  amount int not null,
  reason text not null,
  by_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists credit_log_user_idx on public.credit_log (user_id, created_at desc);

-- Má přihlášený uživatel přístup k otázkám kvízu?
create or replace function public.can_open_quiz(p_quiz uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.quizzes q
    where q.id = p_quiz
      and (q.price = 0
           or q.author_id = auth.uid()
           or exists (select 1 from public.purchases p where p.quiz_id = q.id and p.buyer_id = auth.uid())
           or public.is_admin())
  );
$$;

-- Nákup kvízu: kupujícímu se kredity odečtou, autorovi přičtou.
create or replace function public.buy_quiz(p_quiz uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_price int;
  v_author uuid;
  v_title text;
  v_balance int;
  v_new int;
begin
  if auth.uid() is null then
    raise exception 'Nejsi přihlášený.';
  end if;

  select price, author_id, title into v_price, v_author, v_title
    from public.quizzes where id = p_quiz;
  if not found then
    raise exception 'Kvíz neexistuje.';
  end if;
  if v_author = auth.uid() then
    raise exception 'Svůj vlastní kvíz kupovat nemusíš.';
  end if;

  insert into public.purchases (buyer_id, quiz_id, price)
    values (auth.uid(), p_quiz, v_price)
    on conflict do nothing;
  get diagnostics v_new = row_count;

  if v_new = 0 or v_price = 0 then
    select credits into v_balance from public.profiles where id = auth.uid();
    return v_balance;
  end if;

  update public.profiles set credits = credits - v_price
    where id = auth.uid() and credits >= v_price
    returning credits into v_balance;
  if not found then
    raise exception 'NEDOSTATEK_KREDITU';
  end if;

  update public.profiles set credits = credits + v_price where id = v_author;

  insert into public.credit_log (user_id, amount, reason, by_id) values
    (auth.uid(), -v_price, 'Nákup: ' || v_title, auth.uid()),
    (v_author, v_price, 'Prodej: ' || v_title, auth.uid());

  return v_balance;
end;
$$;

-- Správce přidá (nebo kladným/záporným číslem ubere) kredity.
create or replace function public.admin_add_credits(p_user uuid, p_amount int, p_note text default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance int;
begin
  if not public.is_admin() then
    raise exception 'Kredity může měnit jen správce.';
  end if;
  if p_amount = 0 or abs(p_amount) > 100000 then
    raise exception 'Zadej počet kreditů mezi 1 a 100 000.';
  end if;

  update public.profiles set credits = credits + p_amount
    where id = p_user and credits + p_amount >= 0
    returning credits into v_balance;
  if not found then
    raise exception 'Uživatel neexistuje, nebo by měl záporné kredity.';
  end if;

  insert into public.credit_log (user_id, amount, reason, by_id)
    values (p_user, p_amount, coalesce(nullif(trim(p_note), ''), 'Kredity od správce'), auth.uid());

  return v_balance;
end;
$$;

-- =========================================================
-- Pravidla přístupu (RLS)
-- =========================================================
alter table public.quizzes enable row level security;
alter table public.quiz_content enable row level security;
alter table public.purchases enable row level security;
alter table public.credit_log enable row level security;

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
  for delete to authenticated using (author_id = auth.uid() or public.is_admin());

drop policy if exists "quiz_content: cist s pristupem" on public.quiz_content;
create policy "quiz_content: cist s pristupem" on public.quiz_content
  for select to authenticated using (public.can_open_quiz(quiz_id));

drop policy if exists "quiz_content: vytvaret autor" on public.quiz_content;
create policy "quiz_content: vytvaret autor" on public.quiz_content
  for insert to authenticated
  with check (exists (select 1 from public.quizzes q where q.id = quiz_id and q.author_id = auth.uid()));

drop policy if exists "quiz_content: menit autor" on public.quiz_content;
create policy "quiz_content: menit autor" on public.quiz_content
  for update to authenticated
  using (exists (select 1 from public.quizzes q where q.id = quiz_id and q.author_id = auth.uid()))
  with check (exists (select 1 from public.quizzes q where q.id = quiz_id and q.author_id = auth.uid()));

drop policy if exists "purchases: vlastni nebo spravce" on public.purchases;
create policy "purchases: vlastni nebo spravce" on public.purchases
  for select to authenticated using (buyer_id = auth.uid() or public.is_admin());

drop policy if exists "credit_log: vlastni nebo spravce" on public.credit_log;
create policy "credit_log: vlastni nebo spravce" on public.credit_log
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- =========================================================
-- Oprávnění: kredity a správce se mění jen přes funkce výše
-- =========================================================
revoke all on public.profiles, public.quizzes, public.quiz_content, public.purchases, public.credit_log from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (nickname) on public.profiles to authenticated;
grant select, insert, update, delete on public.quizzes to authenticated;
grant select, insert, update on public.quiz_content to authenticated;
grant select on public.purchases, public.credit_log to authenticated;

revoke all on function public.nickname_taken(text) from public;
grant execute on function public.nickname_taken(text) to anon, authenticated;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.can_open_quiz(uuid) from public;
grant execute on function public.can_open_quiz(uuid) to authenticated;
revoke all on function public.buy_quiz(uuid) from public;
revoke execute on function public.buy_quiz(uuid) from anon;
grant execute on function public.buy_quiz(uuid) to authenticated;
revoke all on function public.admin_add_credits(uuid, int, text) from public;
revoke execute on function public.admin_add_credits(uuid, int, text) from anon;
grant execute on function public.admin_add_credits(uuid, int, text) to authenticated;
