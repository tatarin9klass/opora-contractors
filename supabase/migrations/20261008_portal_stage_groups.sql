-- ============================================================================
-- Стадии делятся на три исхода: засчитано, ещё в работе, не засчитано.
--
-- ЗАЧЕМ. В кабинете четырнадцать стадий одним списком. Подрядчику из такого
-- списка не видно главного — за что ему засчитали, что ещё может
-- засчитаться, а что отбраковано. А это ровно те три вопроса, ради которых
-- он кабинет и открывает: «Дозвонились» и «Другой регион» для него
-- принципиально разные вещи, хотя в списке стоят рядом и выглядят одинаково.
--
-- ТРИ ИСХОДА, А НЕ ДВА. Деление на «квал / не квал» было бы враньём: у
-- свежей заявки, которая вчера пришла и стоит на «Взят в работу», исход ещё
-- не наступил. Свалив её в брак, мы показали бы подрядчику брак там,
-- где просто не прошло время, — и он пришёл бы спорить о цифре, которая
-- завтра изменится сама.
--
--   квал         — заявка признана квалифицированной, работа принята;
--   в работе     — исход ещё не определён, заявка живая;
--   брак         — заявка закрыта без результата.
--
-- ОТКУДА ВЗЯТО РАСПРЕДЕЛЕНИЕ. Из списка стадий воронки БФЛ, который дал
-- руководитель направления, и из отметки «КВАЛ» в нём. Спорных стадий две,
-- и обе названы прямо в комментариях ниже. Если распределение где-то
-- неверно, оно правится на экране «Доступы подрядчиков», без миграции.
-- ============================================================================

alter table bfl_lead_stage_guide
  add column if not exists outcome_group text not null default 'в работе';

alter table bfl_lead_stage_guide drop constraint if exists bfl_lead_stage_guide_outcome_check;
alter table bfl_lead_stage_guide add constraint bfl_lead_stage_guide_outcome_check
  check (outcome_group in ('квал', 'в работе', 'брак'));

comment on column bfl_lead_stage_guide.outcome_group is
  'Исход заявки для подрядчика: квал / в работе / брак. Показывается '
  'в кабинете группировкой стадий и работает фильтром.';

-- Квал — ровно четыре стадии, отмеченные как КВАЛ.
update bfl_lead_stage_guide set outcome_group = 'квал' where is_qual;

-- Живые стадии: заявка в обзвоне, исход не наступил.
--
-- «Не удалось дозвониться» здесь, а не в «не засчитано», намеренно: обзвон
-- на этой стадии НЕ прекращается, лид остаётся в работе и попытки
-- продолжаются. Закрывает его уже «Не отвечает больше месяца».
update bfl_lead_stage_guide set outcome_group = 'в работе'
where status_name in (
  'Новый лид', 'Взят в работу', 'Не удалось дозвониться', 'Скорозвон', 'Дозвонились'
);

-- Брак: заявка закрыта без результата.
--
-- «Звонок НЛ» — техническая стадия телефонии, содержательного исхода у неё
-- нет. Отнесена сюда, потому что заявка на ней не движется; если окажется,
-- что по ней продолжают работать, группу надо сменить на «в работе» на
-- экране «Доступы подрядчиков».
update bfl_lead_stage_guide set outcome_group = 'брак'
where status_name in (
  'Звонок: Ошибочная заявка', 'Другой регион', 'Не отвечает больше месяца',
  'Дубль', 'Звонок НЛ'
);

-- Проверка: нераспределённых стадий остаться не должно. Если появилась новая
-- стадия, она по умолчанию попадёт в «в работе» — это безопасный вариант
-- (не обвиняет подрядчика в браке), но знать о ней надо.
do $$
declare n integer;
begin
  select count(*) into n from bfl_lead_stage_guide where outcome_group = 'в работе';
  raise notice 'В группе «в работе»: % стадий. Если больше пяти — появилась новая, проверь её группу.', n;
end $$;

-- --- Кабинет видит группу --------------------------------------------------
drop view if exists portal_stage_guide;
create view portal_stage_guide as
select g.status_name, g.is_qual, g.description, g.sort_order, g.outcome_group
from bfl_lead_stage_guide g
where current_contractor_id() is not null;

revoke all on portal_stage_guide from anon;
grant select on portal_stage_guide to authenticated;

-- --- Построчные заявки тоже --------------------------------------------------
-- Группа нужна прямо в строке заявки: по ней идёт фильтр и она уходит в
-- выгрузку отдельной колонкой. Считать её на клиенте по названию стадии
-- значило бы держать справочник в двух местах.
drop view if exists portal_my_leads;
create view portal_my_leads as
select
  l.lead_id,
  l.created_at,
  l.phone,
  l.source_marker,
  coalesce(l.status_name, '— не определена —') as stage,
  coalesce(g.is_qual, false) as is_qual,
  coalesce(g.outcome_group, 'в работе') as outcome_group,
  l.utm_source,
  l.utm_medium,
  l.utm_campaign,
  l.utm_content,
  l.utm_term,
  nullif(concat_ws(' / ',
    nullif(l.utm_source, ''), nullif(l.utm_medium, ''),
    nullif(l.utm_campaign, ''), nullif(l.utm_content, ''),
    nullif(l.utm_term, '')
  ), '') as utm
from bfl_lead_timings l
join portal_source_owner o
  on o.marker_lower = lower(l.source_marker)
 and o.contractors_count = 1
left join bfl_lead_stage_guide g on g.status_name = l.status_name
where o.contractor_id = current_contractor_id();

revoke all on portal_my_leads from anon;
grant select on portal_my_leads to authenticated;

comment on view portal_my_leads is
  'Выгрузка кабинета: лиды по дате СОЗДАНИЯ, стадия — фактическая на сейчас. '
  'С дашбордом по датам НЕ сходится, это разные вопросы. Данные есть с '
  '2026-04-01 — раньше построчная история не импортировалась.';
