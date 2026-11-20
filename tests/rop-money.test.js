import test from 'node:test'
import assert from 'node:assert/strict'
import { MONEY_METRIC, moneyPlanFor, contractAmountTotal, parsePlanValue, formatContractMoney } from '../src/lib/ropMoney.js'

const plan = (manager_name, period, value, отдел = 'A') => ({ manager_name, period, value, отдел, metric: MONEY_METRIC })

test('full month: sum manager plans, ignore other teams, metrics and old department plans', () => {
  const plans = [plan('A1', '2026-10-01', 310000), plan('A2', '2026-10-01', 620000),
    plan('B1', '2026-10-01', 999999, 'B'), plan(null, '2026-10-01', 888888),
    { ...plan('A1', '2026-10-01', 40), metric: 'оксвсего' }]
  assert.equal(moneyPlanFor(plans, '2026-10-01', '2026-10-31', null, 'A'), 930000)
  assert.equal(moneyPlanFor(plans, '2026-10-01', '2026-10-31', 'A1', 'A'), 310000)
})

test('Thursday-Wednesday spanning months uses 3 October and 4 November days', () => {
  const plans = [plan('A1', '2026-10-01', 310000), plan('A1', '2026-11-01', 600000)]
  assert.equal(moneyPlanFor(plans, '2026-10-29', '2026-11-04', 'A1', 'A'), 110000)
  assert.equal(moneyPlanFor(plans, '2026-10-31', '2026-11-01', 'A1', 'A'), 30000)
})

test('leap month, year boundary, absent plan and explicit zero', () => {
  assert.equal(moneyPlanFor([plan('A1', '2028-02-01', 290000)], '2028-02-29', '2028-02-29'), 10000)
  const plans = [plan('A1', '2026-12-01', 310000), plan('A1', '2027-01-01', 620000)]
  assert.equal(moneyPlanFor(plans, '2026-12-31', '2027-01-01'), 30000)
  assert.equal(moneyPlanFor(plans, '2026-10-01', '2026-10-31'), null)
  assert.equal(moneyPlanFor([plan('A1', '2026-10-01', 0)], '2026-10-01', '2026-10-31'), 0)
})

test('department plan equals sum of displayed manager plans after rounding', () => {
  const plans = [plan('A1', '2026-10-01', 1), plan('A2', '2026-10-01', 1), plan('A3', '2026-10-01', 1)]
  const each = ['A1', 'A2', 'A3'].map(m => moneyPlanFor(plans, '2026-10-01', '2026-10-01', m))
  assert.equal(moneyPlanFor(plans, '2026-10-01', '2026-10-01'), each.reduce((a, b) => a + b, 0))
  assert.equal(formatContractMoney(0.09), '0,09 ₽')
})

test('contract totals include every product and track missing amounts', () => {
  const rows = [
    { менеджер: 'A1', сумма_договоров: '150000.10', договоров: 2, договоров_без_суммы: 1 },
    { менеджер: 'A1', сумма_договоров: '10000.20', договоров: 1 },
    { менеджер: 'A2', сумма_договоров: '25000', договоров: 1 },
  ]
  assert.deepEqual(contractAmountTotal(rows), { amount: 185000.3, missing: 1, contracts: 4 })
  assert.equal(contractAmountTotal(rows, 'A1').amount, 160000.3)
  assert.equal(contractAmountTotal(rows, 'A3').amount, 0)
})

test('blank removes a plan; invalid input must not silently remove a saved plan', () => {
  assert.equal(parsePlanValue(''), null)
  assert.equal(parsePlanValue('0'), 0)
  assert.equal(parsePlanValue('150 000,25'), 150000.25)
  for (const bad of ['abc', '-1', 'NaN', 'Infinity', '12.345', '1e6']) {
    assert.throws(() => parsePlanValue(bad))
  }
})
