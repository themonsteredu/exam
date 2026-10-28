-- 기기(브라우저)마다 따로 두는 AI 열쇠와 모델, 열쇠별 요금 기록.
-- 여러 사람이 같은 프로그램을 쓰되 AI 요금은 각자 자기 열쇠로 내도록 (2026-10-28 사용자 요청).
-- device: 브라우저 쿠키 exam_device 값의 SHA-256 (쿠키 값 자체는 두지 않는다. lib/server/device.ts).
-- key_sealed: 저장 창구(exam-gateway)가 AES-GCM 으로 잠근 API 키.
-- key_tag: 같은 열쇠의 요금을 묶는 표시 (열쇠의 SHA-256 앞 32자리. 열쇠를 되살릴 수 없다).
-- RLS 를 켜고 정책을 두지 않는다: exam-gateway 가 서비스 열쇠로만 다룬다.

create table if not exists public.exam_devices (
  device text primary key check (device ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  key_sealed jsonb,
  key_last4 text,
  key_tag text check (key_tag is null or key_tag ~ '^[0-9a-f]{32}$'),
  key_saved_at timestamptz,
  models jsonb
);
alter table public.exam_devices enable row level security;
revoke all on public.exam_devices from anon, authenticated;

alter table public.exam_usage add column if not exists key_tag text;
create index if not exists exam_usage_key_tag_at_idx on public.exam_usage (key_tag, at);

-- 열쇠 하나로 달마다 AI 를 부른 횟수와 요금 (한국 시간 기준 달).
-- 예전의 "모두 합친" 함수 exam_usage_monthly(months) 는 지우지 않고 그대로 둔다 (지우는 문장이 있으면 적용할 때 사용자 허락 창이 뜬다.
-- 새 창구는 쓰지 않는다. 쓰는 곳이 없으니 나중에 지워도 된다)
create or replace function public.exam_usage_monthly_by_key(p_key_tag text, months integer default 12)
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
  where key_tag = p_key_tag
  group by 1
  order by 1 desc
  limit greatest(months, 1);
$$;
revoke all on function public.exam_usage_monthly_by_key(text, integer) from public, anon, authenticated;
grant execute on function public.exam_usage_monthly_by_key(text, integer) to service_role;
