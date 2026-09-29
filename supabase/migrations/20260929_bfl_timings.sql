-- ============================================================================
-- Вкладка «Зависимости» — сколько времени проходит между этапами воронки БФЛ.
--
-- ЗАЧЕМ ОТДЕЛЬНЫЕ ТАБЛИЦЫ. daily_facts хранит только агрегаты («за такой-то
-- день столько-то лидов и квалов»), по ним время между событиями посчитать
-- нельзя в принципе: непонятно, какой именно квал вырос из какого лида.
-- Поэтому тут — построчно, по одному лиду и одной встрече на строку, с
-- отметками времени.
--
-- ЧТО СЧИТАЕМ:
--   1. лид → квал      = qualified_at - created_at
--   2. квал → встреча  = held_at - qualified_at
--   3. лид → встреча   = held_at - created_at
--
-- К КАКОЙ НЕДЕЛЕ ОТНОСИМ. К неделе ЗАВЕРШАЮЩЕГО события: замер «лид → квал»
-- ложится на неделю квалификации, оба замера со встречей — на неделю встречи.
-- Так и просил: «собрать все встречи понедельно и понять, сколько времени
-- прошло от их квалификации». Для первого графика выбрана та же логика, иначе
-- три графика читались бы по-разному. Неделя — отчётная, чт–ср.
-- ============================================================================

create table if not exists bfl_lead_timings (
  lead_id bigint primary key,
  source_marker text,
  created_at timestamptz not null,
  qualified_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists bfl_lead_timings_qualified_idx on bfl_lead_timings(qualified_at);
create index if not exists bfl_lead_timings_created_idx on bfl_lead_timings(created_at);

create table if not exists bfl_meeting_timings (
  meeting_id bigint primary key,
  lead_id bigint,
  source_marker text,
  held_at timestamptz not null,
  synced_at timestamptz not null default now()
);

create index if not exists bfl_meeting_timings_lead_idx on bfl_meeting_timings(lead_id);
create index if not exists bfl_meeting_timings_held_idx on bfl_meeting_timings(held_at);

-- Курсор синхронизации — импорт идёт фазами и продолжается с сохранённой
-- позиции, как в направлении Автоправо.
create table if not exists bfl_timing_sync_state (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- Витрина: по неделе и метрике — среднее, медиана и объём выборки.
--
-- МЕДИАНА ЗДЕСЬ НЕ УКРАШЕНИЕ. Одного лида, отквалившегося через два месяца,
-- достаточно, чтобы средний срок за неделю подскочил вдвое. Если среднее
-- скачет, а медиана стоит на месте — проблема не в процессе, а в паре
-- выбросов, и искать причину надо в них. Если ползут оба — поехал процесс.
-- ============================================================================
drop view if exists bfl_timing_weekly;
create view bfl_timing_weekly with (security_invoker = true) as
with base as (
  select
    'lead_to_qual'::text as metric,
    (l.qualified_at at time zone 'Europe/Moscow')::date as event_date,
    extract(epoch from (l.qualified_at - l.created_at)) / 3600.0 as hours
  from bfl_lead_timings l
  where l.qualified_at is not null
    -- Отрицательный интервал — это битые данные в Битриксе (дата квала
    -- раньше даты создания лида). В среднее такое пускать нельзя.
    and l.qualified_at >= l.created_at

  union all

  select
    'qual_to_meeting',
    (m.held_at at time zone 'Europe/Moscow')::date,
    extract(epoch from (m.held_at - l.qualified_at)) / 3600.0
  from bfl_meeting_timings m
  join bfl_lead_timings l on l.lead_id = m.lead_id
  where l.qualified_at is not null
    and m.held_at >= l.qualified_at

  union all

  select
    'lead_to_meeting',
    (m.held_at at time zone 'Europe/Moscow')::date,
    extract(epoch from (m.held_at - l.created_at)) / 3600.0
  from bfl_meeting_timings m
  join bfl_lead_timings l on l.lead_id = m.lead_id
  where m.held_at >= l.created_at
)
select
  metric,
  event_date - (extract(dow from event_date)::integer + 3) % 7 as week_start,
  count(*)::integer as n,
  round(avg(hours)::numeric, 1) as avg_hours,
  round((percentile_cont(0.5) within group (order by hours))::numeric, 1) as median_hours,
  round((percentile_cont(0.9) within group (order by hours))::numeric, 1) as p90_hours
from base
group by 1, 2;

-- ============================================================================
-- RLS — как у всех остальных таблиц приложения: читает любой залогиненный,
-- пишет только admin. Edge Function ходит через service_role и RLS не
-- подчиняется.
-- ============================================================================
do $$
declare
  tbl text;
  tables text[] := array['bfl_lead_timings', 'bfl_meeting_timings', 'bfl_timing_sync_state'];
begin
  foreach tbl in array tables loop
    execute format('alter table if exists %I enable row level security', tbl);
    execute format('drop policy if exists "authenticated_select" on %I', tbl);
    execute format('create policy "authenticated_select" on %I for select using (auth.uid() is not null)', tbl);
    execute format('drop policy if exists "admin_write" on %I', tbl);
    execute format('create policy "admin_write" on %I for all using (is_admin()) with check (is_admin())', tbl);
  end loop;
end $$;
