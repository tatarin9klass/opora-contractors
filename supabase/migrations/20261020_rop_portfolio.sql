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

-- Портфель опирается на отделы: без них непонятно, чей это менеджер.
-- Без этой проверки отсутствующая колонка даёт «column m.team does not
-- exist» на сто девяностой строке — сообщение, по которому не догадаешься,
-- что просто перепутан порядок файлов.
do $$
begin
  if to_regclass('public.rop_teams') is null
     or not exists (select 1 from information_schema.columns
                    where table_name = 'rop_managers' and column_name = 'team') then
    raise exception 'Сначала прогони 20261020_rop_teams.sql: портфель опирается на отделы';
  end if;
end $$;

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
-- Состояния сделки и порог застоя
--
-- ЧТО УТОЧНИЛОСЬ. Этап C34:UC_HSH4W4 — технический: сделка висит на нём до
-- трёх рабочих дней, пока ОКС её не примет или не отклонит. Это не запас
-- менеджера — работать с ней он уже не может — и не результат, потому что
-- принять могут не всё. Значит состояний у открытой сделки три:
--
--   в работе    — менеджер ведёт её сам;
--   на приёмке  — ждёт решения ОКС, до трёх рабочих дней;
--   (закрытые в портфель не попадают вовсе).
--
-- ПОРОГ ЗАСТОЯ ПЕРЕСТАЁТ БЫТЬ ОБЩИМ. Тридцать дней — разумная цифра для
-- ИКП и бессмысленная для приёмки, которая живёт три дня. Поэтому порог у
-- каждого этапа свой и берётся из истории: срок, за который с этапа уходят
-- восемь сделок из десяти. Ушли быстрее восемьдесят процентов — значит
-- те, кто сидит дольше, сидят ненормально долго. Для приёмки это даст
-- несколько дней само собой, без отдельного правила.
--
-- Если истории по этапу мало (меньше десяти переходов), порог остаётся
-- тридцать дней: медиана по трём случаям — не норма, а совпадение.
-- ============================================================================

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

create or replace function rop_stage_kind(stage_id text)
returns text
language sql
immutable
as $$
  select case
    when stage_id = 'C34:UC_HSH4W4' then 'на приёмке'
    else 'в работе'
  end;
$$;

comment on function rop_stage_kind(text) is
  'Состояние открытой сделки: ведёт её менеджер или она ждёт решения ОКС. '
  'Разделены потому, что по приёмке к менеджеру вопросов нет.';

-- ============================================================================
-- Порог застоя по каждому этапу
-- ============================================================================
drop view if exists rop_stage_limit cascade;
create view rop_stage_limit as
select
  p.stage_id,
  case
    when p.переходов >= 10 then greatest(ceil(p.дней_у_80_процентов)::integer, 2)
    else 30
  end as порог_дней,
  p.переходов,
  p.медиана_дней
from rop_stage_pace p;

revoke all on rop_stage_limit from anon, authenticated;

-- ============================================================================
-- Витрина портфеля — с состоянием и персональным порогом
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
  rop_stage_kind(d.stage_id) as состояние,
  rop_source_group(d.source_name) as группа,
  d.date_create as создана,
  d.moved_time as последнее_движение,
  (current_date - (coalesce(d.moved_time, d.date_create) at time zone 'Europe/Moscow')::date)
    as дней_без_движения,
  (current_date - (d.date_create at time zone 'Europe/Moscow')::date) as возраст_дней,
  coalesce(lim.порог_дней, 30) as порог_дней,
  (current_date - (coalesce(d.moved_time, d.date_create) at time zone 'Europe/Moscow')::date)
    > coalesce(lim.порог_дней, 30) as залежалась,
  money.чек,
  -- Сумма сделки из её собственного поля — нужна не для денег, а чтобы
  -- видеть, что её не заполнили: ИКП без суммы это дефект процесса, а не
  -- особенность данных.
  d.opportunity as сумма_поля,
  money.есть_бфл,
  money.есть_аз,
  money.есть_вки
from rop_deals d
join rop_managers m on m.manager_name = d.assigned_by_name and m.active and m.team is not null
left join rop_deal_money money on money.deal_id = d.deal_id
left join rop_stage_limit lim on lim.stage_id = d.stage_id
where coalesce(d.closed, false) = false
  and d.category_id = 34;

revoke all on rop_portfolio_deal from anon, authenticated;

-- ============================================================================
-- Свод портфеля
-- ============================================================================
drop view if exists rop_portfolio cascade;
create view rop_portfolio as
select
  p.отдел,
  p.менеджер,
  p.состояние,
  p.stage_id,
  p.этап,
  count(*)::integer as сделок,
  count(*) filter (where p.залежалась)::integer as залежалось,
  max(p.порог_дней)::integer as порог_дней,
  percentile_cont(0.5) within group (order by p.дней_без_движения)::numeric(6, 1)
    as медиана_простоя,
  sum(p.чек)::numeric as чек_сумма,
  count(p.чек)::integer as чек_сделок,
  -- Сделки без денег вообще: ни позиций, ни суммы в поле.
  count(*) filter (where p.чек is null and coalesce(p.сумма_поля, 0) = 0)::integer as без_суммы,
  max(wr.доля_дошедших) as шанс_дойти,
  round(count(*) * coalesce(max(wr.доля_дошедших), 0) / 100.0, 1) as ожидаемо_окс
from rop_portfolio_deal p
left join rop_stage_win_rate wr on wr.stage_id = p.stage_id
group by p.отдел, p.менеджер, p.состояние, p.stage_id, p.этап;

revoke all on rop_portfolio from anon, authenticated;

-- ============================================================================
-- Кто остался за бортом
--
-- Открытые сделки, ответственный которых не заведён ни в одном отделе. По
-- решению руководителя направления они в учёт не идут: это технические
-- карточки. Но показывать их надо — сегодня это техничка, а завтра там
-- окажется новый менеджер, которого забыли завести, и его портфель
-- исчезнет молча.
-- ============================================================================
drop view if exists rop_portfolio_outside cascade;
create view rop_portfolio_outside as
select
  coalesce(d.assigned_by_name, '— без ответственного —') as кто,
  count(*)::integer as сделок,
  count(*) filter (where d.stage_id = 'C34:PREPARATION')::integer as на_икп,
  min(d.date_create)::date as самая_старая
from rop_deals d
left join rop_managers m
  on m.manager_name = d.assigned_by_name and m.active and m.team is not null
where coalesce(d.closed, false) = false
  and d.category_id = 34
  and m.manager_name is null
group by 1
order by 2 desc;

revoke all on rop_portfolio_outside from anon, authenticated;

-- ============================================================================
-- Что видит кабинет
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
  d.отдел, d.менеджер, d.deal_id, d.title, d.этап, d.состояние,
  d.дней_без_движения, d.порог_дней, d.возраст_дней, d.чек, d.группа
from rop_portfolio_deal d
where rop_can_read()
  and (is_staff() or d.отдел = current_rop_team())
  and d.залежалась;

revoke all on rop_portal_stuck from anon;
grant select on rop_portal_stuck to authenticated;

-- Счётчик чужих сделок виден только сотрудникам: руководителю отдела он
-- ничего не говорит — это не его люди.
drop view if exists rop_portal_outside;
create view rop_portal_outside as
select o.* from rop_portfolio_outside o where is_staff();

revoke all on rop_portal_outside from anon;
grant select on rop_portal_outside to authenticated;

-- ============================================================================
-- Проверки
--
--   select stage_id, порог_дней, переходов, медиана_дней from rop_stage_limit;
--   select состояние, sum(сделок), sum(залежалось) from rop_portfolio group by 1;
--   select * from rop_portfolio_outside;
--   select отдел, sum(без_суммы) from rop_portfolio group by 1;
-- ============================================================================
