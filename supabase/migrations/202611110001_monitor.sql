-- Target: uniagent-monitor only. No credentials or initial administrator identities.
begin;
create schema if not exists monitor_private;
revoke all on schema monitor_private from public, anon, authenticated;

create table if not exists public.monitor_events (
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null,
  schema_version integer not null check (schema_version = 1),
  category text not null check (category in ('diagnostic', 'performance')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  distribution text not null check (distribution in ('internal', 'public')),
  app_version text not null,
  agent_id text not null,
  code text not null,
  level text not null check (level in ('info', 'warn', 'error')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (owner_id, event_id)
);
create index if not exists monitor_events_time on public.monitor_events (occurred_at desc);
create index if not exists monitor_events_received on public.monitor_events (received_at);

create table if not exists public.monitor_router_feedback (
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null,
  request_key text not null check (request_key ~ '^[a-f0-9]{64}$'),
  attempt_key text not null check (attempt_key ~ '^[a-f0-9]{64}$'),
  revision integer not null check (revision > 0),
  saved_at timestamptz not null,
  received_at timestamptz not null default now(),
  distribution text not null check (distribution in ('internal', 'public')),
  app_version text not null,
  matches boolean not null,
  reason text,
  actual_action text not null,
  expected_kind text,
  primary key (owner_id, event_id),
  unique (owner_id, request_key, attempt_key, revision)
);
create index if not exists monitor_feedback_time on public.monitor_router_feedback (saved_at desc);
create index if not exists monitor_feedback_received on public.monitor_router_feedback (received_at);

create table if not exists public.monitor_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists monitor_private.monitor_ingest_quota (
  owner_id uuid not null,
  day date not null,
  record_count bigint not null default 0,
  bytes bigint not null default 0,
  primary key (owner_id, day)
);

alter table public.monitor_events enable row level security;
alter table public.monitor_router_feedback enable row level security;
alter table public.monitor_admins enable row level security;
alter table monitor_private.monitor_ingest_quota enable row level security;
revoke all on public.monitor_events, public.monitor_router_feedback, public.monitor_admins from public, anon, authenticated;
revoke all on monitor_private.monitor_ingest_quota from public, anon, authenticated;
grant select on public.monitor_events, public.monitor_router_feedback, public.monitor_admins to authenticated;
grant all on public.monitor_events, public.monitor_router_feedback, public.monitor_admins to service_role;

create or replace function public.monitor_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select not coalesce((auth.jwt()->>'is_anonymous')::boolean, true)
    and exists (select 1 from public.monitor_admins a where a.user_id = auth.uid());
$$;
revoke all on function public.monitor_is_admin() from public, anon;
grant execute on function public.monitor_is_admin() to authenticated, service_role;

drop policy if exists monitor_events_admin_read on public.monitor_events;
create policy monitor_events_admin_read on public.monitor_events for select to authenticated using ((select public.monitor_is_admin()));
drop policy if exists monitor_feedback_admin_read on public.monitor_router_feedback;
create policy monitor_feedback_admin_read on public.monitor_router_feedback for select to authenticated using ((select public.monitor_is_admin()));
drop policy if exists monitor_admin_self_read on public.monitor_admins;
create policy monitor_admin_self_read on public.monitor_admins for select to authenticated using (user_id = auth.uid() and not coalesce((auth.jwt()->>'is_anonymous')::boolean, true));

create or replace function monitor_private.valid_record(r jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare c text; p jsonb; k text; v jsonb; allowed text[];
begin
  if jsonb_typeof(r) <> 'object' or not (r ?& array['schemaVersion','eventId','category','occurredAt','distribution','appVersion','agentId','code','level','payload']) then return false; end if;
  if exists (select 1 from jsonb_object_keys(r) t(k) where not t.k = any(array['schemaVersion','eventId','category','occurredAt','distribution','appVersion','agentId','code','level','payload'])) then return false; end if;
  c := r->>'category'; p := r->'payload';
  foreach k in array array['eventId','category','distribution','appVersion','agentId','code','level'] loop
    if jsonb_typeof(r->k) <> 'string' then return false; end if;
  end loop;
  if r->'schemaVersion' <> '1'::jsonb or c not in ('diagnostic','performance','router_feedback') or jsonb_typeof(p) <> 'object'
    or r->>'distribution' not in ('internal','public') or r->>'level' not in ('info','warn','error')
    or jsonb_typeof(r->'occurredAt') <> 'number' or (r->>'occurredAt')::numeric <> trunc((r->>'occurredAt')::numeric)
    or (r->>'occurredAt')::numeric < 1577836800000
    or r->>'eventId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    or r->>'appVersion' !~ '^[a-zA-Z0-9_.+-]{1,64}$' or r->>'agentId' !~ '^[a-zA-Z0-9_.:-]{1,80}$'
    or r->>'code' !~ '^[a-zA-Z0-9_.:-]{1,80}$' or octet_length(r::text) > 16384 then return false; end if;
  allowed := case c when 'diagnostic' then array['message','source','count']
    when 'performance' then array['cpuPercent','rssBytes','heapBytes','mainHeartbeatAgeMs','eventLoopDelayMs','longestMs','totalMs','count','windowShownMs','uiReadyMs','initializedMs','durationMs']
    else array['requestKey','attemptKey','revision','matches','reason','actualAction','expectedKind'] end;
  for k,v in select * from jsonb_each(p) loop
    if not k = any(allowed) or jsonb_typeof(v) not in ('string','number','boolean') then return false; end if;
    if jsonb_typeof(v) = 'string' and length(v #>> '{}') > 2000 then return false; end if;
    if jsonb_typeof(v) = 'number' and ((v::text)::numeric < 0 or (v::text)::numeric > 1125899906842624) then return false; end if;
  end loop;
  if c = 'diagnostic' then
    return p ?& array['message','source','count'] and jsonb_typeof(p->'message') = 'string' and jsonb_typeof(p->'source') = 'string'
      and jsonb_typeof(p->'count') = 'number' and (p->>'count')::numeric >= 1 and (p->>'count')::numeric = trunc((p->>'count')::numeric);
  elsif c = 'performance' then
    return p <> '{}'::jsonb and not exists (select 1 from jsonb_each(p) t(k,v) where jsonb_typeof(t.v) <> 'number');
  end if;
  return p ?& array['requestKey','attemptKey','revision','matches','actualAction']
    and p->>'requestKey' ~ '^[a-f0-9]{64}$' and p->>'attemptKey' ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(p->'revision') = 'number' and (p->>'revision')::numeric between 1 and 2147483647
    and (p->>'revision')::numeric = trunc((p->>'revision')::numeric)
    and jsonb_typeof(p->'matches') = 'boolean'
    and p->>'actualAction' in ('reuse_task','create_task_in_requirement','create_task_in_space','create_requirement_and_task','clarify','unknown')
    and (not p ? 'expectedKind' or p->>'expectedKind' in ('create_task','reuse_task','create_requirement'))
    and (not p ? 'reason' or jsonb_typeof(p->'reason') = 'string');
exception when others then return false;
end;
$$;
revoke all on function monitor_private.valid_record(jsonb) from public, anon, authenticated;

create or replace function public.monitor_ingest(p_owner uuid, p_records jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb; p jsonb; eid uuid; size_bytes bigint; own_bytes bigint; total_bytes bigint;
  today date := (now() at time zone 'UTC')::date;
  global_owner uuid := '00000000-0000-0000-0000-000000000000';
  accepted jsonb := '[]'; duplicates jsonb := '[]'; rejected jsonb := '[]'; limited jsonb := '[]';
begin
  if p_owner is null or p_owner = global_owner or not exists(select 1 from auth.users where id = p_owner) then raise exception 'invalid_owner' using errcode = '22023'; end if;
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) not between 1 and 50 or octet_length(p_records::text) > 262144 then raise exception 'invalid_batch' using errcode = '22023'; end if;
  insert into monitor_private.monitor_ingest_quota(owner_id,day) values (global_owner,today),(p_owner,today) on conflict do nothing;
  -- A fixed lock order prevents concurrent requests from bypassing the shared budget.
  perform 1 from monitor_private.monitor_ingest_quota where day = today and owner_id in (global_owner,p_owner) order by owner_id for update;
  select bytes into own_bytes from monitor_private.monitor_ingest_quota where owner_id = p_owner and day = today;
  select bytes into total_bytes from monitor_private.monitor_ingest_quota where owner_id = global_owner and day = today;
  for r in select * from jsonb_array_elements(p_records) loop
    if not coalesce(monitor_private.valid_record(r), false) or (r->>'occurredAt')::numeric > extract(epoch from now())*1000 + 300000 then
      rejected := rejected || jsonb_build_array(r->>'eventId'); continue;
    end if;
    eid := (r->>'eventId')::uuid; p := r->'payload';
    if exists(select 1 from public.monitor_events where owner_id = p_owner and event_id = eid)
      or exists(select 1 from public.monitor_router_feedback where owner_id = p_owner and (event_id = eid
        or (r->>'category' = 'router_feedback' and request_key = p->>'requestKey' and attempt_key = p->>'attemptKey' and revision = (p->>'revision')::integer))) then
      duplicates := duplicates || jsonb_build_array(eid); continue;
    end if;
    size_bytes := octet_length(r::text);
    if own_bytes + size_bytes > 1048576 or total_bytes + size_bytes > 5242880 then limited := limited || jsonb_build_array(eid); continue; end if;
    if r->>'category' = 'router_feedback' then
      insert into public.monitor_router_feedback(owner_id,event_id,request_key,attempt_key,revision,saved_at,distribution,app_version,matches,reason,actual_action,expected_kind)
        values(p_owner,eid,p->>'requestKey',p->>'attemptKey',(p->>'revision')::integer,to_timestamp((r->>'occurredAt')::double precision/1000),r->>'distribution',r->>'appVersion',(p->>'matches')::boolean,p->>'reason',p->>'actualAction',p->>'expectedKind');
    else
      insert into public.monitor_events(owner_id,event_id,schema_version,category,occurred_at,distribution,app_version,agent_id,code,level,payload)
        values(p_owner,eid,1,r->>'category',to_timestamp((r->>'occurredAt')::double precision/1000),r->>'distribution',r->>'appVersion',r->>'agentId',r->>'code',r->>'level',p);
    end if;
    own_bytes := own_bytes + size_bytes; total_bytes := total_bytes + size_bytes;
    accepted := accepted || jsonb_build_array(eid);
  end loop;
  update monitor_private.monitor_ingest_quota set bytes = own_bytes, record_count = record_count + jsonb_array_length(accepted) where owner_id = p_owner and day = today;
  update monitor_private.monitor_ingest_quota set bytes = total_bytes, record_count = record_count + jsonb_array_length(accepted) where owner_id = global_owner and day = today;
  return jsonb_build_object('accepted',accepted,'duplicates',duplicates,'rejected',rejected,'limited',limited,'retryAfter',greatest(1,extract(epoch from ((today + 1)::timestamp at time zone 'UTC') - now())::integer));
end;
$$;
revoke all on function public.monitor_ingest(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.monitor_ingest(uuid,jsonb) to service_role;

create or replace view public.monitor_latest_feedback with (security_invoker = true) as
  select distinct on (owner_id,request_key,attempt_key) * from public.monitor_router_feedback
  order by owner_id,request_key,attempt_key,revision desc;
revoke all on public.monitor_latest_feedback from public, anon;
grant select on public.monitor_latest_feedback to authenticated;

create or replace function public.monitor_stats(p_since timestamptz, p_distribution text default null, p_version text default null) returns jsonb
language plpgsql stable set search_path = '' as $$
declare result jsonb;
begin
  if not public.monitor_is_admin() then raise exception 'monitor_admin_required' using errcode = '42501'; end if;
  if p_since is null or p_since < now()-interval '30 days 5 minutes' or p_since > now() then raise exception 'invalid_window' using errcode = '22023'; end if;
  with events as (
    select * from public.monitor_events where occurred_at >= p_since and (p_distribution is null or distribution = p_distribution) and (p_version is null or app_version = p_version)
  ), latest as (
    select distinct on (owner_id,request_key,attempt_key) * from public.monitor_router_feedback
    order by owner_id,request_key,attempt_key,revision desc
  ), feedback as (
    select * from latest where saved_at >= p_since and (p_distribution is null or distribution = p_distribution) and (p_version is null or app_version = p_version)
  ), installations as (
    select owner_id from events union select owner_id from feedback
  ), days as (
    select generate_series(date_trunc('day',p_since at time zone 'UTC'),date_trunc('day',now() at time zone 'UTC'),interval '1 day')::date as day
  ), daily as (
    select days.day,count(events.event_id) as count from days left join events
      on (events.occurred_at at time zone 'UTC')::date=days.day and events.level='error' group by days.day order by days.day
  ) select jsonb_build_object('installations',(select count(*) from installations),'errors',(select count(*) from events where level = 'error'),
    'feedback',(select count(*) from feedback),'good',(select count(*) from feedback where matches),'bad',(select count(*) from feedback where not matches),
    'daily',coalesce((select jsonb_agg(jsonb_build_object('day',day,'count',count)) from daily),'[]'::jsonb)) into result;
  return result;
end;
$$;
revoke all on function public.monitor_stats(timestamptz,text,text) from public, anon;
grant execute on function public.monitor_stats(timestamptz,text,text) to authenticated;

create or replace function public.monitor_feedback_page(p_since timestamptz,p_distribution text default null,p_version text default null,p_verdict text default null,p_search text default '',p_offset integer default 0) returns jsonb
language plpgsql stable set search_path = '' as $$
declare result jsonb;
begin
  if not public.monitor_is_admin() then raise exception 'monitor_admin_required' using errcode = '42501'; end if;
  if p_since is null or p_since < now()-interval '30 days 5 minutes' or p_since > now() or p_offset < 0 or p_offset > 1000000 or length(p_search) > 200 or p_verdict not in ('good','bad') then raise exception 'invalid_query' using errcode = '22023'; end if;
  with filtered as (
    select * from public.monitor_latest_feedback where saved_at >= p_since
      and (p_distribution is null or distribution = p_distribution) and (p_version is null or app_version = p_version)
      and (p_verdict is null or matches = (p_verdict = 'good')) and strpos(lower(coalesce(reason,'')),lower(coalesce(p_search,''))) > 0
  ), page as (select * from filtered order by saved_at desc,owner_id,event_id limit 50 offset p_offset)
  select jsonb_build_object('total',(select count(*) from filtered),'rows',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb)) into result;
  return result;
end;
$$;
revoke all on function public.monitor_feedback_page(timestamptz,text,text,text,text,integer) from public,anon;
grant execute on function public.monitor_feedback_page(timestamptz,text,text,text,text,integer) to authenticated;

create or replace function public.monitor_log_page(p_since timestamptz,p_distribution text default null,p_version text default null,p_category text default null,p_search text default '',p_offset integer default 0) returns jsonb
language plpgsql stable set search_path = '' as $$
declare result jsonb;
begin
  if not public.monitor_is_admin() then raise exception 'monitor_admin_required' using errcode = '42501'; end if;
  if p_since is null or p_since < now()-interval '30 days 5 minutes' or p_since > now() or p_offset < 0 or p_offset > 1000000 or length(p_search) > 200 or p_category not in ('diagnostic','performance') then raise exception 'invalid_query' using errcode = '22023'; end if;
  with filtered as (
    select * from public.monitor_events where occurred_at >= p_since
      and (p_distribution is null or distribution = p_distribution) and (p_version is null or app_version = p_version)
      and (p_category is null or category = p_category) and strpos(lower(code || ' ' || coalesce(payload->>'message','')),lower(coalesce(p_search,''))) > 0
  ), page as (select * from filtered order by occurred_at desc,owner_id,event_id limit 50 offset p_offset)
  select jsonb_build_object('total',(select count(*) from filtered),'rows',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb)) into result;
  return result;
end;
$$;
revoke all on function public.monitor_log_page(timestamptz,text,text,text,text,integer) from public,anon;
grant execute on function public.monitor_log_page(timestamptz,text,text,text,text,integer) to authenticated;

create or replace function public.monitor_feedback_history(p_owner uuid,p_request text,p_attempt text) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  if not public.monitor_is_admin() then raise exception 'monitor_admin_required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(t)) from (select * from public.monitor_router_feedback
    where owner_id=p_owner and request_key=p_request and attempt_key=p_attempt order by revision desc limit 100) t),'[]'::jsonb);
end;
$$;
revoke all on function public.monitor_feedback_history(uuid,text,text) from public,anon;
grant execute on function public.monitor_feedback_history(uuid,text,text) to authenticated;

create or replace function public.monitor_prune() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.monitor_events where received_at < now()-interval '7 days';
  delete from public.monitor_router_feedback where received_at < now()-interval '180 days';
  delete from monitor_private.monitor_ingest_quota where day < (now() at time zone 'UTC')::date-7;
end;
$$;
revoke all on function public.monitor_prune() from public, anon, authenticated;
grant execute on function public.monitor_prune() to service_role;
commit;
