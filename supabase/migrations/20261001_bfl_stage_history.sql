-- ============================================================================
-- История стадий воронки лидов БФЛ.
--
-- ЗАЧЕМ. Снимок текущих стадий показывает ЗАПАС, а не ПОТОК: лид, которого
-- вытащили из недозвона, сейчас стоит на другой стадии, и в статистике
-- недозвона его не видно. Поэтому по снимку нельзя ответить на главный
-- вопрос — какая доля вошедших в стадию доходит до квала.
--
-- Квалом считается вход в стадию «Назначение встречи» (STATUS_ID = 12):
-- проверено на снимке — у всех лидов на этой стадии и дальше дата
-- квалификации заполнена (769 из 769), а на предыдущих её нет ни у кого.
--
-- КЛЮЧЕВЫЕ СТАДИИ, ради которых всё затевается:
--   11          Не удалось дозвониться — ручной обзвон, окно 5 дней
--   23          Скорозвон              — очередь робота после этих 5 дней
--   UC_GKWGR0   Дозвонились            — подняли трубку, но квала ещё нет
--   12          Назначение встречи     — КВАЛ
--   19          Не отвечает более месяца (Архив) — терминальный выход
-- ============================================================================

create table if not exists bfl_lead_stage_history (
  id bigint primary key,
  lead_id bigint not null,
  status_id text not null,
  status_name text,
  entered_at timestamptz not null,
  synced_at timestamptz not null default now()
);

create index if not exists bfl_lsh_lead_idx on bfl_lead_stage_history(lead_id);
create index if not exists bfl_lsh_status_idx on bfl_lead_stage_history(status_id);
create index if not exists bfl_lsh_entered_idx on bfl_lead_stage_history(entered_at);

create table if not exists bfl_stage_sync_state (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

-- Вход в квал: самый ранний момент, когда лид попал на «Назначение встречи»
-- или дальше по воронке.
create or replace view bfl_lead_qual_moment with (security_invoker = true) as
select lead_id, min(entered_at) as qual_at
from bfl_lead_stage_history
where status_id in ('12', '13', 'CONVERTED')
group by lead_id;

-- ============================================================================
-- Главная витрина: вошёл в стадию → дошёл ли до квала
--
-- Квал засчитывается только если он случился ПОСЛЕ входа в стадию. Иначе
-- лид, который отквалился, а потом откатился в недозвон, ложно улучшал бы
-- статистику недозвона.
-- ============================================================================
drop view if exists bfl_stage_outcomes;
create view bfl_stage_outcomes with (security_invoker = true) as
with entered as (
  select h.lead_id, h.status_id, h.status_name, min(h.entered_at) as first_in
  from bfl_lead_stage_history h
  -- только лиды БФЛ: в истории лежат все подряд
  join bfl_lead_timings l on l.lead_id = h.lead_id
  group by h.lead_id, h.status_id, h.status_name
),
joined as (
  select
    e.status_id,
    e.status_name,
    e.lead_id,
    e.first_in,
    q.qual_at,
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

-- ============================================================================
-- Где осели те, кто вошёл в стадию и до квала не дошёл
-- ============================================================================
drop view if exists bfl_stage_dead_ends;
create view bfl_stage_dead_ends with (security_invoker = true) as
with entered as (
  select h.lead_id, h.status_id, h.status_name, min(h.entered_at) as first_in
  from bfl_lead_stage_history h
  join bfl_lead_timings l on l.lead_id = h.lead_id
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

-- ============================================================================
-- Конверсия ключевых стадий в квал — по источникам
--
-- Нужна, чтобы отличить «плохо обзваниваем» от «плохие номера»: если
-- провал ровный по всем источникам — дело в процессе, если привязан к
-- источнику — дело в лидах.
-- ============================================================================
drop view if exists bfl_stage_outcomes_by_source;
create view bfl_stage_outcomes_by_source with (security_invoker = true) as
with entered as (
  select h.lead_id, h.status_id, h.status_name, l.source_marker, min(h.entered_at) as first_in
  from bfl_lead_stage_history h
  join bfl_lead_timings l on l.lead_id = h.lead_id
  where l.source_marker is not null
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

-- ============================================================================
-- Сколько лидов сидит в стадии прямо сейчас и как давно туда попали.
-- Главная цель — «Дозвонились»: если там застревают надолго, это свалка.
-- ============================================================================
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
group by 1;

-- ============================================================================
-- RLS
-- ============================================================================
do $$
declare
  tbl text;
  tables text[] := array['bfl_lead_stage_history', 'bfl_stage_sync_state'];
begin
  foreach tbl in array tables loop
    execute format('alter table if exists %I enable row level security', tbl);
    execute format('drop policy if exists "authenticated_select" on %I', tbl);
    execute format('create policy "authenticated_select" on %I for select using (auth.uid() is not null)', tbl);
    execute format('drop policy if exists "admin_write" on %I', tbl);
    execute format('create policy "admin_write" on %I for all using (is_admin()) with check (is_admin())', tbl);
  end loop;
end $$;
