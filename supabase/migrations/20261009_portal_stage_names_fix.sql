-- ============================================================================
-- Стадии сопоставляются с памяткой по сути названия, а не по точному тексту.
--
-- ЧТО СЛОМАЛОСЬ. В кабинете «Звонок: Другой регион» показывался как «в
-- работе», хотя это брак. Памятка заполнялась по списку стадий, записанному
-- со слов, и часть названий в нём была без приставки «Звонок: », которая в
-- Битриксе есть. Сопоставление шло по точному совпадению текста, не нашло
-- пары — и стадия молча получила значение по умолчанию. Значение по
-- умолчанию выбрано «в работе» сознательно (лучше не обвинить подрядчика в
-- браке, чем обвинить зря), но здесь оно спрятало ошибку вместо того, чтобы
-- её показать.
--
-- ПОЧЕМУ НЕ ПРОСТО ДОПИСАТЬ ПРИСТАВКУ. Потому что завтра стадию переименуют
-- ещё раз, и повторится то же самое, причём снова молча. Поэтому:
--
--   1. Названия в памятке подтягиваются к ФАКТИЧЕСКИМ из данных — если
--      отличаются только приставкой «Звонок:» или регистром.
--   2. Группы и отметка «квал» проставляются по сути названия, а не по
--      точному тексту, так что приставка больше ни на что не влияет.
--   3. Стадии, которые есть в данных и которых нет в памятке, заводятся
--      автоматически с заглушкой вместо описания — их видно и на экране
--      «Доступы подрядчиков», и в выгрузке, а не теряются.
--
-- Эта миграция ничего не ломает, если названия и так совпадают: тогда первый
-- шаг не находит пар, второй переписывает значения теми же, третий не
-- добавляет строк.
-- ============================================================================

-- Суть названия: без приставки «Звонок:», без регистра и лишних пробелов.
-- «Звонок: Другой регион», «Другой регион» и «ДРУГОЙ РЕГИОН» дают один ключ.
create or replace function bfl_stage_key(name text)
returns text language sql immutable as $$
  select btrim(regexp_replace(lower(coalesce(name, '')), '^звонок\s*:?\s*', ''));
$$;

-- --- 1. Подтягиваем названия памятки к фактическим --------------------------
-- distinct on нужен на случай, если в данных окажутся две формы одного и того
-- же названия: берём первую по алфавиту, чтобы результат не зависел от
-- порядка строк в таблице.
with actual as (
  select distinct status_name from bfl_lead_timings where status_name is not null
),
pairs as (
  select distinct on (g.status_name)
    g.status_name as old_name,
    a.status_name as new_name
  from bfl_lead_stage_guide g
  join actual a on bfl_stage_key(a.status_name) = bfl_stage_key(g.status_name)
  where a.status_name is distinct from g.status_name
    -- Если запись с фактическим названием уже есть, переименование создало
    -- бы дубль первичного ключа. Такую пару пропускаем, лишнюю строку
    -- уберём ниже.
    and not exists (select 1 from bfl_lead_stage_guide g2 where g2.status_name = a.status_name)
  order by g.status_name, a.status_name
)
update bfl_lead_stage_guide g
set status_name = p.new_name
from pairs p
where g.status_name = p.old_name;

-- --- 2. Группы и «квал» — по сути названия ---------------------------------
update bfl_lead_stage_guide set outcome_group = 'квал', is_qual = true
where bfl_stage_key(status_name) in (
  'назначение встречи',
  'встреча назначена - точное время',
  'не интересно (условно)',
  'успех'
);

update bfl_lead_stage_guide set outcome_group = 'в работе', is_qual = false
where bfl_stage_key(status_name) in (
  'новый лид',
  'взят в работу',
  -- Обзвон на этой стадии не прекращается, заявка живая. Закрывает её уже
  -- «Не отвечает больше месяца».
  'не удалось дозвониться',
  'скорозвон',
  'дозвонились'
);

update bfl_lead_stage_guide set outcome_group = 'брак', is_qual = false
where bfl_stage_key(status_name) in (
  'ошибочная заявка',
  'другой регион',
  'не отвечает больше месяца',
  'дубль',
  'нл'
);

-- --- 3. Заводим стадии, которых в памятке нет ------------------------------
-- Группа «в работе» как безопасное значение: про незнакомую стадию мы не
-- знаем, брак это или нет, и приписывать подрядчику потери без оснований
-- нельзя. Описание — заглушка с прямым указанием, что делать: оно попадёт
-- подрядчику на экран, и пусть лучше он прочитает честное «уточняется», чем
-- увидит пустую клетку.
insert into bfl_lead_stage_guide (status_name, sort_order, is_qual, description, outcome_group)
select
  a.status_name,
  900,
  false,
  'Описание этой стадии пока не заполнено — уточните у менеджера ЮК Опора.',
  'в работе'
from (select distinct status_name from bfl_lead_timings where status_name is not null) a
where not exists (
  select 1 from bfl_lead_stage_guide g where g.status_name = a.status_name
)
on conflict (status_name) do nothing;

-- --- 4. Что осталось разобрать ---------------------------------------------
do $$
declare
  unknown_stages text;
  default_group text;
begin
  select string_agg(status_name, ', ')
  into unknown_stages
  from bfl_lead_stage_guide
  where sort_order = 900;
  if unknown_stages is not null then
    raise notice 'Новые стадии, заведённые автоматически (проверь группу и описание): %',
      unknown_stages;
  end if;

  -- order by внутри агрегата, а не у запроса: с агрегатом и без group by
  -- внешний order by — синтаксическая ошибка.
  select string_agg(status_name || ' → ' || outcome_group, '; ' order by sort_order)
  into default_group
  from bfl_lead_stage_guide;
  raise notice 'Итоговое распределение: %', default_group;
end $$;

-- ============================================================================
-- Проверить глазами после применения:
--
--   select status_name, outcome_group, is_qual
--   from bfl_lead_stage_guide order by outcome_group, sort_order;
--
--   select * from portal_stage_guide_gaps;   -- должно быть пусто
--
-- Группу и описание любой стадии можно поправить на экране «Доступы
-- подрядчиков» — без миграции.
-- ============================================================================
