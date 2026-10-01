-- ============================================================================
-- Помесячная воронка: объём потока или качество работы?
--
-- ПОЧЕМУ ЭТО СРОЧНО. Разрез необзвоненных по месяцам показал то, на что мы за
-- всю работу ни разу не смотрели:
--
--     апрель 4016 → май 2664 → июнь 2417 → июль 2793 → август 2154 →
--     сентябрь 1985 лидов
--
-- Поток упал вдвое за полгода, минус 50,6%. Все предыдущие выводы делались
-- без учёта этого факта.
--
-- И сразу тревожное сопоставление: в докладе для коммерческого директора
-- сказано, что назначений встреч к сентябрю стало примерно на четверть
-- меньше, и объяснено это работой менеджеров. Но лидов с июля по сентябрь
-- стало меньше на 29% — величины одного порядка. Если встреч меньше просто
-- потому, что меньше лидов, то раздел доклада объясняет менеджерами то, что
-- объясняется закупкой трафика.
--
-- ПРОВЕРКА. Положить помесячно объём и конверсию рядом:
--   конверсия держится, падает только объём  → дело в потоке;
--   конверсия тоже просела                   → часть вопроса к отделу.
--
-- Квал здесь — из данных по лидам, тот же источник истины, что и во всех
-- витринах ветки. С основным дашбордом приложения цифры надо сверить
-- отдельно: там свой учёт, и расхождение само по себе будет находкой.
-- ============================================================================

drop view if exists bfl_monthly_funnel;
create view bfl_monthly_funnel with (security_invoker = true) as
with per_lead as (
  select
    date_trunc('month', l.created_at)::date as месяц,
    l.lead_id,
    (l.qualified_at is not null) as стал_квалом,
    count(c.id) filter (where bfl_call_is_attempt(c.direction, c.completed))::integer as попыток,
    count(c.id) filter (
      where bfl_call_is_attempt(c.direction, c.completed)
        and bfl_call_answered(c.has_recording, c.duration_sec)
    )::integer as дозвонов,
    count(c.id) filter (
      where bfl_call_is_attempt(c.direction, c.completed)
        and bfl_call_dialogue(c.has_recording, c.duration_sec)
    )::integer as разговоров
  from bfl_lead_timings l
  left join bfl_lead_calls c on c.lead_id = l.lead_id
  where l.source_marker is not null
    and l.source_marker not in (select source_marker from bfl_excluded_sources)
  group by 1, 2, l.qualified_at
)
select
  месяц,
  count(*)::integer as лидов,
  count(*) filter (where попыток > 0)::integer as набирали,
  round(avg(попыток)::numeric, 1) as попыток_на_лид,
  count(*) filter (where дозвонов > 0)::integer as достали,
  round(100.0 * count(*) filter (where дозвонов > 0) / nullif(count(*), 0), 1) as доля_достигнутых,
  count(*) filter (where разговоров > 0)::integer as поговорили,
  round(100.0 * count(*) filter (where разговоров > 0) / nullif(count(*), 0), 1) as доля_разговоров,
  count(*) filter (where стал_квалом)::integer as квалов,
  round(100.0 * count(*) filter (where стал_квалом) / nullif(count(*), 0), 1) as конверсия_лид_квал,
  -- Главная колонка для спора «люди или поток»: чего стоит состоявшийся
  -- разговор. Если она держится, отдел работает ровно, и падение квала —
  -- это падение входа.
  round(100.0 * count(*) filter (where стал_квалом and разговоров > 0)
        / nullif(count(*) filter (where разговоров > 0), 0), 1) as конверсия_разговора_в_квал
from per_lead
group by 1;

-- ============================================================================
-- То же по источникам: падение общее или у кого-то конкретного
--
-- Если поток упал ровно у всех — это рынок или сезон. Если у двух-трёх
-- подрядчиков — это их объёмы, и разговор предметный.
-- ============================================================================
drop view if exists bfl_monthly_volume_by_source;
create view bfl_monthly_volume_by_source with (security_invoker = true) as
select
  l.source_marker as источник,
  count(*) filter (where l.created_at >= date '2026-04-01' and l.created_at < date '2026-05-01')::integer as апрель,
  count(*) filter (where l.created_at >= date '2026-05-01' and l.created_at < date '2026-06-01')::integer as май,
  count(*) filter (where l.created_at >= date '2026-06-01' and l.created_at < date '2026-07-01')::integer as июнь,
  count(*) filter (where l.created_at >= date '2026-07-01' and l.created_at < date '2026-08-01')::integer as июль,
  count(*) filter (where l.created_at >= date '2026-08-01' and l.created_at < date '2026-09-01')::integer as август,
  count(*) filter (where l.created_at >= date '2026-09-01' and l.created_at < date '2026-10-01')::integer as сентябрь,
  count(*)::integer as всего
from bfl_lead_timings l
where l.source_marker is not null
  and l.source_marker not in (select source_marker from bfl_excluded_sources)
group by 1
having count(*) >= 50;

-- ============================================================================
-- Квалы и встречи помесячно: сколько встреч приходится на один квал
--
-- ЗАЧЕМ ДОБАВЛЕНО. Помесячная воронка показала, что отдел работает ровно:
-- конверсия разговора в квал 60,4-67,6% без тренда за полгода, а квалов стало
-- меньше на 46% ровно потому, что лидов стало меньше на 50,6%.
--
-- Но в докладе для коммерческого директора сказано, что назначений встреч к
-- сентябрю стало меньше примерно на четверть, и объяснено это работой
-- менеджеров. Квалов с августа на сентябрь стало меньше на 12,8% — значит
-- часть спада приходит сверху. Разрыв между этими величинами и надо измерить,
-- прежде чем править документ.
--
-- Месяц берётся по дате КВАЛИФИКАЦИИ, а не по дате встречи: вопрос звучит
-- «сколько встреч вышло из квалов этого месяца», и привязка к месяцу встречи
-- на него не отвечает — встреча бывает в следующем месяце.
--
-- Хвост последнего месяца всегда занижен: по свежим квалам встречи ещё не
-- успели состояться. Последнюю строку читать нельзя.
-- ============================================================================
drop view if exists bfl_monthly_qual_to_meeting;
create view bfl_monthly_qual_to_meeting with (security_invoker = true) as
with квалы as (
  select
    date_trunc('month', l.qualified_at)::date as месяц,
    l.lead_id
  from bfl_lead_timings l
  where l.qualified_at is not null
    and l.source_marker is not null
    and l.source_marker not in (select source_marker from bfl_excluded_sources)
),
встречи as (
  select
    lead_id,
    count(*)::integer as назначено,
    count(*) filter (where stage_id = 'DT1044_64:SUCCESS')::integer as состоялось
  from bfl_meeting_timings
  where lead_id is not null
    and bfl_meeting_moment(scheduled_at, held_at) is not null
  group by 1
)
select
  к.месяц,
  count(*)::integer as квалов,
  count(*) filter (where в.назначено > 0)::integer as квалов_с_назначением,
  round(100.0 * count(*) filter (where в.назначено > 0) / nullif(count(*), 0), 1)
    as доля_квалов_с_назначением,
  coalesce(sum(в.назначено), 0)::integer as всего_назначений,
  round(coalesce(sum(в.назначено), 0)::numeric / nullif(count(*), 0), 2)
    as назначений_на_квал,
  coalesce(sum(в.состоялось), 0)::integer as состоялось,
  round(100.0 * coalesce(sum(в.состоялось), 0) / nullif(sum(в.назначено), 0), 1)
    as доходимость,
  round(coalesce(sum(в.состоялось), 0)::numeric / nullif(count(*), 0), 2)
    as встреч_на_квал
from квалы к
left join встречи в on в.lead_id = к.lead_id
group by 1;
