-- ============================================================================
-- Портфель: что у менеджера сейчас в работе.
--
-- ЗАЧЕМ. До сих пор кабинет показывал ПОТОК — что произошло за период.
-- Руководителю этого мало: чтобы понять, выполнит ли менеджер план, нужно
-- знать ЗАПАС — сколько сделок у него на руках, на каких этапах и давно ли
-- они не двигались. Поток отвечает на «как сработали», запас — на «есть ли
-- чем работать дальше».
--
-- ЧТО ВЫЯСНИЛОСЬ ПРИ ПРОВЕРКЕ. Открытых сделок в воронке 299. Двести из них
-- стоят на «ИКП сформировано», медиана простоя — 29 дней, сорок штук не
-- двигались больше двух месяцев. То есть две трети запаса лежит на одном
-- этапе, и половина этого — мёртвым грузом.
--
-- ВОЗРАСТ СЧИТАЕТСЯ ОТ ПОСЛЕДНЕГО ДВИЖЕНИЯ, А НЕ ОТ СОЗДАНИЯ. Сделка,
-- созданная в июне и перешедшая на ИКП вчера, — свежая. Сделка, созданная
-- вчера и с тех пор не тронутая, — тоже свежая. Разница между ними
-- появляется на тридцатый день, и считать её надо от moved_time.
--
-- ДЕНЬГИ ПОРТФЕЛЯ НЕ БЕРЁМ ИЗ ПОЛЯ СУММЫ. На ранних этапах его не
-- заполняют: 200 сделок на ИКП дают 11,5 млн, то есть 57 тысяч на сделку
-- при среднем чеке 213 тысяч. Поэтому сумма собирается из товарных позиций,
-- а где их нет — остаётся пустой. Лучше честная пустота, чем число втрое
-- ниже правды.
-- ============================================================================

alter table rop_deals add column if not exists closed boolean;

comment on column rop_deals.closed is
  'Признак закрытости от Битрикса. По нему строится портфель: выводить '
  '«в работе» через список стадий нельзя — список меняется, и каждая новая '
  'отказная стадия тихо попадала бы в запас как живая.';

-- Пока поле не заполнено импортом, считаем закрытыми те, что стоят на
-- известных терминальных стадиях: передано в ОКС и четыре отказные.
update rop_deals
set closed = stage_id in ('C34:WON', 'C34:7', 'C34:APOLOGY', 'C34:LOSE', 'C34:1')
where closed is null;

-- ============================================================================
-- Витрина портфеля: одна строка — одна открытая сделка
--
-- Отдельная вьюха, а не фильтр в месте использования: «что считается
-- открытым» должно быть записано один раз. Иначе через месяц на одном
-- экране портфель будет с одним набором стадий, на другом — с другим.
-- ============================================================================
drop view if exists rop_portfolio_deal cascade;
create view rop_portfolio_deal as
select
  d.deal_id,
  d.title,
  m.team as отдел,
  d.assigned_by_name as менеджер,
  d.stage_id,
  d.stage_name as этап,
  rop_source_group(d.source_name) as группа,
  d.date_create as создана,
  d.moved_time as последнее_движение,
  (current_date - (coalesce(d.moved_time, d.date_create) at time zone 'Europe/Moscow')::date)
    as дней_без_движения,
  (current_date - (d.date_create at time zone 'Europe/Moscow')::date) as возраст_дней,
  money.чек,
  money.есть_бфл,
  money.есть_аз,
  money.есть_вки
from rop_deals d
join rop_managers m on m.manager_name = d.assigned_by_name and m.active and m.team is not null
left join rop_deal_money money on money.deal_id = d.deal_id
where coalesce(d.closed, false) = false
  and d.category_id = 34;

revoke all on rop_portfolio_deal from anon, authenticated;

-- ============================================================================
-- Сколько дней этап держит сделку
--
-- Норма простоя берётся из истории, а не назначается: по каждому этапу
-- смотрим, за сколько дней с него УХОДИЛИ те сделки, что ушли. Медиана
-- этого срока — норма, вдвое больше — повод спросить.
--
-- Считаются только состоявшиеся переходы: сделка, которая сидит на этапе
-- прямо сейчас, ещё ничего не говорит о том, сколько он держит.
-- ============================================================================
drop view if exists rop_stage_pace cascade;
create view rop_stage_pace as
with moves as (
  select
    s.deal_id,
    s.stage_id,
    s.entered_at,
    lead(s.entered_at) over (partition by s.deal_id order by s.entered_at) as next_at
  from rop_deal_stages s
  where s.stage_id like 'C34:%'
)
select
  stage_id,
  count(*)::integer as переходов,
  percentile_cont(0.5) within group (
    order by extract(epoch from (next_at - entered_at)) / 86400
  )::numeric(6, 1) as медиана_дней,
  percentile_cont(0.8) within group (
    order by extract(epoch from (next_at - entered_at)) / 86400
  )::numeric(6, 1) as дней_у_80_процентов
from moves
where next_at is not null
group by stage_id;

revoke all on rop_stage_pace from anon, authenticated;

-- ============================================================================
-- Вероятность дойти до ОКС с каждого этапа
--
-- Берутся сделки, которые входили на этап ДАВНО — не меньше 45 дней назад.
-- Иначе свежие, у которых всё ещё впереди, попадут в знаменатель как
-- неудачи и занизят вероятность.
-- ============================================================================
drop view if exists rop_stage_win_rate cascade;
create view rop_stage_win_rate as
with entered as (
  select distinct s.deal_id, s.stage_id
  from rop_deal_stages s
  where s.stage_id like 'C34:%'
    and s.entered_at < now() - interval '45 days'
),
won as (
  select distinct deal_id from rop_deal_stages where stage_id = 'C34:WON'
)
select
  e.stage_id,
  count(*)::integer as сделок,
  count(w.deal_id)::integer as дошли_до_окс,
  round(100.0 * count(w.deal_id) / nullif(count(*), 0), 1) as доля_дошедших
from entered e
left join won w on w.deal_id = e.deal_id
group by e.stage_id;

revoke all on rop_stage_win_rate from anon, authenticated;

-- ============================================================================
-- Свод портфеля по менеджеру и этапу
-- ============================================================================
drop view if exists rop_portfolio cascade;
create view rop_portfolio as
select
  p.отдел,
  p.менеджер,
  p.stage_id,
  p.этап,
  count(*)::integer as сделок,
  count(*) filter (where p.дней_без_движения > 30)::integer as старше_30,
  count(*) filter (where p.дней_без_движения > 60)::integer as старше_60,
  percentile_cont(0.5) within group (order by p.дней_без_движения)::numeric(6, 1)
    as медиана_простоя,
  sum(p.чек)::numeric as чек_сумма,
  count(p.чек)::integer as чек_сделок,
  max(wr.доля_дошедших) as шанс_дойти,
  round(count(*) * coalesce(max(wr.доля_дошедших), 0) / 100.0, 1) as ожидаемо_окс
from rop_portfolio_deal p
left join rop_stage_win_rate wr on wr.stage_id = p.stage_id
group by p.отдел, p.менеджер, p.stage_id, p.этап;

revoke all on rop_portfolio from anon, authenticated;

-- ============================================================================
-- Кабинет: портфель видно так же, как и всё остальное
-- ============================================================================
drop view if exists rop_portal_portfolio;
create view rop_portal_portfolio as
select p.*
from rop_portfolio p
where rop_can_read()
  and (is_staff() or p.отдел = current_rop_team());

revoke all on rop_portal_portfolio from anon;
grant select on rop_portal_portfolio to authenticated;

drop view if exists rop_portal_stuck;
create view rop_portal_stuck as
select
  d.отдел, d.менеджер, d.deal_id, d.title, d.этап,
  d.дней_без_движения, d.возраст_дней, d.чек, d.группа
from rop_portfolio_deal d
where rop_can_read()
  and (is_staff() or d.отдел = current_rop_team())
  and d.дней_без_движения > 30;

revoke all on rop_portal_stuck from anon;
grant select on rop_portal_stuck to authenticated;

-- ============================================================================
-- Проверки после импорта
--
--   select * from rop_stage_pace order by переходов desc;
--   select * from rop_stage_win_rate order by сделок desc;
--   select отдел, sum(сделок) from rop_portfolio group by 1;
--
-- Сумма портфеля по отделам должна сойтись с числом открытых сделок в
-- Битриксе за вычетом тех, чей ответственный не заведён в составе.
-- ============================================================================
