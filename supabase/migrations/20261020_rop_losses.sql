-- ============================================================================
-- Потери по причинам.
--
-- ОТДЕЛЬНОГО ПОЛЯ «ПРИЧИНА ОТКАЗА» В ВОРОНКЕ НЕТ, и искать его не нужно:
-- причина и есть стадия, на которой сделка закрылась. Их четыре —
-- «Встреча: брак», «Не интересно (условно)», «Долг меньше 150 000» и
-- «Дорого (условно)», — и первая из них ничего не объясняет.
--
-- ИМЕННО ЭТО И ЕСТЬ ГЛАВНАЯ НАХОДКА ПРОШЛОГО РАЗБОРА: в общую корзину
-- «Встреча: брак» падает большинство потерь, и по ним потом невозможно
-- понять, что произошло. Пока «брак» показан одной цифрой, разговаривать с
-- менеджером не о чем: 29% — это не повод, это сводка. А «из тридцати
-- девяти потерь двадцать две закрыты без указания причины» — повод.
--
-- ПОЧЕМУ ПОТЕРЯ ОТНОСИТСЯ К ДНЮ ЗАКРЫТИЯ. Сделка могла прийти в июне, а
-- закрыться в октябре; усилие на неё потрачено в октябре, и в октябрьских
-- потерях она и должна быть. Это та же логика события по своей дате, по
-- которой живёт весь остальной учёт.
-- ============================================================================

drop view if exists rop_lost_daily cascade;
create view rop_lost_daily as
select
  (coalesce(d.closedate, d.moved_time) at time zone 'Europe/Moscow')::date as дата,
  m.team as отдел,
  d.assigned_by_name as менеджер,
  d.stage_id,
  coalesce(d.stage_name, d.stage_id) as причина,
  -- Общая корзина: стадия, которая не называет причину. Вынесена флагом,
  -- чтобы экран мог показать её отдельно, не зная кодов стадий.
  (d.stage_id = 'C34:7') as без_причины,
  rop_source_group(d.source_name) as группа,
  count(*)::integer as сделок
from rop_deals d
join rop_managers m on m.manager_name = d.assigned_by_name and m.team is not null
where d.category_id = 34
  and coalesce(d.closed, false) = true
  and d.stage_id <> 'C34:WON'
  and coalesce(d.closedate, d.moved_time) is not null
group by 1, 2, 3, 4, 5, 6, 7;

revoke all on rop_lost_daily from anon, authenticated;

comment on view rop_lost_daily is
  'Потерянные сделки по дню закрытия и причине. Причина — это стадия: '
  'отдельного поля в воронке нет. «Встреча: брак» помечена как потеря без '
  'причины.';

drop view if exists rop_portal_lost;
create view rop_portal_lost as
select l.*
from rop_lost_daily l
where rop_can_read()
  and (is_staff() or l.отдел = current_rop_team());

revoke all on rop_portal_lost from anon;
grant select on rop_portal_lost to authenticated;

-- ============================================================================
-- Проверка
--
--   select причина, sum(сделок) from rop_portal_lost
--   where дата >= date_trunc('month', current_date) group by 1 order by 2 desc;
--
-- Сумма по всем причинам должна сойтись с числом закрытых не-успехом
-- сделок за месяц, а строка «Встреча: брак» — показать, сколько потерь
-- закрыто без объяснения.
-- ============================================================================
