-- ============================================================================
-- Экономика дозвона: где на самом деле теряется квал.
--
-- ЧТО ВЫЯСНИЛОСЬ НА ПРЕДЫДУЩЕМ ШАГЕ, и почему эти витрины выглядят именно так.
--
-- 1. РЕЗЕРВА КВАЛА В ЛЮДЯХ НЕТ. Частные метрики различаются вдвое, а выход
--    квала с базы — на 4,8 пункта:
--        Медведева  дозвон до 70,6% базы, конверсия диалога 47,6% → 21,9%
--        Островская дозвон до 44,2% базы, конверсия диалога 66,2% → 19,3%
--    Метрики гасят друг друга: кто достаёт многих, конвертирует мало, и
--    наоборот. Поэтому главной витриной по менеджерам становится выход квала
--    с набранной базы, а не доля дозвона и не конверсия разговора по
--    отдельности — по ним люди ранжируются в обратном порядке и оба рейтинга
--    обманывают.
--
-- 2. ГИПОТЕЗА ИНФЛЯЦИИ КВАЛА ОТКЛОНЕНА. Связь выхода квала с лида и
--    доходимости встреч — Спирмен −0,03. Щедрость в постановке квала плохую
--    явку не объясняет, доходимость остаётся самостоятельным персональным
--    резервом.
--
-- 3. ПОТЕРЯ ОДНА, А НЕ ТРИ. Разговор состоялся — в квал доходит половина, и
--    на всех стадиях одинаково (недозвон 54,7%, Дозвонились 50,6%). Разговор
--    не состоялся — 2-3%. Значит «недозвон», «Дозвонились» и «Скорозвон» —
--    не три проблемы с разными лекарствами, а одна: с человеком не поговорили.
--
-- 4. ЗВОНИТЬ БОЛЬШЕ БЕССМЫСЛЕННО, звонят уже по 22 раза. 5434 лида в
--    недозвоне получили ~119 000 набоов и дали 178 квалов — 668 попыток на
--    квал против 43 у тех, с кем разговор состоялся. Нужно правило остановки,
--    и для него нужен предельный шанс дозвона по номеру попытки — витрина
--    bfl_calls_marginal_hazard ниже.
--
-- 5. ИСТОЧНИК ВАЖНЕЕ МЕНЕДЖЕРА. Конверсия разговора в квал по источникам от
--    25,7% до 84,0% — трёхкратный разброс против 4,8 пункта между людьми.
--    Поэтому любое сравнение менеджеров нужно поправлять на состав их
--    источников: витрина bfl_manager_dialogue_standardized.
-- ============================================================================

-- ============================================================================
-- Правило остановки: предельный шанс дозвониться
--
-- Обычный профиль попыток отвечает на вопрос «какая доля N-х звонков
-- успешна», и он смазан: в нём сидят и те лиды, с кем уже поговорили.
-- Для решения «звонить ли двадцать первый раз» нужен другой вопрос:
-- СРЕДИ ТЕХ, С КЕМ ЕЩЁ НИ РАЗУ НЕ ПОГОВОРИЛИ, какая доля заговорит именно
-- на этой попытке. Это и есть предельная отдача набора.
--
-- Когда шанс падает до десятых долей процента, дальнейший обзвон — это
-- расход рабочего времени без ожидаемого результата, и его можно
-- перебросить на канал, где человек ещё достижим.
-- ============================================================================
drop view if exists bfl_calls_marginal_hazard;
create view bfl_calls_marginal_hazard with (security_invoker = true) as
with ordered as (
  select
    c.lead_id,
    row_number() over (partition by c.lead_id order by c.started_at, c.id) as n,
    bfl_call_dialogue(c.has_recording, c.duration_sec) as dialogue
  from bfl_lead_calls c
  join bfl_lead_timings l on l.lead_id = c.lead_id
  where bfl_call_is_attempt(c.direction, c.completed)
    and c.started_at is not null
    and (l.source_marker is null
         or l.source_marker not in (select source_marker from bfl_excluded_sources))
),
flagged as (
  select
    n,
    dialogue,
    coalesce(bool_or(dialogue) over (
      partition by lead_id order by n
      rows between unbounded preceding and 1 preceding
    ), false) as уже_говорили
  from ordered
)
select
  n::integer as номер_попытки,
  count(*)::integer as всего_звонков,
  count(*) filter (where not уже_говорили)::integer as звонков_до_первого_разговора,
  count(*) filter (where not уже_говорили and dialogue)::integer as дали_первый_разговор,
  round(100.0 * count(*) filter (where not уже_говорили and dialogue)
        / nullif(count(*) filter (where not уже_говорили), 0), 2) as предельный_шанс
from flagged
where n <= 40
group by 1;

-- ============================================================================
-- Выход квала с набранной базы — главная витрина по менеджерам
--
-- Числитель — квалы, приписанные последнему разговору до квала (правило из
-- bfl_lead_dialogue_owner, лид попадает ровно к одному человеку).
-- Знаменатель — лиды, которым человек звонил; здесь лид может попасть к
-- нескольким, потому что базу действительно обрабатывают несколько человек.
--
-- Знаменатель намеренно не эксклюзивный: вопрос звучит «какой выход квала
-- даёт база, которую ты обрабатывал», а не «чей это лид». Для сравнения
-- людей между собой это корректно — правило одно для всех.
-- ============================================================================
drop view if exists bfl_manager_qual_yield;
create view bfl_manager_qual_yield with (security_invoker = true) as
with dialed as (
  select
    coalesce(c.responsible_name, '— не загружен —') as менеджер,
    count(distinct c.lead_id)::integer as набирал_лидов,
    count(*)::integer as всего_попыток
  from bfl_lead_calls c
  join bfl_lead_timings l on l.lead_id = c.lead_id
  where bfl_call_is_attempt(c.direction, c.completed)
    and (l.source_marker is null
         or l.source_marker not in (select source_marker from bfl_excluded_sources))
  group by 1
),
qual as (
  select
    coalesce(поговорил_последним, '— не загружен —') as менеджер,
    count(*)::integer as поговорил_с_лидами,
    count(*) filter (where стал_квалом)::integer as квалов
  from bfl_lead_dialogue_owner
  group by 1
)
select
  d.менеджер,
  (d.набирал_лидов >= 50) as в_работе,
  d.набирал_лидов,
  d.всего_попыток,
  q.поговорил_с_лидами,
  q.квалов,
  round(100.0 * q.квалов / nullif(d.набирал_лидов, 0), 1) as квалов_на_100_лидов,
  -- Сколько набоов стоит один квал. Прямая мера цены усилия.
  round(d.всего_попыток::numeric / nullif(q.квалов, 0), 0) as попыток_на_квал
from dialed d
left join qual q on q.менеджер = d.менеджер;

-- ============================================================================
-- Поправка на состав источников
--
-- Конверсия разговора в квал по источникам различается в три раза (25,7% у
-- Lead.Force против 84,0% у Lbfl), а между менеджерами — на 4,8 пункта.
-- Значит прежде чем называть кого-то отстающим, надо исключить версию «ему
-- достались разговоры по слабым источникам».
--
-- Метод — косвенная стандартизация: для каждого разговора берём среднюю по
-- его источнику ставку конверсии, складываем — получаем, сколько квалов
-- человек ДОЛЖЕН был дать при своём наборе источников. Отношение факта к
-- ожиданию и есть его собственный вклад: 100% — ровно как у всех, 120% —
-- лучше состава, 80% — хуже.
-- ============================================================================
drop view if exists bfl_manager_dialogue_standardized;
create view bfl_manager_dialogue_standardized with (security_invoker = true) as
with src_rate as (
  select
    source_marker,
    count(*) filter (where стал_квалом)::numeric / nullif(count(*), 0) as rate
  from bfl_lead_dialogue_owner
  where source_marker is not null
  group by 1
)
select
  coalesce(o.поговорил_последним, '— не загружен —') as менеджер,
  count(*)::integer as разговоров,
  count(*) filter (where o.стал_квалом)::integer as квалов_факт,
  round(sum(s.rate), 1) as квалов_ожидалось,
  round(100.0 * count(*) filter (where o.стал_квалом) / nullif(sum(s.rate), 0), 1)
    as факт_к_ожиданию,
  round(100.0 * avg(s.rate), 1) as средняя_ставка_его_источников
from bfl_lead_dialogue_owner o
join src_rate s on s.source_marker = o.source_marker
group by 1;

-- ============================================================================
-- Стадия × был ли разговор — с исправлением
--
-- ИЗЪЯН ПРЕДЫДУЩЕЙ ВЕРСИИ. Считались только звонки ПОСЛЕ входа в стадию. Для
-- недозвона это верно: лид туда попадает именно потому, что связи не было.
-- А вот в «Дозвонились» лида переводят как раз из-за состоявшегося разговора,
-- и этот разговор был ДО входа. Поэтому 1810 лидов в категории «звонили, не
-- поговорили» читались как «с ними никогда не говорили», хотя правильное
-- чтение — «после перевода в Дозвонились до них больше не дошли».
--
-- Вывод от этого не менялся (повторный разговор даёт 50,6%, и он не
-- состоялся), но формулировка была неточной. Добавлена колонка с разговорами
-- до входа, чтобы путаницы больше не было.
-- ============================================================================
drop view if exists bfl_stage_dialogue_split;
create view bfl_stage_dialogue_split with (security_invoker = true) as
with entered as (
  select
    h.lead_id,
    h.status_id,
    h.status_name,
    min(h.entered_at) as first_in
  from bfl_lead_stage_history h
  join bfl_lead_timings l on l.lead_id = h.lead_id
  where h.status_id in ('11', '23', 'UC_GKWGR0')
    and (l.source_marker is null
         or l.source_marker not in (select source_marker from bfl_excluded_sources))
  group by h.lead_id, h.status_id, h.status_name
),
with_calls as (
  select
    e.status_id,
    e.status_name,
    e.lead_id,
    (q.qual_at is not null and q.qual_at > e.first_in) as reached_qual,
    count(c.id) filter (
      where bfl_call_is_attempt(c.direction, c.completed)
        and c.started_at >= e.first_in
    )::integer as попыток_после,
    count(c.id) filter (
      where bfl_call_is_attempt(c.direction, c.completed)
        and bfl_call_dialogue(c.has_recording, c.duration_sec)
        and c.started_at >= e.first_in
    )::integer as диалогов_после,
    count(c.id) filter (
      where bfl_call_is_attempt(c.direction, c.completed)
        and bfl_call_dialogue(c.has_recording, c.duration_sec)
        and c.started_at < e.first_in
    )::integer as диалогов_до
  from entered e
  left join bfl_lead_qual_moment q on q.lead_id = e.lead_id
  left join bfl_lead_calls c on c.lead_id = e.lead_id
  group by e.status_id, e.status_name, e.lead_id, q.qual_at, e.first_in
)
select
  status_name as стадия,
  case
    when попыток_после = 0 then '1. ни одной попытки'
    when диалогов_после = 0 then '2. звонили, не поговорили'
    else '3. поговорили'
  end as что_было_после_входа,
  count(*)::integer as лидов,
  count(*) filter (where диалогов_до > 0)::integer as из_них_говорили_раньше,
  count(*) filter (where reached_qual)::integer as дошли_до_квала,
  round(100.0 * count(*) filter (where reached_qual) / nullif(count(*), 0), 1)
    as конверсия_в_квал,
  round(avg(попыток_после)::numeric, 1) as среднее_попыток,
  sum(попыток_после)::integer as всего_попыток_в_клетке,
  -- Цена квала в наборах по этой клетке: главный довод при разговоре о том,
  -- куда перекладывать усилие.
  round(sum(попыток_после)::numeric
        / nullif(count(*) filter (where reached_qual), 0), 0) as попыток_на_квал
from with_calls
group by 1, 2;

-- ============================================================================
-- Сквозной путь менеджера в едином окне
--
-- Разговоры есть с 1 апреля, а встречи — только с 16 июля, когда начался
-- импорт таймингов. Поэтому в bfl_manager_full_funnel квалы и назначения
-- несопоставимы: у Худышкиной 407 квалов и 200 назначений — это разные
-- периоды, а не потерянные квалы. И Шелест ложно выходила вперёд ровно
-- потому, что начала работать в июле и у неё одной окна совпали.
--
-- Здесь обе части считаются от общего начала — самой ранней встречи в
-- данных. Граница берётся из данных, а не прописана числом, чтобы витрина
-- не сломалась, когда импорт встреч углубят.
--
-- Ключевая колонка — встреч на 100 разговоров. Она сквозная и не зависит от
-- того, где человек ставит планку квала: завысил планку — больше квалов, но
-- хуже доходимость, итог тот же.
-- ============================================================================
drop view if exists bfl_analysis_window;
create view bfl_analysis_window with (security_invoker = true) as
select min(bfl_meeting_moment(scheduled_at, held_at))::date as начало
from bfl_meeting_timings
where source_marker is not null;

-- ПРО СКОРОСТЬ. Первая версия брала границу окна соединением с
-- bfl_analysis_window, и запрос вис: планировщик не может подставить границу
-- как константу, раскрывает тяжёлую bfl_lead_dialogue_owner внутрь
-- соединения и пересобирает её неудачным способом. Лечится двумя приёмами —
-- скалярным подзапросом вместо соединения и materialized, который заставляет
-- посчитать каждую часть ровно один раз.
drop view if exists bfl_manager_end_to_end;
create view bfl_manager_end_to_end with (security_invoker = true) as
with dial as materialized (
  select
    coalesce(o.поговорил_последним, '— не загружен —') as менеджер,
    count(*)::integer as разговоров,
    count(*) filter (where o.стал_квалом)::integer as квалов
  from bfl_lead_dialogue_owner o
  where o.последний_диалог >= (select начало from bfl_analysis_window)
  group by 1
),
meet as materialized (
  select
    coalesce(scheduled_by_name, '— не указан —') as менеджер,
    count(*)::integer as назначено,
    count(*) filter (where stage_id = 'DT1044_64:SUCCESS')::integer as состоялось,
    round(
      100.0 * count(*) filter (where stage_id = 'DT1044_64:SUCCESS')
      / nullif(count(*) filter (where stage_id in ('DT1044_64:SUCCESS', 'DT1044_64:FAIL')), 0)
    , 1) as доходимость
  from bfl_meeting_timings
  where source_marker is not null
    and bfl_meeting_moment(scheduled_at, held_at) is not null
  group by 1
)
select
  coalesce(d.менеджер, m.менеджер) as менеджер,
  d.разговоров,
  d.квалов,
  round(100.0 * d.квалов / nullif(d.разговоров, 0), 1) as конверсия_диалога_в_квал,
  m.назначено,
  m.состоялось,
  m.доходимость,
  round(100.0 * m.состоялось / nullif(d.разговоров, 0), 1) as встреч_на_100_разговоров
from dial d
full join meet m on m.менеджер = d.менеджер;
