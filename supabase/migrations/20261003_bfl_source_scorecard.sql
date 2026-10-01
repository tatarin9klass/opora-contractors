-- ============================================================================
-- Источники: качество разговора рядом с ценой, только по активным.
--
-- ЗАЧЕМ. Самый крупный найденный рычаг — состав источников: конверсия
-- разговора в квал по ним различается втрое (25,7% у Lead.Force против 84,0%
-- у Lbfl), тогда как между менеджерами разброс всего 4,8 пункта. Но решение
-- о бюджете принимается не по конверсии, а по стоимости квала, а расходы
-- лежали отдельно от данных по звонкам и никогда с ними не соединялись.
--
-- ТОЛЬКО АКТИВНЫЕ. По указанию руководителя направления берём лишь источники,
-- помеченные в приложении как активные: по отключённым считать нечего, а в
-- выборке они создают видимость проблем, которых уже нет. Так было с ПРД и
-- Макаровым — обоих отключили, а они продолжали всплывать в таблицах.
--
-- СВЯЗКА. source_marker в данных по лидам БФЛ соответствует roistat_marker в
-- таблице sources — по нему же их сопоставляет и основной импорт. Сравнение
-- регистронезависимое, ровно как там.
--
-- ПРО РАСХОД. Он привязан к подрядчику, а не к источнику: в weekly_expenses
-- ключ — contractor_id и неделя. У подрядчика бывает несколько источников, и
-- разнести его расход между ними нечем. Поэтому стоимость квала считается на
-- уровне ПОДРЯДЧИКА, а качество разговора — на уровне источника. Складывать
-- их в одну строку было бы подлогом.
-- ============================================================================

-- ============================================================================
-- Активные источники БФЛ и их подрядчики
-- ============================================================================
drop view if exists bfl_active_sources cascade;
create view bfl_active_sources with (security_invoker = true) as
select
  lower(s.roistat_marker) as marker_lower,
  s.roistat_marker as источник,
  s.contractor_id,
  c.name as подрядчик
from sources s
join contractors c on c.id = s.contractor_id
where s.status = 'активен'
  and s.roistat_marker is not null;

-- ============================================================================
-- Скоринг источника: от лида до квала
--
-- Три величины рядом, потому что они отвечают на разные вопросы:
--   доля достигнутых    — можно ли вообще дозвониться по этим номерам;
--   доля разговоров     — выходит ли из дозвона разговор по делу;
--   конверсия разговора — чего стоит этот разговор.
-- Источник может быть плохим по любой из трёх причин, и лечатся они разным.
-- ============================================================================
drop view if exists bfl_source_scorecard;
create view bfl_source_scorecard with (security_invoker = true) as
with per_lead as (
  select
    l.lead_id,
    l.source_marker,
    count(c.id) filter (where bfl_call_is_attempt(c.direction, c.completed))::integer as попыток,
    count(c.id) filter (
      where bfl_call_is_attempt(c.direction, c.completed)
        and bfl_call_answered(c.has_recording, c.duration_sec)
    )::integer as дозвонов,
    count(c.id) filter (
      where bfl_call_is_attempt(c.direction, c.completed)
        and bfl_call_dialogue(c.has_recording, c.duration_sec)
    )::integer as разговоров,
    (l.qualified_at is not null) as стал_квалом
  from bfl_lead_timings l
  left join bfl_lead_calls c on c.lead_id = l.lead_id
  where l.source_marker is not null
    and l.source_marker not in (select source_marker from bfl_excluded_sources)
  group by l.lead_id, l.source_marker, l.qualified_at
)
select
  a.источник,
  a.подрядчик,
  count(*)::integer as лидов,
  count(*) filter (where p.попыток = 0)::integer as без_единой_попытки,
  round(avg(p.попыток)::numeric, 1) as попыток_на_лид,
  count(*) filter (where p.дозвонов > 0)::integer as достали,
  round(100.0 * count(*) filter (where p.дозвонов > 0) / nullif(count(*), 0), 1) as доля_достигнутых,
  count(*) filter (where p.разговоров > 0)::integer as поговорили,
  round(100.0 * count(*) filter (where p.разговоров > 0) / nullif(count(*), 0), 1) as доля_разговоров,
  count(*) filter (where p.стал_квалом)::integer as квалов,
  round(100.0 * count(*) filter (where p.стал_квалом) / nullif(count(*), 0), 1) as квалов_на_100_лидов,
  round(100.0 * count(*) filter (where p.стал_квалом and p.разговоров > 0)
        / nullif(count(*) filter (where p.разговоров > 0), 0), 1) as конверсия_разговора_в_квал
from per_lead p
join bfl_active_sources a on a.marker_lower = lower(p.source_marker)
group by a.источник, a.подрядчик;

-- ============================================================================
-- Стоимость квала по подрядчикам
--
-- Окно берётся из самих данных — от первого до последнего лида БФЛ, — чтобы
-- расход и квалы считались за один и тот же период. Иначе подрядчик,
-- подключённый недавно, выглядит дорогим просто потому, что его расход
-- целиком попал в окно, а лиды наполовину.
--
-- Квалы здесь — из данных по лидам, а не из daily_facts: нужен тот же
-- источник истины, что и во всех витринах этой ветки, иначе цифры разъедутся.
-- ============================================================================
drop view if exists bfl_contractor_qual_cost;
create view bfl_contractor_qual_cost with (security_invoker = true) as
with окно as (
  select min(created_at)::date as с, max(created_at)::date as по
  from bfl_lead_timings
  where source_marker is not null
),
квалы as (
  select
    a.contractor_id,
    a.подрядчик,
    count(*)::integer as лидов,
    count(*) filter (where l.qualified_at is not null)::integer as квалов
  from bfl_lead_timings l
  join bfl_active_sources a on a.marker_lower = lower(l.source_marker)
  where l.source_marker not in (select source_marker from bfl_excluded_sources)
  group by 1, 2
),
расход as (
  select e.contractor_id, sum(e.spend)::numeric as расход
  from weekly_expenses e, окно o
  where e.week_start between o.с and o.по
  group by 1
)
select
  к.подрядчик,
  к.лидов,
  к.квалов,
  round(100.0 * к.квалов / nullif(к.лидов, 0), 1) as квалов_на_100_лидов,
  round(coalesce(р.расход, 0), 0) as расход,
  round(coalesce(р.расход, 0) / nullif(к.лидов, 0), 0) as цена_лида,
  round(coalesce(р.расход, 0) / nullif(к.квалов, 0), 0) as цена_квала
from квалы к
left join расход р on р.contractor_id = к.contractor_id;

-- ============================================================================
-- Контроль к часовому разрезу: время суток или состав попыток?
--
-- В девять и десять утра доля разговоров 5,4% против 3,3-4,0% в остальное
-- время. Но на первой попытке разговор выходит в 18,8% случаев, а на
-- двадцатой в 2,2%. Если утром просто больше первых попыток по свежим лидам,
-- весь утренний выигрыш — композиция, а не время суток.
--
-- Читается так: если внутри стратума «первая попытка» утро всё равно лучше —
-- время суток работает. Если внутри стратумов разница исчезает — работает
-- состав, и сдвигать смену незачем.
--
-- ПОПУТНО СНЯТА ПРЕЖНЯЯ РЕКОМЕНДАЦИЯ про вечернее окно. Использование после
-- 19:00 действительно нулевое, но отдача там не выше: 15,4% дозвона против
-- 19,6% в десять утра. Вечер не лучше, он просто пустой.
-- ============================================================================
drop view if exists bfl_calls_by_hour_stratified;
create view bfl_calls_by_hour_stratified with (security_invoker = true) as
with ordered as (
  select
    extract(hour from (c.started_at at time zone 'Asia/Novosibirsk'))::integer as час,
    c.has_recording,
    c.duration_sec,
    row_number() over (partition by c.lead_id order by c.started_at, c.id) as n
  from bfl_lead_calls c
  join bfl_lead_timings l on l.lead_id = c.lead_id
  where bfl_call_is_attempt(c.direction, c.completed)
    and c.started_at is not null
    and (l.source_marker is null
         or l.source_marker not in (select source_marker from bfl_excluded_sources))
)
select
  час,
  case
    when n = 1 then '1. первая попытка'
    when n <= 5 then '2. со второй по пятую'
    else '3. шестая и дальше'
  end as какая_попытка,
  count(*)::integer as звонков,
  count(*) filter (where bfl_call_answered(has_recording, duration_sec))::integer as дозвонов,
  round(100.0 * count(*) filter (where bfl_call_answered(has_recording, duration_sec))
        / nullif(count(*), 0), 1) as доля_дозвона,
  count(*) filter (where bfl_call_dialogue(has_recording, duration_sec))::integer as разговоров,
  round(100.0 * count(*) filter (where bfl_call_dialogue(has_recording, duration_sec))
        / nullif(count(*), 0), 2) as доля_разговоров
from ordered
where час between 8 and 20
group by 1, 2;
