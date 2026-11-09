-- ============================================================================
-- Куда двигались агенты: матрица переходов.
--
-- ЗАЧЕМ ОНА ПОНАДОБИЛАСЬ. В воронке под каждой ступенью стоят «+» и «−», и
-- по ним нельзя понять направление. На живых данных за октябрь–ноябрь со
-- ступени «Активный» ушло четырнадцать человек, а в «Профи» не пришёл ни
-- один: все четырнадцать откатились вниз. По двум числам этого не видно —
-- откат выглядит как «+» на нижней ступени, то есть как рост.
--
-- МАСШТАБ НЕ ЧАСТНЫЙ: откатов тридцать из ста пятидесяти одного перехода,
-- каждый пятый. Для сети, где ступень означает число клиентов, это и есть
-- главная новость: агенты не только набирают клиентов, но и теряют их.
--
-- Направление считается по порядку ступеней из agent_stages, а не по
-- названиям: переименуют стадию — матрица продолжит работать.
-- ============================================================================
drop view if exists agent_stage_moves cascade;
create view agent_stage_moves as
with шаги as (
  select
    e.agent_id,
    e.stage_id as куда,
    (e.created_time at time zone 'Europe/Moscow')::date as дата,
    lag(e.stage_id) over (partition by e.agent_id
                          order by e.created_time, e.event_id) as откуда
  from agent_stage_events e
  join agent_cards c on c.agent_id = e.agent_id and c.вид = 'агент'
)
select
  ш.дата,
  ш.откуда as откуда_id,
  ш.куда as куда_id,
  coalesce(so.name, ш.откуда) as откуда,
  coalesce(sn.name, ш.куда) as куда,
  so.sort_order as откуда_порядок,
  sn.sort_order as куда_порядок,
  -- «вперёд» — на ступень выше, «назад» — ниже, «вне воронки» — в «Успех»
  -- или «Провал» и обратно: ступени там нет, и считать направление не по
  -- чему.
  case
    when so.sort_order is null or sn.sort_order is null then 'вне воронки'
    when sn.sort_order > so.sort_order then 'вперёд'
    when sn.sort_order < so.sort_order then 'назад'
    else 'на месте'
  end as направление,
  count(*)::integer as переходов
from шаги ш
left join agent_stages so on so.stage_id = ш.откуда
left join agent_stages sn on sn.stage_id = ш.куда
where ш.откуда is not null
group by ш.дата, ш.откуда, ш.куда, so.name, sn.name, so.sort_order, sn.sort_order;

revoke all on agent_stage_moves from anon, authenticated;

drop view if exists agents_portal_moves;
create view agents_portal_moves as
select m.* from agent_stage_moves m where agents_can_read();
revoke all on agents_portal_moves from anon;
grant select on agents_portal_moves to authenticated;

-- ============================================================================
-- ПРОВЕРКА. Должна повторить матрицу, снятую вручную: откатов примерно
-- пятая часть от всех переходов.
--
-- select направление, sum(переходов) as переходов
-- from agent_stage_moves
-- where дата between '2026-10-01' and '2026-11-09'
-- group by 1 order by 2 desc;
-- ============================================================================
