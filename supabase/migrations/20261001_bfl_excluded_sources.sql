-- ============================================================================
-- Источники, исключаемые из статистики воронки лидов.
--
-- ЗАЧЕМ ОТДЕЛЬНОЙ ТАБЛИЦЕЙ, а не условием в запросе: исключение — это не
-- технический костыль, а решение о данных, и его надо хранить вместе с
-- причиной. Иначе через месяц никто не вспомнит, почему в отчёте нет
-- полутора тысяч лидов, и кто-то «починит» это обратно.
--
-- ВАЖНО, НА ЧТО ИСКЛЮЧЕНИЕ НЕ РАСПРОСТРАНЯЕТСЯ. Фильтруются только витрины
-- про воронку лидов и дозвон — там спам реально искажает картину. Витрины
-- по встречам (bfl_timing_weekly, доходимость, переназначения) не трогаем:
-- если лид из такого источника дошёл до встречи, встреча была настоящей, и
-- выкидывать её — значит портить верные данные ради чистки неверных.
-- ============================================================================

create table if not exists bfl_excluded_sources (
  source_marker text primary key,
  reason text not null,
  excluded_at timestamptz not null default now()
);

alter table bfl_excluded_sources enable row level security;
drop policy if exists "authenticated_select" on bfl_excluded_sources;
create policy "authenticated_select" on bfl_excluded_sources for select using (auth.uid() is not null);
drop policy if exists "admin_write" on bfl_excluded_sources;
create policy "admin_write" on bfl_excluded_sources for all using (is_admin()) with check (is_admin());

insert into bfl_excluded_sources (source_marker, reason) values (
  'ofbfl-КО1 Сотовый Опора (перезвон)',
  'Атрибуция по входящему номеру. В периоде были спам-атаки парсеров, ' ||
  'из-за чего источник давал массу автоматических звонков. Конверсия ' ||
  'недозвона по нему 2,0% при 16,1% по остальным — это шум, а не работа отдела.'
) on conflict (source_marker) do nothing;

-- ============================================================================
-- Пересобираем витрины воронки с учётом исключений
-- ============================================================================

drop view if exists bfl_stage_outcomes;
create view bfl_stage_outcomes with (security_invoker = true) as
with entered as (
  select h.lead_id, h.status_id, h.status_name, min(h.entered_at) as first_in
  from bfl_lead_stage_history h
  join bfl_lead_timings l on l.lead_id = h.lead_id
  where l.source_marker is null
     or l.source_marker not in (select source_marker from bfl_excluded_sources)
  group by h.lead_id, h.status_id, h.status_name
),
joined as (
  select
    e.status_id, e.status_name, e.first_in,
    (q.qual_at is not null and q.qual_at > e.first_in) as reached_qual,
    extract(epoch from (q.qual_at - e.first_in)) / 3600.0 as hours_to_qual
  from entered e
  left join bfl_lead_qual_moment q on q.lead_id = e.lead_id
)
select
  status_id,
  status_name,
  count(*)::integer as вошло_лидов,
  count(*) filter (where reached_qual)::integer as дошли_до_квала,
  round(100.0 * count(*) filter (where reached_qual) / nullif(count(*), 0), 1) as конверсия_в_квал,
  round((percentile_cont(0.5) within group (
    order by case when reached_qual then hours_to_qual end))::numeric, 1) as медиана_часов_до_квала,
  min(first_in) as первый_вход,
  max(first_in) as последний_вход
from joined
group by 1, 2;

drop view if exists bfl_stage_dead_ends;
create view bfl_stage_dead_ends with (security_invoker = true) as
with entered as (
  select h.lead_id, h.status_id, h.status_name, min(h.entered_at) as first_in
  from bfl_lead_stage_history h
  join bfl_lead_timings l on l.lead_id = h.lead_id
  where l.source_marker is null
     or l.source_marker not in (select source_marker from bfl_excluded_sources)
  group by h.lead_id, h.status_id, h.status_name
)
select
  e.status_name as вошёл_в_стадию,
  coalesce(l.status_name, '—') as сейчас_стоит_на,
  count(*)::integer as лидов
from entered e
join bfl_lead_timings l on l.lead_id = e.lead_id
left join bfl_lead_qual_moment q on q.lead_id = e.lead_id
where e.status_id in ('11', '23', 'UC_GKWGR0')
  and (q.qual_at is null or q.qual_at <= e.first_in)
group by 1, 2;

drop view if exists bfl_stage_outcomes_by_source;
create view bfl_stage_outcomes_by_source with (security_invoker = true) as
with entered as (
  select h.lead_id, h.status_id, h.status_name, l.source_marker, min(h.entered_at) as first_in
  from bfl_lead_stage_history h
  join bfl_lead_timings l on l.lead_id = h.lead_id
  where l.source_marker is not null
    and l.source_marker not in (select source_marker from bfl_excluded_sources)
  group by h.lead_id, h.status_id, h.status_name, l.source_marker
)
select
  e.source_marker as источник,
  e.status_name as стадия,
  count(*)::integer as вошло,
  count(*) filter (where q.qual_at is not null and q.qual_at > e.first_in)::integer as дошли_до_квала,
  round(
    100.0 * count(*) filter (where q.qual_at is not null and q.qual_at > e.first_in)
    / nullif(count(*), 0)
  , 1) as конверсия_в_квал
from entered e
left join bfl_lead_qual_moment q on q.lead_id = e.lead_id
where e.status_id in ('11', '23', 'UC_GKWGR0')
group by 1, 2;

drop view if exists bfl_stage_dwell;
create view bfl_stage_dwell with (security_invoker = true) as
with last_in as (
  select h.lead_id, h.status_id, max(h.entered_at) as last_entered
  from bfl_lead_stage_history h
  group by h.lead_id, h.status_id
)
select
  l.status_name as стадия_сейчас,
  count(*)::integer as лидов,
  round(avg(extract(epoch from (now() - li.last_entered)) / 86400.0))::integer as средний_возраст_дней,
  round((percentile_cont(0.5) within group (
    order by extract(epoch from (now() - li.last_entered)) / 86400.0))::numeric, 1) as медиана_дней,
  count(*) filter (where now() - li.last_entered > interval '14 days')::integer as висят_больше_14_дней
from bfl_lead_timings l
join last_in li on li.lead_id = l.lead_id and li.status_id = l.status_id
where l.source_marker is null
   or l.source_marker not in (select source_marker from bfl_excluded_sources)
group by 1;

-- ============================================================================
-- Снимок воронки по текущим стадиям — тоже с исключениями, чтобы цифры в
-- отчётах не разъезжались с витринами выше.
-- ============================================================================
drop view if exists bfl_lead_funnel_snapshot;
create view bfl_lead_funnel_snapshot with (security_invoker = true) as
select
  coalesce(status_name, '— без стадии —') as стадия,
  count(*)::integer as лидов,
  count(qualified_at)::integer as из_них_квалов,
  round(100.0 * count(qualified_at) / nullif(count(*), 0), 1) as доля_квалов
from bfl_lead_timings
where source_marker is null
   or source_marker not in (select source_marker from bfl_excluded_sources)
group by 1;
