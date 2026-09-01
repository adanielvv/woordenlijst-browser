create extension if not exists pg_trgm;

create table if not exists public.entries (
  id bigint primary key,
  word text not null,
  prefix text not null,
  label text not null default '',
  pronunciation text not null default '',
  gloss text not null default '',
  lemma_count integer not null default 0,
  word_search text generated always as (lower(word)) stored
);

create index if not exists entries_word_order on public.entries (word_search, id);
create index if not exists entries_prefix_word on public.entries (prefix, word_search, id);
create index if not exists entries_word_trgm on public.entries using gin (word_search gin_trgm_ops);

alter table public.entries enable row level security;
drop policy if exists "Public entries are readable" on public.entries;
create policy "Public entries are readable"
  on public.entries for select
  to anon, authenticated
  using (true);

revoke all on public.entries from anon, authenticated;
grant select on public.entries to anon, authenticated;

