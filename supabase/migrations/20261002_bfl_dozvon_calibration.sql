-- ============================================================================
-- Калибровка дозвона по разметке, которую ставят сами менеджеры.
--
-- ОТКУДА ВЗЯЛАСЬ ВОЗМОЖНОСТЬ. Руководитель направления объяснил смысл двух
-- стадий воронки, и это оказалось разметкой:
--
--   «Дозвонились» (UC_GKWGR0) — трубку ВЗЯЛИ, но вердикта не вышло: ни
--                               квала, ни брака. Типичный случай — «занят,
--                               перезвоните», «я на даче»;
--   «Не отвечает более месяца» (19) — дозвониться так и не удалось.
--
-- То есть момент входа в первую стадию — это метка факта дозвона,
-- поставленная человеком, а вход во вторую — метка его отсутствия. Два
-- размеченных класса, причём разметка не наша и к нашим эвристикам
-- отношения не имеет.
--
-- ЗАЧЕМ ЭТО НУЖНО. Порог «дозвон от 35 секунд, диалог от минуты» был взят с
-- голоса, а витрина чувствительности показала, что в данных нет естественной
-- границы: доля связи падает плавно от 44,6% при 5 секундах до 3,8% при
-- минуте, полки нет нигде. Значит порог нельзя ни подтвердить, ни опровергнуть
-- изнутри распределения длительностей — нужна внешняя метка. Она появилась.
--
-- И СРАЗУ ОБРАТНАЯ ПРОВЕРКА, которая может развернуть выводы. Если у
-- большинства лидов, помеченных менеджерами как дозвон, наш 60-секундный
-- «диалог» не зафиксирован, значит порог завышен и дозвоны недосчитаны. Тогда
-- оценка «5434 лида в недозвоне недостижимы» завышена, и часть из них
-- достигнута. Витрина bfl_dozvon_threshold_roc отвечает на это числом.
--
-- ВАЖНО ПРО СМЫСЛ СТАДИИ «Дозвонились». Это не потеря связи, а незакрытое
-- решение: человека достали, поговорили, и вердикта не приняли. Болезнь
-- другая, чем в недозвоне, и лечится не обзвоном, а дисциплиной закрытия.
-- Размер свалки считает bfl_dozvon_pending_decision.
-- ============================================================================

-- ============================================================================
-- Два размеченных класса
--
-- Пересечение исключено: лид, который сперва попал в «Дозвонились», а уже
-- потом в архив, остаётся только в положительном классе — до него
-- дозвонились, и это факт, который более поздний архив не отменяет.
-- ============================================================================
drop view if exists bfl_dozvon_labels cascade;
create view bfl_dozvon_labels with (security_invoker = true) as
with bfl as (
  select l.lead_id
  from bfl_lead_timings l
  where l.source_marker is null
     or l.source_marker not in (select source_marker from bfl_excluded_sources)
),
pos as (
  select h.lead_id, min(h.entered_at) as moment
  from bfl_lead_stage_history h
  join bfl b on b.lead_id = h.lead_id
  where h.status_id = 'UC_GKWGR0'
  group by 1
),
neg as (
  select h.lead_id, min(h.entered_at) as moment
  from bfl_lead_stage_history h
  join bfl b on b.lead_id = h.lead_id
  where h.status_id = '19'
    and h.lead_id not in (select lead_id from pos)
  group by 1
)
select 'дозвонились' as класс, lead_id, moment from pos
union all
select 'не отвечает месяц' as класс, lead_id, moment from neg;

-- ============================================================================
-- Сколько длится звонок, который менеджер считает дозвоном
--
-- Берём последний исходящий звонок перед переводом в «Дозвонились». Колонка
-- «часов от звонка до перевода» нужна как контроль качества связки: если
-- перевод делают сразу после разговора, значения будут в пределах часов, и
-- тогда звонок действительно тот самый. Если там недели — связка слабая, и
-- на такие строки опираться нельзя.
-- ============================================================================
drop view if exists bfl_dozvon_call_duration;
create view bfl_dozvon_call_duration with (security_invoker = true) as
with last_before as (
  select
    b.lead_id,
    b.moment,
    c.duration_sec,
    c.has_recording,
    c.started_at,
    row_number() over (partition by b.lead_id order by c.started_at desc, c.id desc) as rn
  from bfl_dozvon_labels b
  join bfl_lead_calls c on c.lead_id = b.lead_id
  where b.класс = 'дозвонились'
    and bfl_call_is_attempt(c.direction, c.completed)
    and c.started_at is not null
    and c.started_at <= b.moment
    and c.duration_sec between 0 and 3600
),
picked as (
  select
    lead_id,
    duration_sec,
    has_recording,
    round(extract(epoch from (moment - started_at)) / 3600.0, 1) as часов_до_перевода
  from last_before
  where rn = 1
)
select
  case
    when duration_sec < 5 then '1. меньше 5 с'
    when duration_sec < 10 then '2. 5-9 с'
    when duration_sec < 20 then '3. 10-19 с'
    when duration_sec < 35 then '4. 20-34 с'
    when duration_sec < 60 then '5. 35-59 с'
    when duration_sec < 120 then '6. 1-2 мин'
    when duration_sec < 300 then '7. 2-5 мин'
    else '8. больше 5 мин'
  end as длительность,
  count(*)::integer as лидов,
  count(*) filter (where has_recording)::integer as с_записью,
  round((percentile_cont(0.5) within group (order by часов_до_перевода))::numeric, 1)
    as медиана_часов_до_перевода,
  -- Если перевод случился в пределах суток, связка «этот звонок → этот
  -- перевод» надёжна. Доля таких строк — мера доверия к бакету.
  round(100.0 * count(*) filter (where часов_до_перевода <= 24)
        / nullif(count(*), 0), 1) as доля_перевода_в_сутки
from picked
group by 1;

-- ============================================================================
-- Главное: какой порог действительно разделяет дозвон и недозвон
--
-- Для каждого лида берём самый длинный его звонок до момента разметки, затем
-- на каждом пороге смотрим две величины:
--
--   поймали_дозвон — доля помеченных «Дозвонились», у которых такой звонок
--                    есть. Чем выше, тем меньше настоящих дозвонов теряем;
--   ложных         — доля помеченных «не отвечает месяц», у которых такой
--                    звонок тоже есть. Это ошибки: мы бы назвали дозвоном то,
--                    что дозвоном не было.
--
-- Правильный порог — там, где «разделение» (разница между двумя долями)
-- максимально. Это критерий Юдена, стандартный способ выбрать отсечку по
-- размеченной выборке, и он не зависит от того, каких лидов в выборке больше.
-- ============================================================================
drop view if exists bfl_dozvon_threshold_roc;
create view bfl_dozvon_threshold_roc with (security_invoker = true) as
with per_lead as (
  select
    b.класс,
    b.lead_id,
    max(c.duration_sec) as самый_длинный
  from bfl_dozvon_labels b
  left join bfl_lead_calls c
    on c.lead_id = b.lead_id
   and bfl_call_is_attempt(c.direction, c.completed)
   and c.started_at is not null
   and c.started_at <= b.moment
   and c.has_recording
   and c.duration_sec between 0 and 3600
  group by 1, 2
)
select
  t.sec::integer as порог_секунд,
  count(*) filter (where класс = 'дозвонились')::integer as лидов_с_меткой_дозвон,
  count(*) filter (where класс = 'не отвечает месяц')::integer as лидов_с_меткой_недозвон,
  round(100.0 * count(*) filter (where класс = 'дозвонились' and самый_длинный >= t.sec)
        / nullif(count(*) filter (where класс = 'дозвонились'), 0), 1) as поймали_дозвон,
  round(100.0 * count(*) filter (where класс = 'не отвечает месяц' and самый_длинный >= t.sec)
        / nullif(count(*) filter (where класс = 'не отвечает месяц'), 0), 1) as ложных,
  round(
    100.0 * count(*) filter (where класс = 'дозвонились' and самый_длинный >= t.sec)
      / nullif(count(*) filter (where класс = 'дозвонились'), 0)
    - 100.0 * count(*) filter (where класс = 'не отвечает месяц' and самый_длинный >= t.sec)
      / nullif(count(*) filter (where класс = 'не отвечает месяц'), 0)
  , 1) as разделение
from per_lead
cross join (values (5), (10), (15), (20), (30), (35), (45), (60), (90), (120), (180)) as t(sec)
group by t.sec;

-- ============================================================================
-- Сколько усилий занимает дозвон
--
-- Вторая половина вопроса «что такое дозвон и сколько он занимает»: сколько
-- попыток и сколько дней проходит от первого набора до момента, когда
-- менеджер признал лида дозвоненным. Нужно, чтобы правило остановки ставить
-- не наугад: если дозвон случается в среднем на пятой попытке и в пределах
-- недели, то двадцать попыток за месяц — это работа вхолостую.
-- ============================================================================
drop view if exists bfl_dozvon_effort;
create view bfl_dozvon_effort with (security_invoker = true) as
with per_lead as (
  select
    b.класс,
    b.lead_id,
    count(c.id)::integer as попыток_до_метки,
    min(c.started_at) as первая_попытка,
    b.moment
  from bfl_dozvon_labels b
  left join bfl_lead_calls c
    on c.lead_id = b.lead_id
   and bfl_call_is_attempt(c.direction, c.completed)
   and c.started_at is not null
   and c.started_at <= b.moment
  group by 1, 2, b.moment
)
select
  класс,
  count(*)::integer as лидов,
  round(avg(попыток_до_метки)::numeric, 1) as среднее_попыток,
  round((percentile_cont(0.5) within group (order by попыток_до_метки))::numeric, 1)
    as медиана_попыток,
  round((percentile_cont(0.9) within group (order by попыток_до_метки))::numeric, 1)
    as попыток_p90,
  round((percentile_cont(0.5) within group (
    order by extract(epoch from (moment - первая_попытка)) / 86400.0))::numeric, 1)
    as медиана_дней,
  round((percentile_cont(0.9) within group (
    order by extract(epoch from (moment - первая_попытка)) / 86400.0))::numeric, 1)
    as дней_p90,
  count(*) filter (where попыток_до_метки = 0)::integer as без_единого_звонка
from per_lead
group by 1;

-- ============================================================================
-- Глубина контакта: чего стоит разговор, добытый с пятнадцатой попытки
--
-- ЗАЧЕМ. Два вопроса сразу.
--
-- Первый — про экономику правила остановки. Предельный шанс дозвониться
-- падает с 18,84% на первой попытке до 1,38% на десятой и дальше упирается в
-- плоское дно 0,3-0,9% вплоть до сороковой. Попытки с 11-й по 40-ю это
-- 124 647 набоов, 56% всего обзвона, и 11% первых разговоров — 152 и 306
-- набоов на разговор против 12 на первых пяти попытках. Но если поздний
-- разговор вдобавок хуже конвертируется, цена ещё выше, и это надо знать
-- числом.
--
-- Второй — про Медведеву. Поправка на источники оставила её на 76,2% от
-- ожидания, но состав источников у неё как у всех (средняя ставка 62,4 против
-- 61,7-65,4 у остальных). Отличается другое: она достаёт 70,6% своей базы
-- против 38-55% у коллег. Разговоры, которых у других просто нет, по
-- определению с менее доступными людьми. Если конверсия падает с глубиной
-- контакта, её низкая конверсия — цена глубины, а не слабость, и вопрос
-- снимается.
-- ============================================================================
drop view if exists bfl_lead_first_contact cascade;
create view bfl_lead_first_contact with (security_invoker = true) as
with ordered as (
  select
    c.lead_id,
    l.source_marker,
    c.started_at,
    c.responsible_name,
    row_number() over (partition by c.lead_id order by c.started_at, c.id) as n,
    bfl_call_dialogue(c.has_recording, c.duration_sec) as dialogue
  from bfl_lead_calls c
  join bfl_lead_timings l on l.lead_id = c.lead_id
  where bfl_call_is_attempt(c.direction, c.completed)
    and c.started_at is not null
    and (l.source_marker is null
         or l.source_marker not in (select source_marker from bfl_excluded_sources))
),
ranked as (
  select
    lead_id, source_marker, started_at, responsible_name, n,
    row_number() over (partition by lead_id order by n) as rk
  from ordered
  where dialogue
)
select
  r.lead_id,
  r.source_marker,
  r.n as номер_попытки,
  r.started_at as заговорили_в,
  r.responsible_name as кто_дозвонился,
  (q.qual_at is not null and q.qual_at > r.started_at) as стал_квалом
from ranked r
left join bfl_lead_qual_moment q on q.lead_id = r.lead_id
where r.rk = 1;

drop view if exists bfl_qual_by_contact_depth;
create view bfl_qual_by_contact_depth with (security_invoker = true) as
select
  case
    when номер_попытки = 1 then '1. с первой попытки'
    when номер_попытки = 2 then '2. со второй'
    when номер_попытки = 3 then '3. с третьей'
    when номер_попытки <= 5 then '4. с 4-5-й'
    when номер_попытки <= 10 then '5. с 6-10-й'
    when номер_попытки <= 20 then '6. с 11-20-й'
    else '7. с 21-й и позже'
  end as заговорили,
  count(*)::integer as лидов,
  count(*) filter (where стал_квалом)::integer as квалов,
  round(100.0 * count(*) filter (where стал_квалом) / nullif(count(*), 0), 1)
    as конверсия_в_квал
from bfl_lead_first_contact
group by 1;

-- Тот же разрез по менеджерам: объясняет ли глубина охвата их конверсию
drop view if exists bfl_manager_contact_depth;
create view bfl_manager_contact_depth with (security_invoker = true) as
select
  coalesce(кто_дозвонился, '— не загружен —') as менеджер,
  count(*)::integer as первых_разговоров,
  round((percentile_cont(0.5) within group (order by номер_попытки))::numeric, 1)
    as медиана_попытки_контакта,
  count(*) filter (where номер_попытки <= 3)::integer as лёгких_контактов,
  round(100.0 * count(*) filter (where номер_попытки <= 3) / nullif(count(*), 0), 1)
    as доля_лёгких,
  count(*) filter (where номер_попытки >= 11)::integer as добытых_с_трудом,
  round(100.0 * count(*) filter (where номер_попытки >= 11) / nullif(count(*), 0), 1)
    as доля_добытых_с_трудом,
  round(100.0 * count(*) filter (where стал_квалом and номер_попытки <= 3)
        / nullif(count(*) filter (where номер_попытки <= 3), 0), 1)
    as конверсия_на_лёгких,
  round(100.0 * count(*) filter (where стал_квалом and номер_попытки >= 11)
        / nullif(count(*) filter (where номер_попытки >= 11), 0), 1)
    as конверсия_на_трудных
from bfl_lead_first_contact
group by 1;

-- ============================================================================
-- Дисциплина перезвона — главная витрина по стадии «Дозвонились»
--
-- Смысл стадии: трубку взяли, но момент был неподходящий — «занят,
-- перезвоните», «я на даче». Значит это не провал дозвона и не отсутствие
-- вердикта как такового, а НЕВЫПОЛНЕННАЯ ДОГОВОРЁННОСТЬ О ПЕРЕЗВОНЕ. И
-- цифры на это указывали: 1810 лидов получили после перевода в стадию по
-- 19,5 случайных набоов — то есть вместо звонка в условленное время человек
-- вернулся в общий котёл.
--
-- Проверяется имеющимися данными. Незавершённые активности (COMPLETED = 'N'),
-- которые мы исключили из попыток, — это и есть запланированные звонки, то
-- есть запись договорённости. Три состояния:
--
--   договорённость не зафиксирована — выполнить её нечем, она existует только
--                                     в голове менеджера;
--   зафиксирована, но не выполнена  — звонка около назначенного времени не было;
--   зафиксирована и выполнена       — позвонили в срок.
--
-- Конверсия в квал по этим трём группам показывает, сколько стоит дисциплина.
-- Окно выполнения — от двух часов до назначенного времени до суток после:
-- точность до минуты тут не нужна и была бы придиркой.
-- ============================================================================
drop view if exists bfl_dozvon_callback_discipline;
create view bfl_dozvon_callback_discipline with (security_invoker = true) as
with entry as (
  select lead_id, moment
  from bfl_dozvon_labels
  where класс = 'дозвонились'
),
plan as (
  select e.lead_id, min(c.started_at) as запланирован_на
  from entry e
  join bfl_lead_calls c on c.lead_id = e.lead_id
  where not c.completed
    and coalesce(c.direction, 2) = 2
    and c.started_at is not null
    and c.started_at >= e.moment
  group by 1
),
kept as (
  select p.lead_id
  from plan p
  join bfl_lead_calls c on c.lead_id = p.lead_id
  where bfl_call_is_attempt(c.direction, c.completed)
    and c.started_at between p.запланирован_на - interval '2 hours'
                        and p.запланирован_на + interval '1 day'
  group by 1
)
select
  case
    when p.lead_id is null then '1. договорённость не зафиксирована'
    when k.lead_id is null then '2. зафиксирована, но не выполнена'
    else '3. зафиксирована и выполнена'
  end as дисциплина,
  count(*)::integer as лидов,
  count(*) filter (where q.qual_at is not null and q.qual_at > e.moment)::integer as квалов,
  round(
    100.0 * count(*) filter (where q.qual_at is not null and q.qual_at > e.moment)
    / nullif(count(*), 0)
  , 1) as конверсия_в_квал,
  round(avg(extract(epoch from (now() - e.moment)) / 86400.0))::integer as средний_возраст_дней
from entry e
left join plan p on p.lead_id = e.lead_id
left join kept k on k.lead_id = e.lead_id
left join bfl_lead_qual_moment q on q.lead_id = e.lead_id
group by 1;

-- ============================================================================
-- Размер незакрытого решения
--
-- «Дозвонились» означает, что по лиду не приняли вердикт: ни квал, ни брак.
-- Поэтому здесь считается не конверсия, а ВОЗРАСТ нерешённого: сколько лидов
-- сидит в стадии прямо сейчас и как давно. Это предмет управленческого
-- решения, а не аналитики: по каждому дозвону должен быть исход.
-- ============================================================================
drop view if exists bfl_dozvon_pending_decision;
create view bfl_dozvon_pending_decision with (security_invoker = true) as
with entry as (
  select lead_id, moment
  from bfl_dozvon_labels
  where класс = 'дозвонились'
),
fate as (
  select
    e.lead_id,
    e.moment,
    l.status_name as сейчас_стоит_на,
    (q.qual_at is not null and q.qual_at > e.moment) as отквалили
  from entry e
  join bfl_lead_timings l on l.lead_id = e.lead_id
  left join bfl_lead_qual_moment q on q.lead_id = e.lead_id
)
select
  case
    when отквалили then '1. отквалили'
    when сейчас_стоит_на = 'Дозвонились' then '2. висит без решения'
    else '3. ушёл на другую стадию'
  end as исход,
  coalesce(сейчас_стоит_на, '—') as стадия_сейчас,
  count(*)::integer as лидов,
  round(avg(extract(epoch from (now() - moment)) / 86400.0))::integer as средний_возраст_дней,
  count(*) filter (where now() - moment > interval '30 days')::integer as старше_30_дней
from fate
group by 1, 2;
