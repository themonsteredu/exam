-- 시험지 만들기 앱(exam): 설정, AI 사용 기록, 보관함 문서, 로그인 기록, 파일 보관함.
-- Supabase 프로젝트 aiapp 에 다른 앱과 함께 있으므로 이름 앞에 exam_ 을 붙인다.
-- RLS 를 켜고 정책을 두지 않는다: 브라우저(anon) 로는 못 보고, Supabase 함수 exam-gateway 가 서비스 열쇠로만 다룬다.

create table if not exists public.exam_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.exam_usage (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null check (kind in ('page', 'figure', 'test')),
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  usd numeric(12, 6) not null default 0,
  doc_id uuid
);
create index if not exists exam_usage_at_idx on public.exam_usage (at);

create table if not exists public.exam_documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  title text not null default '',
  status text not null default 'reading' check (status in ('reading', 'done', 'failed')),
  original_files jsonb not null default '[]'::jsonb,
  hwpx_path text,
  exam_json jsonb,
  cost_usd numeric(12, 6) not null default 0,
  item_count integer not null default 0,
  note text
);
create index if not exists exam_documents_created_idx on public.exam_documents (created_at desc);

create table if not exists public.exam_login_attempts (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  ok boolean not null,
  ip text not null default ''
);
create index if not exists exam_login_attempts_at_idx on public.exam_login_attempts (at);

alter table public.exam_settings enable row level security;
alter table public.exam_usage enable row level security;
alter table public.exam_documents enable row level security;
alter table public.exam_login_attempts enable row level security;
revoke all on public.exam_settings, public.exam_usage, public.exam_documents, public.exam_login_attempts from anon, authenticated;

-- 달마다 AI 를 부른 횟수와 요금 (한국 시간 기준 달)
create or replace function public.exam_usage_monthly(months integer default 12)
returns table (month text, calls bigint, usd numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select to_char(at at time zone 'Asia/Seoul', 'YYYY-MM') as month,
         count(*)::bigint as calls,
         coalesce(sum(usd), 0) as usd
  from public.exam_usage
  group by 1
  order by 1 desc
  limit greatest(months, 1);
$$;
revoke all on function public.exam_usage_monthly(integer) from public, anon, authenticated;
grant execute on function public.exam_usage_monthly(integer) to service_role;

-- 파일 보관함 (비공개, 파일 하나 50MB 까지)
insert into storage.buckets (id, name, public, file_size_limit)
values ('exam-files', 'exam-files', false, 52428800)
on conflict (id) do nothing;
