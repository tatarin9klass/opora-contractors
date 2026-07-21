-- План подрядчика теперь вводится как лиды + расход + 3 конверсии между
-- этапами воронки (лид→квал, квал→встреча, встреча→сделка), а не как прямой
-- ввод квалов/встреч/сделок — приложение считает их само. Сами проценты
-- конверсии сохраняем отдельно (в дополнение к уже существующим
-- plan_quals/plan_meetings/plan_deals, которые остаются вычисленным
-- результатом), чтобы форму редактирования плана можно было открыть повторно
-- и увидеть, какие конверсии были заложены, а не только итоговые цифры.
alter table contractor_targets add column if not exists plan_cr_lq numeric;
alter table contractor_targets add column if not exists plan_cr_qm numeric;
alter table contractor_targets add column if not exists plan_cr_mo numeric;
