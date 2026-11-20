import { test, expect } from '@playwright/test'

// All API traffic is intercepted. Only synthetic data; no production login.
async function fixture(page, role) {
  await page.clock.install({ time: new Date('2026-11-19T09:00:00Z') })
  const plans = [
    { id: 1, period: '2026-11-01', manager_name: 'Менеджер А', team: 'A', отдел: 'A', metric: 'договоры_сумма', value: 300000 },
    { id: 2, period: '2026-11-01', manager_name: 'Менеджер Б', team: 'A', отдел: 'A', metric: 'договоры_сумма', value: 200000 },
  ]
  const managers = [
    { manager_name: 'Менеджер А', team: 'A', отдел: 'A', active: true, sort_order: 1 },
    { manager_name: 'Менеджер Б', team: 'A', отдел: 'A', active: true, sort_order: 2 },
  ]
  const amount = [{ дата: '2026-11-02', отдел: 'A', менеджер: 'Менеджер А', работает: true,
    сумма_договоров: 150000, договоров: 1, договоров_без_суммы: 0 }]
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1') return route.continue()
    if (!url.hostname.endsWith('.supabase.co')) return route.abort()
    const table = url.pathname.split('/').pop()
    let body = []
    if (table === 'profiles') body = { id: '00000000-0000-4000-8000-000000000001', role, email: 'test@example.invalid' }
    if (table === 'rop_portal_teams') body = [{ отдел: 'A', название: 'Тестовый отдел', sort_order: 1 }]
    if (table === 'rop_portal_managers' || table === 'rop_managers') body = managers
    if (table === 'rop_portal_contract_amounts') body = amount
    if (table === 'rop_portal_daily') body = [{ дата: '2026-11-02', отдел: 'A', окс_бфл: 1, окс_всего: 1 }]
    if (table === 'rop_portal_manager') body = [{ дата: '2026-11-02', отдел: 'A', менеджер: 'Менеджер А', работает: true, окс_бфл: 1 }]
    if (table === 'rop_plans' || table === 'rop_portal_plans') {
      if (route.request().method() === 'POST') {
        for (const p of route.request().postDataJSON()) plans.push({ ...p, id: 99, отдел: p.team })
      }
      if (route.request().method() === 'DELETE') {
        const ids = url.searchParams.get('id').replace('in.(', '').replace(')', '').split(',').map(Number)
        for (let i = plans.length - 1; i >= 0; i--) if (ids.includes(plans[i].id)) plans.splice(i, 1)
      }
      if (route.request().method() === 'PATCH') {
        const id = Number(url.searchParams.get('id').replace('eq.', ''))
        Object.assign(plans.find(p => p.id === id), route.request().postDataJSON())
      }
      body = plans
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.addInitScript(() => {
    const user = { id: '00000000-0000-4000-8000-000000000001', email: 'test@example.invalid' }
    const payload = btoa(JSON.stringify({ sub: user.id, exp: 2208988800 }))
    localStorage.setItem('sb-jgmuuehxavwlrfkonnzx-auth-token', JSON.stringify({
      access_token: `e30.${payload}.test`, refresh_token: 'synthetic-test-token',
      token_type: 'bearer', expires_at: 2208988800, user,
    }))
  })
  await page.goto('/')
  if (role === 'admin') await page.locator('.nav-item').filter({ hasText: 'Отдел продаж' }).click()
  return { plans, errors }
}

for (const role of ['rop', 'admin']) {
  test(`${role}: dashboard, managers with zero sales, save monthly amount plan`, async ({ page }) => {
    const { plans, errors } = await fixture(page, role)
    const card = page.locator('.rop-metric').filter({ hasText: 'Сумма заключённых договоров' })
    await expect(card).toContainText('150 000 ₽')
    await expect(card).toContainText('500 000 ₽')
    await expect(card).toContainText('30%')
    await page.getByRole('button', { name: 'Менеджеры', exact: true }).click()
    await expect(page.getByRole('row').filter({ hasText: 'Менеджер Б' })).toContainText('200 000 ₽')
    await expect(page.getByRole('row').filter({ hasText: 'Отдел целиком' })).toContainText('150 000 ₽')
    await page.getByRole('button', { name: 'Планы', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'Менеджер Б: Сумма договоров, ₽' })
    await input.fill('не число')
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('button', { name: /Нет изменений|Сохранить/ })).toBeDisabled()
    await input.fill('250 000')
    await page.getByRole('button', { name: 'Сохранить (1)' }).click()
    await expect(page.getByText('Сохранено. Изменений: 1.')).toBeVisible()
    expect(plans.find(p => p.id === 2).value).toBe(250000)
    await page.getByRole('button', { name: 'Главное', exact: true }).click()
    await expect(card).toContainText('550 000 ₽')
    await expect(card).toContainText('27%')
    await page.getByRole('button', { name: 'Планы', exact: true }).click()
    await input.fill('')
    await page.getByRole('button', { name: 'Сохранить (1)' }).click()
    await expect(page.getByText('Сохранено. Изменений: 1.')).toBeVisible()
    expect(plans.some(p => p.manager_name === 'Менеджер Б')).toBe(false)
    await input.fill('200000')
    await page.getByRole('button', { name: 'Сохранить (1)' }).click()
    await expect(page.getByText('Сохранено. Изменений: 1.')).toBeVisible()
    expect(plans.find(p => p.manager_name === 'Менеджер Б').value).toBe(200000)
    await page.getByRole('button', { name: 'Главное', exact: true }).click()
    await expect(card).toContainText('500 000 ₽')
    // Standalone portal has the mobile layout; the admin shell is desktop.
    if (role === 'rop') await page.setViewportSize({ width: 390, height: 844 })
    await expect(card).toBeVisible()
    const box = await card.boundingBox()
    expect(box.width).toBeGreaterThan(300)
    await page.screenshot({ path: `test-results/${role}-money.png`, fullPage: true })
    expect(errors).toEqual([])
  })
}
