-- ============================================================================
-- Порог дозвона: сравнение на уровне ЗВОНКОВ, а не лидов.
--
-- ЧТО БЫЛО НЕ ТАК. Витрина bfl_dozvon_threshold_roc брала максимальную
-- длительность по всем звонкам лида. Но у двух классов число звонков
-- различается в четыре с половиной раза — 31,4 попытки у помеченных «не
-- отвечает более месяца» против 7,0 у помеченных «Дозвонились». Чем больше
-- бросков, тем выше максимум, чисто механически. В итоге доля ложных на
-- оптимуме вышла 52,4%, а разделение всего 20,6 при шкале до 100.
--
-- Направление искажения однозначно: оно ЗАВЫШАЕТ долю ложных и ЗАНИЖАЕТ
-- разделение. То есть 20 секунд как точка оптимума — оценка рабочая, просто
-- качество разделения там занижено.
--
-- КАК ПРАВИЛЬНО. Сравнивать отдельные звонки:
--   положительный класс — тот единственный звонок, после которого менеджер
--                         поставил метку «Дозвонились» (2616 звонков);
--   отрицательный класс — все звонки лидов, помеченных «не отвечает более
--                         месяца»: по утверждению самой воронки, дозвона
--                         среди них не было ни одного.
-- Тогда число попыток на лида в расчёт не входит вовсе.
--
-- ЧТО ОЖИДАЕТСЯ. По положительному классу доля звонков от 20 секунд уже
-- известна — 61,8%. По всем попыткам в системе таких около 13%. Если у
-- отрицательного класса выйдет близко к общему уровню, разделение окажется
-- не 20, а около 50, и порог можно будет зафиксировать уверенно.
--
-- ОГОВОРКА, КОТОРУЮ НАДО ДЕРЖАТЬ. Отрицательный класс не идеален: лид мог
-- один раз взять трубку, сказать «не звоните больше» и всё равно уехать в
-- архив по неответам. Такие звонки попадут в ложные и слегка занизят
-- разделение. Ошибка в безопасную сторону — порог получится скорее строже,
-- чем нужно, а не мягче.
-- ============================================================================

drop view if exists bfl_dozvon_threshold_roc_calls;
create view bfl_dozvon_threshold_roc_calls with (security_invoker = true) as
with pos as (
  select duration_sec, has_recording
  from (
    select
      c.duration_sec,
      c.has_recording,
      row_number() over (
        partition by b.lead_id order by c.started_at desc, c.id desc
      ) as rn
    from bfl_dozvon_labels b
    join bfl_lead_calls c on c.lead_id = b.lead_id
    where b.класс = 'дозвонились'
      and bfl_call_is_attempt(c.direction, c.completed)
      and c.started_at is not null
      and c.started_at <= b.moment
      and c.duration_sec between 0 and 3600
  ) t
  where rn = 1
),
neg as (
  select c.duration_sec, c.has_recording
  from bfl_dozvon_labels b
  join bfl_lead_calls c on c.lead_id = b.lead_id
  where b.класс = 'не отвечает месяц'
    and bfl_call_is_attempt(c.direction, c.completed)
    and c.started_at is not null
    and c.started_at <= b.moment
    and c.duration_sec between 0 and 3600
),
выборка as (
  select 'pos' as cls, duration_sec, has_recording from pos
  union all
  select 'neg' as cls, duration_sec, has_recording from neg
)
select
  t.sec::integer as порог_секунд,
  count(*) filter (where cls = 'pos')::integer as звонков_дозвона,
  count(*) filter (where cls = 'neg')::integer as звонков_недозвона,
  round(100.0 * count(*) filter (
    where cls = 'pos' and has_recording and duration_sec >= t.sec
  ) / nullif(count(*) filter (where cls = 'pos'), 0), 1) as поймали_дозвон,
  round(100.0 * count(*) filter (
    where cls = 'neg' and has_recording and duration_sec >= t.sec
  ) / nullif(count(*) filter (where cls = 'neg'), 0), 1) as ложных,
  round(
    100.0 * count(*) filter (where cls = 'pos' and has_recording and duration_sec >= t.sec)
      / nullif(count(*) filter (where cls = 'pos'), 0)
    - 100.0 * count(*) filter (where cls = 'neg' and has_recording and duration_sec >= t.sec)
      / nullif(count(*) filter (where cls = 'neg'), 0)
  , 1) as разделение
from выборка
cross join (values (5), (8), (10), (12), (15), (18), (20), (25), (30), (35), (45), (60)) as t(sec)
group by t.sec;

-- ============================================================================
-- Распределение длительностей в обоих классах — чтобы видеть, ЧЕМ они
-- различаются, а не только насколько
-- ============================================================================
drop view if exists bfl_dozvon_duration_compare;
create view bfl_dozvon_duration_compare with (security_invoker = true) as
with pos as (
  select duration_sec, has_recording
  from (
    select
      c.duration_sec,
      c.has_recording,
      row_number() over (
        partition by b.lead_id order by c.started_at desc, c.id desc
      ) as rn
    from bfl_dozvon_labels b
    join bfl_lead_calls c on c.lead_id = b.lead_id
    where b.класс = 'дозвонились'
      and bfl_call_is_attempt(c.direction, c.completed)
      and c.started_at is not null
      and c.started_at <= b.moment
      and c.duration_sec between 0 and 3600
  ) t
  where rn = 1
),
neg as (
  select c.duration_sec, c.has_recording
  from bfl_dozvon_labels b
  join bfl_lead_calls c on c.lead_id = b.lead_id
  where b.класс = 'не отвечает месяц'
    and bfl_call_is_attempt(c.direction, c.completed)
    and c.started_at is not null
    and c.started_at <= b.moment
    and c.duration_sec between 0 and 3600
),
выборка as (
  select 'дозвон' as класс, duration_sec, has_recording from pos
  union all
  select 'недозвон' as класс, duration_sec, has_recording from neg
)
select
  case
    when duration_sec = 0 then '0. ровно 0 с'
    when duration_sec < 5 then '1. 1-4 с'
    when duration_sec < 10 then '2. 5-9 с'
    when duration_sec < 15 then '3. 10-14 с'
    when duration_sec < 20 then '4. 15-19 с'
    when duration_sec < 35 then '5. 20-34 с'
    when duration_sec < 60 then '6. 35-59 с'
    when duration_sec < 120 then '7. 1-2 мин'
    else '8. больше 2 мин'
  end as длительность,
  count(*) filter (where класс = 'дозвон')::integer as звонков_дозвона,
  round(100.0 * count(*) filter (where класс = 'дозвон')
        / nullif(sum(count(*) filter (where класс = 'дозвон')) over (), 0), 1) as доля_дозвона,
  count(*) filter (where класс = 'недозвон')::integer as звонков_недозвона,
  round(100.0 * count(*) filter (where класс = 'недозвон')
        / nullif(sum(count(*) filter (where класс = 'недозвон')) over (), 0), 1) as доля_недозвона,
  count(*) filter (where класс = 'недозвон' and has_recording)::integer as из_них_с_записью
from выборка
group by 1;
