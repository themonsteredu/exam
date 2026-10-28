-- 로그인 시도 제한 (시험지 만들기 앱 exam).
-- 시도를 먼저 "틀림" 으로 적고 나서 비밀번호를 확인한다. 맞으면 exam-gateway 가 그 줄을 ok = true 로 바꾼다.
-- 시도들을 한 줄로 세워서(advisory lock) 한꺼번에 많이 보내도 횟수 제한을 건너뛰지 못하게 한다.
-- 제한: 같은 곳(IP)에서 15분에 10번, 모두 합쳐 15분에 50번, 24시간에 200번 틀리면 막는다 (막힌 시도는 적지 않는다).
create or replace function public.exam_login_begin(p_ip text)
returns table (attempt_id bigint, ip_recent integer, all_recent integer, all_day integer)
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_ip text := left(coalesce(p_ip, ''), 100);
  v_id bigint;
  v_ip_recent integer;
  v_all_recent integer;
  v_all_day integer;
begin
  perform pg_advisory_xact_lock(hashtext('exam_login_begin'));
  select count(*) filter (where ip = v_ip and at >= now() - interval '15 minutes'),
         count(*) filter (where at >= now() - interval '15 minutes'),
         count(*)
    into v_ip_recent, v_all_recent, v_all_day
    from public.exam_login_attempts
   where not ok and at >= now() - interval '24 hours';
  if v_ip_recent >= 10 or v_all_recent >= 50 or v_all_day >= 200 then
    return query select null::bigint, v_ip_recent, v_all_recent, v_all_day;
    return;
  end if;
  insert into public.exam_login_attempts (ok, ip) values (false, v_ip) returning id into v_id;
  -- 오래된 기록은 가끔 지운다 (30일)
  if random() < 0.02 then
    delete from public.exam_login_attempts where at < now() - interval '30 days';
  end if;
  return query select v_id, v_ip_recent, v_all_recent, v_all_day;
end;
$$;
revoke all on function public.exam_login_begin(text) from public, anon, authenticated;
grant execute on function public.exam_login_begin(text) to service_role;
