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
-- Profilovka a popis, předměty a štítky, hodnocení, hraní,
-- sledování a nahlášení
-- =========================================================
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists avatar_v bigint;   -- verze profilovky (null = žádná)
alter table public.profiles drop constraint if exists profiles_bio_check;
alter table public.profiles add constraint profiles_bio_check check (bio is null or char_length(bio) <= 300);

alter table public.quizzes add column if not exists subject text;
alter table public.quizzes add column if not exists tags text[] not null default '{}';
alter table public.quizzes add column if not exists rating_avg numeric(3,2);
alter table public.quizzes add column if not exists rating_count int not null default 0;
alter table public.quizzes add column if not exists play_count int not null default 0;
alter table public.quizzes add column if not exists score_sum bigint not null default 0;
alter table public.quizzes add column if not exists total_sum bigint not null default 0;
alter table public.quizzes drop constraint if exists quizzes_subject_check;
alter table public.quizzes add constraint quizzes_subject_check check (subject is null or char_length(subject) between 1 and 40);
alter table public.quizzes drop constraint if exists quizzes_tags_check;
alter table public.quizzes add constraint quizzes_tags_check check (cardinality(tags) <= 5);

-- Hodnocení: 1–5 hvězdiček a komentář, jedno na člověka a kvíz.
create table if not exists public.ratings (
  quiz_id uuid not null references public.quizzes (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  stars int not null check (stars between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (quiz_id, user_id)
);

-- Odehrané kvízy (statistiky).
create table if not exists public.plays (
  id bigint generated always as identity primary key,
  quiz_id uuid not null references public.quizzes (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  score int not null,
  total int not null,
  created_at timestamptz not null default now(),
  check (total between 1 and 500 and score between 0 and total)
);
create index if not exists plays_user_idx on public.plays (user_id, created_at desc);
create index if not exists plays_quiz_idx on public.plays (quiz_id);

-- Sledování autorů.
create table if not exists public.follows (
  follower_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  followee_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index if not exists follows_followee_idx on public.follows (followee_id);

-- Nahlášené kvízy.
create table if not exists public.reports (
  id bigint generated always as identity primary key,
  quiz_id uuid not null references public.quizzes (id) on delete cascade,
  reporter_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  reason text not null check (char_length(reason) between 3 and 500),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz
);
create unique index if not exists reports_one_open_idx on public.reports (quiz_id, reporter_id) where status = 'open';

-- Souhrny v tabulce quizzes počítá databáze sama.
create or replace function public.refresh_quiz_rating()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quiz uuid := coalesce(new.quiz_id, old.quiz_id);
begin
  update public.quizzes q set
    rating_avg = (select round(avg(stars)::numeric, 2) from public.ratings where quiz_id = v_quiz),
    rating_count = (select count(*) from public.ratings where quiz_id = v_quiz)
  where q.id = v_quiz;
  return null;
end;
$$;
drop trigger if exists ratings_refresh on public.ratings;
create trigger ratings_refresh after insert or update or delete on public.ratings
  for each row execute function public.refresh_quiz_rating();

create or replace function public.count_play()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.quizzes set
    play_count = play_count + 1,
    score_sum = score_sum + new.score,
    total_sum = total_sum + new.total
  where id = new.quiz_id;
  return null;
end;
$$;
drop trigger if exists plays_count on public.plays;
create trigger plays_count after insert on public.plays
  for each row execute function public.count_play();

alter table public.ratings enable row level security;
alter table public.plays enable row level security;
alter table public.follows enable row level security;
alter table public.reports enable row level security;

drop policy if exists "ratings: prihlaseni ctou" on public.ratings;
create policy "ratings: prihlaseni ctou" on public.ratings
  for select to authenticated using (true);
drop policy if exists "ratings: hodnotit s pristupem" on public.ratings;
create policy "ratings: hodnotit s pristupem" on public.ratings
  for insert to authenticated
  with check (user_id = auth.uid() and public.can_open_quiz(quiz_id)
              and not exists (select 1 from public.quizzes q where q.id = quiz_id and q.author_id = auth.uid()));
drop policy if exists "ratings: menit svoje" on public.ratings;
create policy "ratings: menit svoje" on public.ratings
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "ratings: mazat svoje" on public.ratings;
create policy "ratings: mazat svoje" on public.ratings
  for delete to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists "plays: vlastni, autor nebo spravce" on public.plays;
create policy "plays: vlastni, autor nebo spravce" on public.plays
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin()
         or exists (select 1 from public.quizzes q where q.id = quiz_id and q.author_id = auth.uid()));
drop policy if exists "plays: zapsat svoje" on public.plays;
create policy "plays: zapsat svoje" on public.plays
  for insert to authenticated with check (user_id = auth.uid() and public.can_open_quiz(quiz_id));

drop policy if exists "follows: prihlaseni ctou" on public.follows;
create policy "follows: prihlaseni ctou" on public.follows
  for select to authenticated using (true);
drop policy if exists "follows: sledovat" on public.follows;
create policy "follows: sledovat" on public.follows
  for insert to authenticated with check (follower_id = auth.uid());
drop policy if exists "follows: prestat" on public.follows;
create policy "follows: prestat" on public.follows
  for delete to authenticated using (follower_id = auth.uid());

drop policy if exists "reports: vlastni nebo spravce" on public.reports;
create policy "reports: vlastni nebo spravce" on public.reports
  for select to authenticated using (reporter_id = auth.uid() or public.is_admin());
drop policy if exists "reports: nahlasit" on public.reports;
create policy "reports: nahlasit" on public.reports
  for insert to authenticated with check (reporter_id = auth.uid() and status = 'open');
drop policy if exists "reports: spravce resi" on public.reports;
create policy "reports: spravce resi" on public.reports
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Profilovka: veřejné úložiště „avatars“, každý smí měnit jen svoji složku <id>/.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('avatars', 'avatars', true, 524288, array['image/webp', 'image/png', 'image/jpeg'])
      on conflict (id) do update set public = true, file_size_limit = 524288,
        allowed_mime_types = array['image/webp', 'image/png', 'image/jpeg'];

    drop policy if exists "avatars: cist svoje" on storage.objects;
    create policy "avatars: cist svoje" on storage.objects
      for select to authenticated
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid()::text));
    drop policy if exists "avatars: nahrat svoje" on storage.objects;
    create policy "avatars: nahrat svoje" on storage.objects
      for insert to authenticated
      with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid()::text));
    drop policy if exists "avatars: zmenit svoje" on storage.objects;
    create policy "avatars: zmenit svoje" on storage.objects
      for update to authenticated
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid()::text))
      with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid()::text));
    drop policy if exists "avatars: smazat svoje" on storage.objects;
    create policy "avatars: smazat svoje" on storage.objects
      for delete to authenticated
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid()::text));
  end if;
end;
$$;

-- =========================================================
-- Učitelé a jejich recenze
-- =========================================================
create table if not exists public.teachers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 80),
  department text check (department is null or char_length(department) <= 80),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  rating_avg numeric(3,2),
  rating_count int not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists teachers_name_lower_idx on public.teachers (lower(name));

create table if not exists public.teacher_reviews (
  teacher_id uuid not null references public.teachers (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  stars int not null check (stars between 1 and 5),
  subject text check (subject is null or char_length(subject) <= 60),
  comment text not null check (char_length(comment) between 10 and 1500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (teacher_id, user_id)
);

create or replace function public.refresh_teacher_rating()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t uuid := coalesce(new.teacher_id, old.teacher_id);
begin
  update public.teachers t set
    rating_avg = (select round(avg(stars)::numeric, 2) from public.teacher_reviews where teacher_id = v_t),
    rating_count = (select count(*) from public.teacher_reviews where teacher_id = v_t)
  where t.id = v_t;
  return null;
end;
$$;
drop trigger if exists teacher_reviews_refresh on public.teacher_reviews;
create trigger teacher_reviews_refresh after insert or update or delete on public.teacher_reviews
  for each row execute function public.refresh_teacher_rating();

alter table public.teachers enable row level security;
alter table public.teacher_reviews enable row level security;

drop policy if exists "teachers: prihlaseni ctou" on public.teachers;
create policy "teachers: prihlaseni ctou" on public.teachers for select to authenticated using (true);
drop policy if exists "teachers: pridat" on public.teachers;
create policy "teachers: pridat" on public.teachers for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "teachers: spravce meni" on public.teachers;
create policy "teachers: spravce meni" on public.teachers for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "teachers: spravce maze" on public.teachers;
create policy "teachers: spravce maze" on public.teachers for delete to authenticated using (public.is_admin());

drop policy if exists "teacher_reviews: prihlaseni ctou" on public.teacher_reviews;
create policy "teacher_reviews: prihlaseni ctou" on public.teacher_reviews for select to authenticated using (true);
drop policy if exists "teacher_reviews: psat svoje" on public.teacher_reviews;
create policy "teacher_reviews: psat svoje" on public.teacher_reviews for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "teacher_reviews: menit svoje" on public.teacher_reviews;
create policy "teacher_reviews: menit svoje" on public.teacher_reviews for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "teacher_reviews: mazat svoje" on public.teacher_reviews;
create policy "teacher_reviews: mazat svoje" on public.teacher_reviews for delete to authenticated using (user_id = auth.uid() or public.is_admin());

-- =========================================================
-- Studijní materiály (soubor, odkaz nebo text), i placené
-- =========================================================
create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  subject text check (subject is null or char_length(subject) between 1 and 40),
  tags text[] not null default '{}' check (cardinality(tags) <= 5),
  description text check (description is null or char_length(description) <= 2000),
  kind text not null check (kind in ('file', 'link', 'text')),
  file_name text check (file_name is null or char_length(file_name) <= 200),
  file_size int check (file_size is null or file_size between 0 and 20971520),
  price int not null default 0 check (price between 0 and 10000),
  download_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists materials_updated_idx on public.materials (updated_at desc);
create index if not exists materials_author_idx on public.materials (author_id);

create table if not exists public.material_content (
  material_id uuid primary key references public.materials (id) on delete cascade,
  body text check (body is null or char_length(body) <= 50000),
  url text check (url is null or (char_length(url) <= 500 and url ~* '^https?://')),
  file_path text check (file_path is null or char_length(file_path) <= 400)
);

create table if not exists public.material_purchases (
  buyer_id uuid not null references public.profiles (id) on delete cascade,
  material_id uuid not null references public.materials (id) on delete cascade,
  price int not null,
  created_at timestamptz not null default now(),
  primary key (buyer_id, material_id)
);

create or replace function public.can_open_material(p_material uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.materials m
    where m.id = p_material
      and (m.price = 0
           or m.author_id = auth.uid()
           or exists (select 1 from public.material_purchases p where p.material_id = m.id and p.buyer_id = auth.uid())
           or public.is_admin())
  );
$$;

-- Pro úložiště: cesta je <autor>/<id materiálu>/<soubor>.
create or replace function public.can_open_material_path(p_name text)
returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_part text := split_part(p_name, '/', 2);
begin
  if v_part !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.can_open_material(v_part::uuid);
end;
$$;

create or replace function public.owns_material_path(p_name text)
returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_part text := split_part(p_name, '/', 2);
begin
  if split_part(p_name, '/', 1) <> auth.uid()::text
     or v_part !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (select 1 from public.materials where id = v_part::uuid and author_id = auth.uid());
end;
$$;

create or replace function public.buy_material(p_material uuid)
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
  select price, author_id, title into v_price, v_author, v_title from public.materials where id = p_material;
  if not found then
    raise exception 'Materiál neexistuje.';
  end if;
  if v_author = auth.uid() then
    raise exception 'Svůj vlastní materiál kupovat nemusíš.';
  end if;

  insert into public.material_purchases (buyer_id, material_id, price)
    values (auth.uid(), p_material, v_price)
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
    (auth.uid(), -v_price, 'Nákup materiálu: ' || v_title, auth.uid()),
    (v_author, v_price, 'Prodej materiálu: ' || v_title, auth.uid());
  return v_balance;
end;
$$;

create or replace function public.count_material_open(p_material uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.materials set download_count = download_count + 1
  where id = p_material and public.can_open_material(p_material) and author_id <> auth.uid();
$$;

alter table public.materials enable row level security;
alter table public.material_content enable row level security;
alter table public.material_purchases enable row level security;

drop policy if exists "materials: prihlaseni ctou" on public.materials;
create policy "materials: prihlaseni ctou" on public.materials for select to authenticated using (true);
drop policy if exists "materials: vytvaret svoje" on public.materials;
create policy "materials: vytvaret svoje" on public.materials for insert to authenticated with check (author_id = auth.uid());
drop policy if exists "materials: menit svoje" on public.materials;
create policy "materials: menit svoje" on public.materials for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());
drop policy if exists "materials: mazat svoje" on public.materials;
create policy "materials: mazat svoje" on public.materials for delete to authenticated using (author_id = auth.uid() or public.is_admin());

drop policy if exists "material_content: cist s pristupem" on public.material_content;
create policy "material_content: cist s pristupem" on public.material_content for select to authenticated using (public.can_open_material(material_id));
drop policy if exists "material_content: vytvaret autor" on public.material_content;
create policy "material_content: vytvaret autor" on public.material_content for insert to authenticated
  with check (exists (select 1 from public.materials m where m.id = material_id and m.author_id = auth.uid()));
drop policy if exists "material_content: menit autor" on public.material_content;
create policy "material_content: menit autor" on public.material_content for update to authenticated
  using (exists (select 1 from public.materials m where m.id = material_id and m.author_id = auth.uid()))
  with check (exists (select 1 from public.materials m where m.id = material_id and m.author_id = auth.uid()));

drop policy if exists "material_purchases: vlastni nebo spravce" on public.material_purchases;
create policy "material_purchases: vlastni nebo spravce" on public.material_purchases
  for select to authenticated using (buyer_id = auth.uid() or public.is_admin());

-- Nahlášení: kvíz, materiál nebo recenze učitele.
alter table public.reports alter column quiz_id drop not null;
alter table public.reports add column if not exists material_id uuid references public.materials (id) on delete cascade;
alter table public.reports add column if not exists review_teacher_id uuid;
alter table public.reports add column if not exists review_user_id uuid;
alter table public.reports drop constraint if exists reports_review_fk;
alter table public.reports add constraint reports_review_fk foreign key (review_teacher_id, review_user_id)
  references public.teacher_reviews (teacher_id, user_id) on delete cascade;
alter table public.reports drop constraint if exists reports_one_target;
alter table public.reports add constraint reports_one_target
  check (num_nonnulls(quiz_id, material_id, review_teacher_id) = 1 and (review_teacher_id is null) = (review_user_id is null));
create unique index if not exists reports_one_open_material_idx on public.reports (material_id, reporter_id) where status = 'open' and material_id is not null;
create unique index if not exists reports_one_open_review_idx on public.reports (review_teacher_id, review_user_id, reporter_id) where status = 'open' and review_teacher_id is not null;

-- Soubory materiálů: soukromé úložiště, stáhne jen ten, kdo má přístup.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
      values ('materials', 'materials', false, 20971520)
      on conflict (id) do update set public = false, file_size_limit = 20971520;

    drop policy if exists "materials: stahnout s pristupem" on storage.objects;
    create policy "materials: stahnout s pristupem" on storage.objects
      for select to authenticated
      using (bucket_id = 'materials' and public.can_open_material_path(name));
    drop policy if exists "materials: nahrat autor" on storage.objects;
    create policy "materials: nahrat autor" on storage.objects
      for insert to authenticated
      with check (bucket_id = 'materials' and public.owns_material_path(name));
    drop policy if exists "materials: zmenit autor" on storage.objects;
    create policy "materials: zmenit autor" on storage.objects
      for update to authenticated
      using (bucket_id = 'materials' and public.owns_material_path(name))
      with check (bucket_id = 'materials' and public.owns_material_path(name));
    drop policy if exists "materials: smazat autor" on storage.objects;
    create policy "materials: smazat autor" on storage.objects
      for delete to authenticated
      using (bucket_id = 'materials' and (public.owns_material_path(name) or public.is_admin()));
  end if;
end;
$$;

-- =========================================================
-- Placené recenze učitelů: text recenze se odemyká za 1 kredit
-- (autor recenze kredit dostane). Hvězdičky a předmět vidí všichni.
-- =========================================================
create table if not exists public.review_unlocks (
  buyer_id uuid not null references public.profiles (id) on delete cascade,
  teacher_id uuid not null,
  reviewer_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (buyer_id, teacher_id, reviewer_id),
  foreign key (teacher_id, reviewer_id) references public.teacher_reviews (teacher_id, user_id) on delete cascade
);
alter table public.review_unlocks enable row level security;
drop policy if exists "review_unlocks: vlastni" on public.review_unlocks;
create policy "review_unlocks: vlastni" on public.review_unlocks for select to authenticated using (buyer_id = auth.uid() or public.is_admin());

-- Recenze učitele: text jen pro odemčené, vlastní nebo pro správce; jinak jen jeho délka.
create or replace function public.get_teacher_reviews(p_teacher uuid)
returns table (user_id uuid, nickname text, avatar_v bigint, stars int, subject text,
               comment text, comment_len int, unlocked boolean, updated_at timestamptz)
language sql
security definer
set search_path = ''
stable
as $$
  select r.user_id, p.nickname, p.avatar_v, r.stars, r.subject,
         case when x.ok then r.comment end, char_length(r.comment), x.ok, r.updated_at
  from public.teacher_reviews r
  join public.profiles p on p.id = r.user_id
  cross join lateral (
    select (r.user_id = auth.uid() or public.is_admin()
            or exists (select 1 from public.review_unlocks u
                       where u.buyer_id = auth.uid() and u.teacher_id = r.teacher_id and u.reviewer_id = r.user_id)) as ok
  ) x
  where r.teacher_id = p_teacher and auth.uid() is not null
  order by r.updated_at desc;
$$;

create or replace function public.unlock_review(p_teacher uuid, p_reviewer uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_balance int;
  v_new int;
begin
  if auth.uid() is null then
    raise exception 'Nejsi přihlášený.';
  end if;
  if not exists (select 1 from public.teacher_reviews where teacher_id = p_teacher and user_id = p_reviewer) then
    raise exception 'Recenze neexistuje.';
  end if;
  if p_reviewer = auth.uid() or public.is_admin() then
    select credits into v_balance from public.profiles where id = auth.uid();
    return v_balance;
  end if;

  insert into public.review_unlocks (buyer_id, teacher_id, reviewer_id)
    values (auth.uid(), p_teacher, p_reviewer)
    on conflict do nothing;
  get diagnostics v_new = row_count;
  if v_new = 0 then
    select credits into v_balance from public.profiles where id = auth.uid();
    return v_balance;
  end if;

  update public.profiles set credits = credits - 1
    where id = auth.uid() and credits >= 1
    returning credits into v_balance;
  if not found then
    raise exception 'NEDOSTATEK_KREDITU';
  end if;
  update public.profiles set credits = credits + 1 where id = p_reviewer;

  select name into v_name from public.teachers where id = p_teacher;
  insert into public.credit_log (user_id, amount, reason, by_id) values
    (auth.uid(), -1, 'Odemčení recenze: ' || coalesce(v_name, 'učitel'), auth.uid()),
    (p_reviewer, 1, 'Někdo odemkl tvou recenzi: ' || coalesce(v_name, 'učitel'), auth.uid());
  return v_balance;
end;
$$;

-- =========================================================
-- Moderátoři a ověřené materiály
-- =========================================================
alter table public.profiles add column if not exists is_moderator boolean not null default false;
alter table public.materials add column if not exists verified_by uuid references public.profiles (id) on delete set null;
alter table public.materials add column if not exists verified_at timestamptz;

create or replace function public.is_moderator()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce((select is_moderator or is_admin from public.profiles where id = auth.uid()), false);
$$;

-- Moderátor (nebo správce) označí materiál jako ověřený, nebo ověření zruší.
create or replace function public.set_material_verified(p_material uuid, p_verified boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_moderator() then
    raise exception 'Ověřovat materiály může jen moderátor.';
  end if;
  update public.materials set
    verified_by = case when p_verified then auth.uid() end,
    verified_at = case when p_verified then now() end
  where id = p_material;
  if not found then
    raise exception 'Materiál neexistuje.';
  end if;
end;
$$;

-- Správce jmenuje nebo odvolá moderátora.
create or replace function public.admin_set_moderator(p_user uuid, p_value boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Moderátory může jmenovat jen správce.';
  end if;
  update public.profiles set is_moderator = p_value where id = p_user;
  if not found then
    raise exception 'Uživatel neexistuje.';
  end if;
end;
$$;

-- Když autor změní obsah ověřeného materiálu, ověření se zruší.
create or replace function public.reset_material_verification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'material_content' then
    update public.materials set verified_by = null, verified_at = null
      where id = new.material_id and verified_at is not null;
    return null;
  end if;
  if (new.title, new.description, new.kind, new.file_name, new.file_size)
     is distinct from (old.title, old.description, old.kind, old.file_name, old.file_size) then
    new.verified_by := null;
    new.verified_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists materials_reset_verified on public.materials;
create trigger materials_reset_verified before update on public.materials
  for each row execute function public.reset_material_verification();
drop trigger if exists material_content_reset_verified on public.material_content;
create trigger material_content_reset_verified after insert or update on public.material_content
  for each row execute function public.reset_material_verification();

-- =========================================================
-- Ověřené kvízy a učitelé (stejně jako materiály)
-- =========================================================
alter table public.quizzes add column if not exists verified_by uuid references public.profiles (id) on delete set null;
alter table public.quizzes add column if not exists verified_at timestamptz;
alter table public.teachers add column if not exists verified_by uuid references public.profiles (id) on delete set null;
alter table public.teachers add column if not exists verified_at timestamptz;

create or replace function public.set_quiz_verified(p_quiz uuid, p_verified boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_moderator() then
    raise exception 'Ověřovat kvízy může jen moderátor.';
  end if;
  update public.quizzes set
    verified_by = case when p_verified then auth.uid() end,
    verified_at = case when p_verified then now() end
  where id = p_quiz;
  if not found then
    raise exception 'Kvíz neexistuje.';
  end if;
end;
$$;

create or replace function public.set_teacher_verified(p_teacher uuid, p_verified boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_moderator() then
    raise exception 'Ověřovat učitele může jen moderátor.';
  end if;
  update public.teachers set
    verified_by = case when p_verified then auth.uid() end,
    verified_at = case when p_verified then now() end
  where id = p_teacher;
  if not found then
    raise exception 'Učitel neexistuje.';
  end if;
end;
$$;

-- Když autor změní ověřený kvíz (název, otázky, heslo), ověření se zruší.
-- Počty hraní a hodnocení se mění bez vlivu na ověření.
create or replace function public.reset_quiz_verification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'quiz_content' then
    update public.quizzes set verified_by = null, verified_at = null
      where id = new.quiz_id and verified_at is not null;
    return null;
  end if;
  if (new.title, new.question_count, new.locked) is distinct from (old.title, old.question_count, old.locked) then
    new.verified_by := null;
    new.verified_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists quizzes_reset_verified on public.quizzes;
create trigger quizzes_reset_verified before update on public.quizzes
  for each row execute function public.reset_quiz_verification();
drop trigger if exists quiz_content_reset_verified on public.quiz_content;
create trigger quiz_content_reset_verified after insert or update on public.quiz_content
  for each row execute function public.reset_quiz_verification();

-- =========================================================
-- Nákup kreditů za peníze (QR platba na účet, správce potvrdí)
-- =========================================================
create table if not exists public.site_settings (
  id int primary key default 1 check (id = 1),
  bank_iban text check (bank_iban is null or bank_iban ~ '^CZ[0-9]{22}$'),
  bank_name text check (bank_name is null or char_length(bank_name) <= 60),
  updated_at timestamptz not null default now()
);
insert into public.site_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.credit_orders (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  package text not null,
  credits int not null check (credits > 0),
  price_czk int not null check (price_czk > 0),
  vs text not null unique check (vs ~ '^[0-9]{8}$'),
  status text not null default 'pending' check (status in ('pending', 'paid', 'cancelled')),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  confirmed_by uuid references public.profiles (id) on delete set null
);
create index if not exists credit_orders_user_idx on public.credit_orders (user_id, created_at desc);
create index if not exists credit_orders_status_idx on public.credit_orders (status, created_at);

-- Balíčky jsou jen tady, aby si nikdo nemohl poslat vlastní cenu.
create or replace function public.credit_package(p text, out credits int, out price_czk int)
language sql
immutable
as $$
  select c, pr from (values ('S', 10, 50), ('M', 30, 120), ('L', 100, 350)) v(k, c, pr) where k = p;
$$;

create or replace function public.create_credit_order(p_package text)
returns table (id bigint, credits int, price_czk int, vs text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credits int;
  v_price int;
  v_vs text;
  v_id bigint;
begin
  if auth.uid() is null then
    raise exception 'Nejsi přihlášený.';
  end if;
  select p.credits, p.price_czk into v_credits, v_price from public.credit_package(p_package) p;
  if v_credits is null then
    raise exception 'Takový balíček neexistuje.';
  end if;
  if (select count(*) from public.credit_orders o where o.user_id = auth.uid() and o.status = 'pending') >= 3 then
    raise exception 'Máš už 3 nezaplacené objednávky. Zaplať je nebo některou zruš.';
  end if;
  loop
    v_vs := lpad((floor(random() * 90000000) + 10000000)::bigint::text, 8, '0');
    exit when not exists (select 1 from public.credit_orders o where o.vs = v_vs);
  end loop;
  insert into public.credit_orders (user_id, package, credits, price_czk, vs)
    values (auth.uid(), p_package, v_credits, v_price, v_vs)
    returning credit_orders.id into v_id;
  return query select o.id, o.credits, o.price_czk, o.vs, o.created_at from public.credit_orders o where o.id = v_id;
end;
$$;

create or replace function public.cancel_credit_order(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.credit_orders set status = 'cancelled'
    where id = p_id and status = 'pending' and (user_id = auth.uid() or public.is_admin());
  if not found then
    raise exception 'Tuhle objednávku nejde zrušit.';
  end if;
end;
$$;

-- Správce potvrdí, že platba dorazila: kredity se připíšou a zapíšou do historie.
create or replace function public.admin_confirm_order(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.credit_orders;
begin
  if not public.is_admin() then
    raise exception 'Platby potvrzuje jen správce.';
  end if;
  update public.credit_orders set status = 'paid', paid_at = now(), confirmed_by = auth.uid()
    where id = p_id and status = 'pending'
    returning * into o;
  if not found then
    raise exception 'Objednávka neexistuje nebo už je vyřízená.';
  end if;
  update public.profiles set credits = credits + o.credits where id = o.user_id;
  insert into public.credit_log (user_id, amount, reason, by_id)
    values (o.user_id, o.credits, 'Nákup kreditů (' || o.price_czk || ' Kč, VS ' || o.vs || ')', auth.uid());
end;
$$;

alter table public.site_settings enable row level security;
alter table public.credit_orders enable row level security;
drop policy if exists "site_settings: prihlaseni ctou" on public.site_settings;
create policy "site_settings: prihlaseni ctou" on public.site_settings for select to authenticated using (true);
drop policy if exists "site_settings: spravce meni" on public.site_settings;
create policy "site_settings: spravce meni" on public.site_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "credit_orders: vlastni nebo spravce" on public.credit_orders;
create policy "credit_orders: vlastni nebo spravce" on public.credit_orders for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- =========================================================
-- Oprávnění: kredity a správce se mění jen přes funkce výše
-- =========================================================
revoke all on public.profiles, public.quizzes, public.quiz_content, public.purchases, public.credit_log,
  public.ratings, public.plays, public.follows, public.reports,
  public.teachers, public.teacher_reviews, public.materials, public.material_content, public.material_purchases,
  public.review_unlocks, public.site_settings, public.credit_orders from anon, authenticated;
grant select on public.site_settings, public.credit_orders to authenticated;
grant update (bank_iban, bank_name, updated_at) on public.site_settings to authenticated;
grant select on public.teachers to authenticated;
grant insert (name, department) on public.teachers to authenticated;
grant update (name, department) on public.teachers to authenticated;
grant delete on public.teachers to authenticated;
-- Text recenze (comment) se nedá číst přímo, jen přes get_teacher_reviews().
grant select (teacher_id, user_id, stars, subject, created_at, updated_at) on public.teacher_reviews to authenticated;
grant insert, delete on public.teacher_reviews to authenticated;
grant select on public.review_unlocks to authenticated;
grant update (stars, subject, comment, updated_at) on public.teacher_reviews to authenticated;
grant select, delete on public.materials to authenticated;
grant insert (title, subject, tags, description, kind, file_name, file_size, price, updated_at) on public.materials to authenticated;
grant update (title, subject, tags, description, kind, file_name, file_size, price, updated_at) on public.materials to authenticated;
grant select, insert, update on public.material_content to authenticated;
grant select on public.material_purchases to authenticated;
grant select on public.profiles to authenticated;
grant update (nickname, bio, avatar_v) on public.profiles to authenticated;
-- Souhrny (hodnocení, počet hraní) může měnit jen databáze, ne autor.
grant select, delete on public.quizzes to authenticated;
grant insert (title, question_count, price, locked, subject, tags, updated_at) on public.quizzes to authenticated;
grant update (title, question_count, price, locked, subject, tags, updated_at) on public.quizzes to authenticated;
grant select, insert, update on public.quiz_content to authenticated;
grant select on public.purchases, public.credit_log to authenticated;
grant select, insert, delete on public.ratings, public.follows to authenticated;
grant update (stars, comment, updated_at) on public.ratings to authenticated;
grant select, insert on public.plays to authenticated;
grant select on public.reports to authenticated;
grant insert (quiz_id, material_id, review_teacher_id, review_user_id, reason) on public.reports to authenticated;
grant update (status, resolved_by, resolved_at) on public.reports to authenticated;

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

revoke all on function public.buy_material(uuid) from public;
revoke execute on function public.buy_material(uuid) from anon;
grant execute on function public.buy_material(uuid) to authenticated;
revoke all on function public.count_material_open(uuid) from public;
revoke execute on function public.count_material_open(uuid) from anon;
grant execute on function public.count_material_open(uuid) to authenticated;
revoke all on function public.can_open_material(uuid) from public;
grant execute on function public.can_open_material(uuid) to authenticated;
revoke all on function public.can_open_material_path(text) from public;
grant execute on function public.can_open_material_path(text) to authenticated;
revoke all on function public.owns_material_path(text) from public;
grant execute on function public.owns_material_path(text) to authenticated;
revoke all on function public.get_teacher_reviews(uuid) from public;
revoke execute on function public.get_teacher_reviews(uuid) from anon;
grant execute on function public.get_teacher_reviews(uuid) to authenticated;
revoke all on function public.unlock_review(uuid, uuid) from public;
revoke execute on function public.unlock_review(uuid, uuid) from anon;
grant execute on function public.unlock_review(uuid, uuid) to authenticated;
revoke all on function public.is_moderator() from public;
grant execute on function public.is_moderator() to authenticated;
revoke all on function public.set_material_verified(uuid, boolean) from public;
revoke execute on function public.set_material_verified(uuid, boolean) from anon;
grant execute on function public.set_material_verified(uuid, boolean) to authenticated;
revoke all on function public.admin_set_moderator(uuid, boolean) from public;
revoke execute on function public.admin_set_moderator(uuid, boolean) from anon;
grant execute on function public.admin_set_moderator(uuid, boolean) to authenticated;
revoke all on function public.set_quiz_verified(uuid, boolean) from public;
revoke execute on function public.set_quiz_verified(uuid, boolean) from anon;
grant execute on function public.set_quiz_verified(uuid, boolean) to authenticated;
revoke all on function public.set_teacher_verified(uuid, boolean) from public;
revoke execute on function public.set_teacher_verified(uuid, boolean) from anon;
grant execute on function public.set_teacher_verified(uuid, boolean) to authenticated;
revoke all on function public.create_credit_order(text) from public;
revoke execute on function public.create_credit_order(text) from anon;
grant execute on function public.create_credit_order(text) to authenticated;
revoke all on function public.cancel_credit_order(bigint) from public;
revoke execute on function public.cancel_credit_order(bigint) from anon;
grant execute on function public.cancel_credit_order(bigint) to authenticated;
revoke all on function public.admin_confirm_order(bigint) from public;
revoke execute on function public.admin_confirm_order(bigint) from anon;
grant execute on function public.admin_confirm_order(bigint) to authenticated;
