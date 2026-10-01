-- ============================================================================
-- Звонки по лидам БФЛ.
--
-- ЗАЧЕМ. Это последний недостающий кусок. История стадий показывает, что лид
-- провалился в недозвон, но не показывает, сколько раз ему звонили. А без
-- этого нельзя различить две совершенно разные ситуации: мёртвый номер и
-- одну-единственную попытку. Разброс конверсии недозвона по источникам (от
-- 2% до 56%) объясняется либо первым, либо вторым, и до сих пор мы гадали.
--
-- Заодно решается проблема атрибуции: при передаче в Скорозвон ответственный
-- у лида подменяется техническим «Информатором», поэтому по лиду не понять,
-- кто с ним работал. В звонке же стоит RESPONSIBLE_ID того, кто реально
-- звонил, и подмена его не затрагивает.
--
-- КАК ОПРЕДЕЛЯЕТСЯ ДОЗВОН. Явного поля «взяли трубку» в активности нет.
-- Надёжный признак — наличие записи разговора: проверено на выборке, у всех
-- отвеченных звонков запись есть и длительность больше нуля, у неотвеченных
-- записи нет и START_TIME совпадает с END_TIME. Длительность храним отдельно
-- как второй признак, чтобы правило можно было перепроверить на данных.
--
-- ЧТО НЕ СЧИТАЕТСЯ ПОПЫТКОЙ. Активности с COMPLETED = 'N' — это
-- запланированные звонки («перезвонить 8 октября»), а не состоявшиеся.
-- Они лежат в таблице, но в витрины не идут.
-- ============================================================================

create table if not exists bfl_lead_calls (
  id bigint primary key,
  lead_id bigint not null,
  responsible_id bigint,
  responsible_name text,
  direction smallint,           -- 1 входящий, 2 исходящий
  completed boolean not null default true,
  started_at timestamptz,
  ended_at timestamptz,
  duration_sec integer,
  has_recording boolean not null default false,
  origin_id text,               -- по префиксу видно, через какую телефонию прошёл звонок
  subject text,
  synced_at timestamptz not null default now()
);

create index if not exists bfl_calls_lead_idx on bfl_lead_calls(lead_id);
create index if not exists bfl_calls_started_idx on bfl_lead_calls(started_at);
create index if not exists bfl_calls_resp_idx on bfl_lead_calls(responsible_id);

create table if not exists bfl_calls_sync_state (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- По каждому лиду: сколько попыток, дозвонились ли, стал ли квалом
-- ============================================================================
drop view if exists bfl_calls_by_lead;
create view bfl_calls_by_lead with (security_invoker = true) as
select
  l.lead_id,
  l.source_marker,
  l.status_name as стадия_лида,
  count(c.id) filter (where c.completed)::integer as попыток,
  count(c.id) filter (where c.completed and c.has_recording)::integer as дозвонов,
  min(c.started_at) filter (where c.completed) as первая_попытка,
  max(c.started_at) filter (where c.completed) as последняя_попытка,
  (l.qualified_at is not null) as стал_квалом
from bfl_lead_timings l
left join bfl_lead_calls c on c.lead_id = l.lead_id
where l.source_marker is null
   or l.source_marker not in (select source_marker from bfl_excluded_sources)
group by l.lead_id, l.source_marker, l.status_name, l.qualified_at;

-- ============================================================================
-- Главное: сколько попыток делают по источникам и чем это кончается
--
-- Если по источнику с низкой конверсией делают одну попытку, а по источнику
-- с высокой — пять, дело в обзвоне. Если попыток поровну, а результат разный
-- — дело в номерах.
-- ============================================================================
drop view if exists bfl_calls_by_source;
create view bfl_calls_by_source with (security_invoker = true) as
select
  source_marker as источник,
  count(*)::integer as лидов,
  round(avg(попыток)::numeric, 1) as среднее_попыток,
  round((percentile_cont(0.5) within group (order by попыток))::numeric, 1) as медиана_попыток,
  count(*) filter (where попыток = 0)::integer as без_единой_попытки,
  count(*) filter (where дозвонов > 0)::integer as дозвонились,
  round(100.0 * count(*) filter (where дозвонов > 0) / nullif(count(*), 0), 1) as доля_дозвона,
  count(*) filter (where стал_квалом)::integer as квалов,
  round(100.0 * count(*) filter (where стал_квалом) / nullif(count(*), 0), 1) as конверсия_в_квал
from bfl_calls_by_lead
where source_marker is not null
group by 1;

-- ============================================================================
-- Кто звонит — в обход подмены ответственного на «Информатора»
-- ============================================================================
drop view if exists bfl_calls_by_manager;
create view bfl_calls_by_manager with (security_invoker = true) as
select
  coalesce(c.responsible_name, '— не загружен —') as менеджер,
  count(*)::integer as звонков,
  count(*) filter (where c.has_recording)::integer as дозвонов,
  round(100.0 * count(*) filter (where c.has_recording) / nullif(count(*), 0), 1) as доля_дозвона,
  count(distinct c.lead_id)::integer as лидов,
  round(count(*)::numeric / nullif(count(distinct c.lead_id), 0), 1) as попыток_на_лид,
  round(avg(c.duration_sec) filter (where c.has_recording))::integer as средняя_длительность_сек
from bfl_lead_calls c
join bfl_lead_timings l on l.lead_id = c.lead_id
where c.completed
  and (l.source_marker is null
       or l.source_marker not in (select source_marker from bfl_excluded_sources))
group by 1;

-- ============================================================================
-- В какое время звонят и когда берут трубку.
--
-- Часы считаются по новосибирскому времени: звонят и отвечают люди, живущие
-- именно в нём, а не в московском, по которому Битрикс отдаёт даты.
-- ============================================================================
drop view if exists bfl_calls_by_hour;
create view bfl_calls_by_hour with (security_invoker = true) as
select
  extract(hour from (c.started_at at time zone 'Asia/Novosibirsk'))::integer as час,
  count(*)::integer as звонков,
  count(*) filter (where c.has_recording)::integer as дозвонов,
  round(100.0 * count(*) filter (where c.has_recording) / nullif(count(*), 0), 1) as доля_дозвона
from bfl_lead_calls c
join bfl_lead_timings l on l.lead_id = c.lead_id
where c.completed and c.started_at is not null
  and (l.source_marker is null
       or l.source_marker not in (select source_marker from bfl_excluded_sources))
group by 1;

-- ============================================================================
-- После какой попытки перестают звонить и после какой начинают дозваниваться
-- ============================================================================
drop view if exists bfl_calls_attempt_profile;
create view bfl_calls_attempt_profile with (security_invoker = true) as
with numbered as (
  select
    c.lead_id,
    c.has_recording,
    row_number() over (partition by c.lead_id order by c.started_at) as номер_попытки
  from bfl_lead_calls c
  join bfl_lead_timings l on l.lead_id = c.lead_id
  where c.completed and c.started_at is not null
    and (l.source_marker is null
         or l.source_marker not in (select source_marker from bfl_excluded_sources))
)
select
  номер_попытки::integer,
  count(*)::integer as сделано_звонков,
  count(*) filter (where has_recording)::integer as дозвонились,
  round(100.0 * count(*) filter (where has_recording) / nullif(count(*), 0), 1) as доля_дозвона
from numbered
where номер_попытки <= 15
group by 1;

-- ============================================================================
-- RLS
-- ============================================================================
do $$
declare
  tbl text;
  tables text[] := array['bfl_lead_calls', 'bfl_calls_sync_state'];
begin
  foreach tbl in array tables loop
    execute format('alter table if exists %I enable row level security', tbl);
    execute format('drop policy if exists "authenticated_select" on %I', tbl);
    execute format('create policy "authenticated_select" on %I for select using (auth.uid() is not null)', tbl);
    execute format('drop policy if exists "admin_write" on %I', tbl);
    execute format('create policy "admin_write" on %I for all using (is_admin()) with check (is_admin())', tbl);
  end loop;
end $$;
