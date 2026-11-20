import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('migration: same paid cohort, copies, all products, Moscow dates, roles and plans', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create table rop_deals (deal_id bigint primary key, lead_id bigint, title text,
        assigned_by_name text, source_name text, opportunity numeric, paid_at timestamptz, category_id int, stage_id text);
      create table rop_managers (manager_name text primary key, team text, active boolean);
      create table rop_plans (manager_name text, metric text, value numeric,
        constraint rop_plans_metric_check check (metric in ('оксвсего', 'среднийчек')));
      create function rop_client_key(title text) returns text language sql immutable as
        $$ select nullif(trim(regexp_replace(lower(split_part(title, '|', 1)), '[^a-zа-яё]+', ' ', 'g')), '') $$;
      create function rop_source_group(source text) returns text language sql immutable as $$ select coalesce(source, 'прочее') $$;
      create function rop_can_read() returns boolean language sql stable as
        $$ select current_setting('test.can_read', true) = 'yes' $$;
      create function is_staff() returns boolean language sql stable as
        $$ select current_setting('test.staff', true) = 'yes' $$;
      create function current_rop_team() returns text language sql stable as
        $$ select current_setting('test.team', true) $$;
      insert into rop_managers values ('A1','A',true), ('A2','A',false), ('B1','B',true);
      insert into rop_plans values ('A1','оксвсего',40);
      insert into rop_deals values
        (1,10,'Alpha | Банкротство','A1','маркетинг',150000,'2026-11-01 10:00Z',34,'C34:WON'),
        (2,null,'Alpha | Банкротство','A1','маркетинг',150000,'2026-11-01 10:00Z',34,'C34:WON'),
        (3,11,'Beta | ВБФЛ','A1','маркетинг',50000,'2026-11-02 10:00Z',34,'C34:UC_1KT09S'),
        (4,12,'Gamma | ФПА','A2','рекомендации',12500,'2026-11-02 10:00Z',34,'C34:WON'),
        (5,13,'Delta | БФЛ','A1','маркетинг',999999,null,34,'C34:PREPAYMENT_INVOIC'),
        (6,14,'Epsilon | БФЛ','A1','маркетинг',999999,'2026-11-02 10:00Z',99,'C99:WON'),
        (7,15,'Zeta | БФЛ','B1','маркетинг',250000,'2026-11-02 10:00Z',34,'C34:WON'),
        (8,16,'Eta | Новый продукт','A1','маркетинг',20000,'2026-10-31 22:30Z',34,'C34:WON'),
        (9,17,'Theta | БФЛ','A1','маркетинг',null,'2026-11-02 10:00Z',34,'C34:WON'),
        (10,18,'Iota | БФЛ','A1','маркетинг',0,'2026-11-02 10:00Z',34,'C34:WON');
    `)
    const migration = await readFile(new URL('../supabase/migrations/20261119_rop_contract_amounts.sql', import.meta.url), 'utf8')
    await db.exec(migration)
    await db.exec(migration) // re-application preserves existing data and grants
    await db.exec(`set test.can_read = 'yes'; set test.staff = 'no'; set test.team = 'A'; set role authenticated;`)
    const { rows } = await db.query(`select sum(сумма_договоров)::text as amount, sum(договоров)::int as contracts,
      sum(договоров_без_суммы)::int as missing from rop_portal_contract_amounts where дата >= '2026-11-01' and дата < '2026-12-01'`)
    assert.deepEqual(rows, [{ amount: '232500', contracts: 6, missing: 1 }])
    assert.equal((await db.query(`select * from rop_portal_contract_amounts where отдел = 'B'`)).rows.length, 0)
    await assert.rejects(db.query('select * from rop_contract_amounts'), /permission denied/)
    await assert.rejects(db.query('select * from rop_deals'), /permission denied/)
    await db.exec(`set test.staff = 'yes';`)
    assert.equal((await db.query(`select sum(сумма_договоров)::text as amount from rop_portal_contract_amounts`)).rows[0].amount, '482500')
    await db.exec(`set test.can_read = 'no';`)
    assert.equal((await db.query('select * from rop_portal_contract_amounts')).rows.length, 0)
    await db.exec(`reset role; set role anon;`)
    await assert.rejects(db.query('select * from rop_portal_contract_amounts'), /permission denied/)
    await db.exec(`reset role; insert into rop_plans values ('A1','договоры_сумма',150000.25);`)
    for (const bad of ["-1", "'NaN'", "'Infinity'", '1.001']) {
      await assert.rejects(db.query(`insert into rop_plans values ('A1','договоры_сумма',${bad})`), /check constraint/)
    }
    await assert.rejects(db.query(`insert into rop_plans values (null,'договоры_сумма',100)`), /check constraint/)
    assert.equal((await db.query(`select count(*)::int n from rop_plans where metric='оксвсего'`)).rows[0].n, 1)
  } finally { await db.close() }
})
