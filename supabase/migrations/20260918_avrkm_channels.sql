-- ============================================================================
-- Аварком: вместо одного канала «3.0 АВАРКОМ» — пять групп каналов,
-- как в Автоправе. Источники раскладываются по ним.
--
-- Сопоставление задано шаблонами по lower(bitrix_name), а не списком точных
-- имён: в Битриксе у этих источников гуляет и регистр ("от михаила" /
-- "от Михаила"), и разделитель после префикса ("Avrkm." / "Avrkm -").
-- Точные имена ловить руками — значит промахнуться на первой же опечатке.
-- ============================================================================

insert into ap_channels (name, direction, sort_order) values
  ('3.1 2ГИС',          'avrkm', 31),
  ('3.2 Яндекс директ', 'avrkm', 32),
  ('3.3 От Комиссара',  'avrkm', 33),
  ('3.4 Каршеринг',     'avrkm', 34),
  ('3.5 Прочее',        'avrkm', 35)
on conflict (name) do nothing;

-- 2ГИС: "Avrkm. 2гис гор.", "Avrkm. 2гис сот."
update ap_sources s set channel_id = c.id
from ap_channels c
where c.name = '3.1 2ГИС'
  and s.direction = 'avrkm'
  and lower(s.bitrix_name) like '%2гис%';

-- Яндекс директ: "Avrkm - yandex.direct"
update ap_sources s set channel_id = c.id
from ap_channels c
where c.name = '3.2 Яндекс директ'
  and s.direction = 'avrkm'
  and (lower(s.bitrix_name) like '%yandex%' or lower(s.bitrix_name) like '%директ%');

-- От Комиссара: "Avrkm. от комиссара", "Avrkm. от комиссара ликвидный",
-- "Avrkm. от михаила"
update ap_sources s set channel_id = c.id
from ap_channels c
where c.name = '3.3 От Комиссара'
  and s.direction = 'avrkm'
  and (lower(s.bitrix_name) like '%комиссар%' or lower(s.bitrix_name) like '%михаил%');

-- Каршеринг: "Avrkm. Каршеринг"
update ap_sources s set channel_id = c.id
from ap_channels c
where c.name = '3.4 Каршеринг'
  and s.direction = 'avrkm'
  and lower(s.bitrix_name) like '%каршеринг%';

-- Прочее: "Avrkm - создан вручную", "Avrkm - звонок МОП" и всё, что не
-- подошло под правила выше (включая источники, которые появятся позже и
-- останутся висеть на старом канале). Идёт последним — подбирает остаток.
update ap_sources s set channel_id = c.id
from ap_channels c
where c.name = '3.5 Прочее'
  and s.direction = 'avrkm'
  and (
    s.channel_id is null
    or s.channel_id = (select id from ap_channels where name = '3.0 АВАРКОМ')
  );

-- ============================================================================
-- Расход
-- ============================================================================
-- За июнь и июль разбивка по источникам известна из Roistat, раскладываем
-- точно: июнь 415 225 + 385 125 = 800 350, июль 415 225 + 466 525 = 881 750 —
-- сходится с месячными итогами, которые были засеяны на канал целиком.
insert into ap_monthly_expenses (channel_id, month, spend)
select c.id, v.month::date, v.spend
from (values
  ('3.1 2ГИС',         '2026-06-01', 415225),
  ('3.3 От Комиссара', '2026-06-01', 385125),
  ('3.1 2ГИС',         '2026-07-01', 415225),
  ('3.3 От Комиссара', '2026-07-01', 466525)
) as v(channel_name, month, spend)
join ap_channels c on c.name = v.channel_name
on conflict (channel_id, month) do update set spend = excluded.spend, updated_at = now();

delete from ap_monthly_expenses
where channel_id = (select id from ap_channels where name = '3.0 АВАРКОМ')
  and month in ('2026-06-01', '2026-07-01');

-- За январь–май есть только месячные итоги по аваркому целиком, без разбивки
-- по источникам. Разносить их по каналам наугад нельзя, терять — тем более
-- (это ~3,3 млн ₽, и итог по группе АВАРКОМ обязан сойтись). Поэтому старый
-- канал остаётся жить как явная корзина нераспределённого расхода: источников
-- на нём больше нет, лидов и договоров он не даёт, только суммы за янв–май.
-- Появится разбивка — разнесёшь через «Ввод расходов» и обнулишь эту строку.
update ap_channels
set name = '3.9 Аварком — нераспределённый расход', sort_order = 39
where name = '3.0 АВАРКОМ';

-- ============================================================================
-- Косметика: настоящие названия договорных стадий воронки 36 вместо заглушек,
-- которые были засеяны до того, как названия стали известны. На расчёты не
-- влияет — витрина сверяется по stage_id.
-- ============================================================================
update ap_contract_stages set stage_name = v.name
from (values
  ('C36:UC_KYXKL2', '4. «Подписали договор»'),
  ('C36:3',         '5. Ждём разбор'),
  ('C36:4',         '6. Записываемся в СК'),
  ('C36:5',         '7. Подали документы в СК'),
  ('C36:6',         '8. Показали авто в СК'),
  ('C36:UC_LKTAXD', 'Ждем решение страховой компании'),
  ('C36:UC_2D12J9', 'Сделка не принята в ЮО Автоправо'),
  ('C36:UC_SW7C0N', '10. Передача ЮО Автоправо'),
  ('C36:10',        'ВС. Отправлен на ремонт'),
  ('C36:11',        'ВС. Отказано в выплате'),
  ('C36:WON',       '10. Успех (решение)')
) as v(stage_id, name)
where ap_contract_stages.category_id = 36
  and ap_contract_stages.stage_id = v.stage_id;
