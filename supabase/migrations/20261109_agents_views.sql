-- ============================================================================
-- Кабинет агентской сети: витрины.
--
-- ЧЕТЫРЕ РЕШЕНИЯ, КОТОРЫЕ ЗДЕСЬ ЗАКРЕПЛЕНЫ.
--
-- 1. СЛУЖЕБНЫЕ ЭЛЕМЕНТЫ НЕ ЛЮДИ. «Агент не найден» и «Без агента» лежат в
--    тех же стадиях, что живые агенты, и в наполненность воронки не идут.
--    На день разработки «Агент не найден» был единственным в стадии «Фанат
--    (11+ клиентов)» — канбан показывал фаната, которого нет.
--
-- 2. «АГЕНТ НЕ НАЙДЕН» УЧИТЫВАЕТСЯ ТОЛЬКО ПРИ ПРЕФИКСЕ agbfl. Лид пришёл
--    через агента, но агента не опознали — выплата положена, считать надо.
--    Без ограничения по префиксу в агентскую статистику попал бы весь
--    поток, в котором поле просто забыли заполнить.
--
-- 3. «БЕЗ АГЕНТА» НЕ СЧИТАЕТСЯ ВОВСЕ. Это покупка самим агентом для себя
--    (например ВКИ). К приведённому отношения не имеет.
--
-- 4. ВЫХОД СО СТАДИИ НЕ ХРАНИТСЯ В БИТРИКСЕ, ЕГО НЕТ. Есть только вход.
--    Выход вычисляется: агент вошёл на следующую стадию — значит вышел с
--    предыдущей. Поэтому «−» на последней стадии всегда ноль, и это не
--    ошибка: уходить оттуда ещё некуда.
--
-- ВАЖНО ПРО ПРАВА. Внутренние витрины работают с правами владельца и
-- отобраны у клиентских ролей: кабинет читает их через обёртки
-- agents_portal_*. Вернёшь security_invoker — кабинет покажет нули, роль
-- agentlead доступа к базовым таблицам не имеет. Разбор той же ошибки —
-- в 20261019_rop_portal_chain.sql.
-- ============================================================================

-- --- Кто считается приведённым агентом --------------------------------------
--
-- Одно правило на все витрины. Если развести его по местам, через месяц в
-- воронке будет один состав, в таблице агентов другой, и сойтись они не
-- смогут никогда.
create or replace function agent_counts(вид text, префикс text)
returns boolean language sql immutable as $$
  select case вид
    when 'агент'      then true
    when 'не найден'  then префикс = 'agbfl'
    else false
  end;
$$;

comment on function agent_counts(text, text) is
  'Идёт ли строка в агентскую статистику. «Агент не найден» — только при '
  'agbfl: иначе туда попадёт весь поток с незаполненным полем.';

-- --- Текущая наполненность воронки ------------------------------------------
drop view if exists agent_funnel_now cascade;
create view agent_funnel_now as
select
  s.stage_id,
  s.name as стадия,
  s.sort_order,
  count(c.agent_id)::integer as агентов
from agent_stages s
left join agent_cards c on c.stage_id = s.stage_id and c.вид = 'агент'
where s.показывать
group by s.stage_id, s.name, s.sort_order;

revoke all on agent_funnel_now from anon, authenticated;

-- --- Движение по стадиям: вход и выход по дням ------------------------------
drop view if exists agent_stage_flow cascade;
create view agent_stage_flow as
with шаги as (
  select
    e.agent_id,
    e.stage_id,
    (e.created_time at time zone 'Europe/Moscow')::date as дата,
    lag(e.stage_id) over (partition by e.agent_id order by e.created_time, e.event_id) as откуда
  from agent_stage_events e
  join agent_cards c on c.agent_id = e.agent_id and c.вид = 'агент'
),
входы as (
  select дата, stage_id, count(*)::integer as вошло
  from шаги group by дата, stage_id
),
выходы as (
  -- Выход датируется днём, когда агент ушёл, а не днём, когда пришёл на
  -- прежнюю стадию: вопрос «что изменилось за неделю» именно про это.
  select дата, откуда as stage_id, count(*)::integer as вышло
  from шаги where откуда is not null group by дата, откуда
)
select
  coalesce(i.дата, o.дата) as дата,
  coalesce(i.stage_id, o.stage_id) as stage_id,
  coalesce(i.вошло, 0) as вошло,
  coalesce(o.вышло, 0) as вышло
from входы i
full outer join выходы o on o.дата = i.дата and o.stage_id = i.stage_id;

revoke all on agent_stage_flow from anon, authenticated;

-- --- Приведённое агентами по дням -------------------------------------------
--
-- КАЖДОЕ СОБЫТИЕ ДАТИРУЕТСЯ СВОИМ ДНЁМ, а не днём создания лида: лид по
-- дате создания, квал по дате квалификации, встреча по дате встречи,
-- сделка по дате оплаты. Ровно та же логика, по которой считается весь
-- управленческий учёт направления; иначе цифры кабинета не сойдутся с
-- остальным приложением.
--
-- Встречи приходят из bfl_meeting_timings по lead_id: у встречи своей
-- связи с агентом нет, она наследуется от лида.
drop view if exists agent_flow_daily cascade;
create view agent_flow_daily as
with события as (
  select (l.created_at at time zone 'Europe/Moscow')::date as дата,
         l.agent_id, agent_prefix(l.source_marker) as префикс,
         1 as лид, 0 as квал, 0 as встреча, 0 as сделка, 0::numeric as выручка
  from agent_leads l
  union all
  select (l.qualified_at at time zone 'Europe/Moscow')::date,
         l.agent_id, agent_prefix(l.source_marker), 0, 1, 0, 0, 0
  from agent_leads l where l.qualified_at is not null
  union all
  select (coalesce(m.scheduled_at, m.held_at) at time zone 'Europe/Moscow')::date,
         l.agent_id, agent_prefix(l.source_marker), 0, 0, 1, 0, 0
  from bfl_meeting_timings m
  join agent_leads l on l.lead_id = m.lead_id
  where m.stage_id = 'DT1044_64:SUCCESS'
    and coalesce(m.scheduled_at, m.held_at) is not null
  union all
  select (d.paid_at at time zone 'Europe/Moscow')::date,
         d.agent_id, agent_prefix(d.source_marker), 0, 0, 0, 1, coalesce(d.opportunity, 0)
  from agent_deals d where d.paid_at is not null
)
select
  е.дата,
  е.agent_id,
  coalesce(c.title, 'без карточки') as агент,
  c.вид,
  е.префикс,
  sum(е.лид)::integer as лиды,
  sum(е.квал)::integer as квалы,
  sum(е.встреча)::integer as встречи,
  sum(е.сделка)::integer as сделки,
  sum(е.выручка)::numeric as выручка
from события е
left join agent_cards c on c.agent_id = е.agent_id
where е.дата is not null
  and agent_counts(coalesce(c.вид, 'агент'), е.префикс)
group by е.дата, е.agent_id, c.title, c.вид, е.префикс;

revoke all on agent_flow_daily from anon, authenticated;

-- --- Просрочки по лидам ------------------------------------------------------
--
-- СЧИТАЕМ ПО ЛИДАМ, А НЕ ПО СДЕЛКАМ. Отсутствие сделок не делает агента
-- просроченным: он мог привести лид вчера, а сделка ещё в работе.
--
-- Агент, не передавший ни одного лида никогда, — это не просрочка на
-- девяносто дней, а человек, которого ни разу не активировали. Разговор
-- другой, поэтому и строка отдельная.
drop view if exists agent_overdue cascade;
create view agent_overdue as
select
  c.agent_id,
  c.title as агент,
  c.stage_id,
  s.name as стадия,
  c.created_time as заведён,
  max(l.created_at) as последний_лид,
  count(l.lead_id)::integer as лидов_всего,
  case
    when max(l.created_at) is null then null
    else (current_date - (max(l.created_at) at time zone 'Europe/Moscow')::date)
  end as дней_без_лида
from agent_cards c
left join agent_stages s on s.stage_id = c.stage_id
left join agent_leads l on l.agent_id = c.agent_id
where c.вид = 'агент'
group by c.agent_id, c.title, c.stage_id, s.name, c.created_time;

revoke all on agent_overdue from anon, authenticated;

-- ============================================================================
-- Обёртки кабинета
--
-- Руководитель сети не имеет политик ни на одной базовой таблице. Он видит
-- ровно эти пять витрин, и каждая сама решает, что отдать.
-- ============================================================================
drop view if exists agents_portal_funnel;
create view agents_portal_funnel as
select f.* from agent_funnel_now f where agents_can_read();
revoke all on agents_portal_funnel from anon;
grant select on agents_portal_funnel to authenticated;

drop view if exists agents_portal_flow;
create view agents_portal_flow as
select f.* from agent_stage_flow f where agents_can_read();
revoke all on agents_portal_flow from anon;
grant select on agents_portal_flow to authenticated;

drop view if exists agents_portal_daily;
create view agents_portal_daily as
select d.* from agent_flow_daily d where agents_can_read();
revoke all on agents_portal_daily from anon;
grant select on agents_portal_daily to authenticated;

drop view if exists agents_portal_overdue;
create view agents_portal_overdue as
select o.* from agent_overdue o where agents_can_read();
revoke all on agents_portal_overdue from anon;
grant select on agents_portal_overdue to authenticated;

drop view if exists agents_portal_stages;
create view agents_portal_stages as
select s.stage_id, s.name, s.sort_order, s.показывать
from agent_stages s where agents_can_read();
revoke all on agents_portal_stages from anon;
grant select on agents_portal_stages to authenticated;

-- ============================================================================
-- ПРОВЕРКИ ПОСЛЕ МИГРАЦИИ
--
-- 1. Наполненность воронки. Должна совпасть с канбаном Битрикса за вычетом
--    служебных: «Фанат» станет нулём, «Новый» уменьшится на единицу.
--
-- select стадия, агентов from agent_funnel_now order by sort_order;
--
-- 2. Движение за последние тридцать дней.
--
-- select stage_id, sum(вошло) as пришло, sum(вышло) as ушло
-- from agent_stage_flow where дата >= current_date - 30
-- group by stage_id order by 1;
--
-- 3. Приведённое за месяц по префиксам — та самая развёртка из ТЗ.
--
-- select префикс, sum(лиды), sum(квалы), sum(встречи), sum(сделки), sum(выручка)
-- from agent_flow_daily where дата >= date_trunc('month', current_date)::date
-- group by префикс order by 2 desc;
--
-- 4. Просрочки.
--
-- select
--   count(*) filter (where дней_без_лида > 30)  as более_30,
--   count(*) filter (where дней_без_лида > 60)  as более_60,
--   count(*) filter (where дней_без_лида > 90)  as более_90,
--   count(*) filter (where лидов_всего = 0)     as ни_одного_лида
-- from agent_overdue;
-- ============================================================================
