// Prints automáticos das telas com Supabase simulado (dados de e2e/fixtures.mjs).
import fs from 'node:fs'
import { chromium } from 'playwright'
import { tables, user } from './fixtures.mjs'

const BASE = process.env.APP_URL ?? 'http://localhost:4173'
const OUT = 'shots'
fs.mkdirSync(OUT, { recursive: true })
const log = []

function applyFilters(rows, params) {
  let out = rows
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or'].includes(k)) continue
    const m = v.match(/^(not\.)?(eq|neq|gte|gt|lte|lt|in|ilike|like|is)\.(.*)$/s)
    if (!m) continue
    const [, not, op, raw] = m
    const test = (x) => {
      const val = x?.[k]
      switch (op) {
        case 'eq': return String(val) === raw
        case 'neq': return String(val) !== raw
        case 'gte': return val >= raw
        case 'gt': return val > raw
        case 'lte': return val <= raw
        case 'lt': return val < raw
        case 'in': return raw.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')).includes(String(val))
        case 'is': return raw === 'null' ? val == null : String(val) === raw
        default: return new RegExp(raw.replace(/\*/g, '.*').replace(/%/g, '.*'), 'i').test(String(val ?? ''))
      }
    }
    out = out.filter((x) => (not ? !test(x) : test(x)))
  }
  const order = params.get('order')
  if (order) {
    const [col, dir] = order.split(',')[0].split('.')
    out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1))
  }
  return out
}

async function mock(page) {
  await page.route('https://mock.supabase.co/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (body, status = 200, headers = {}) =>
      route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', ...headers }, body: JSON.stringify(body) })
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
    if (url.pathname.startsWith('/auth/v1/user')) {
      // como o Supabase de verdade: PUT grava o user_metadata e devolve o usuário atualizado
      if (req.method() === 'PUT') {
        const body = JSON.parse(req.postData() || '{}')
        user.user_metadata = { ...user.user_metadata, ...(body.data ?? {}) }
      }
      return json(user)
    }
    if (url.pathname.startsWith('/auth/v1/')) return json({})
    const table = url.pathname.replace('/rest/v1/', '')
    if (req.method() !== 'GET' && req.method() !== 'HEAD') return json([], 201)
    let rows = applyFilters(tables[table] ?? [], url.searchParams)
    const total = rows.length
    const range = req.headers()['range']
    if (range) {
      const [a, b] = range.split('-').map(Number)
      rows = rows.slice(a, b + 1)
    }
    const single = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object')
    return json(single ? (rows[0] ?? null) : rows, 200, { 'content-range': `0-${Math.max(0, rows.length - 1)}/${total}` })
  })
}

const session = {
  access_token: 'demo', refresh_token: 'demo', token_type: 'bearer', expires_in: 3600 * 24 * 365,
  expires_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 365, user,
}

// Open Finance de mentira (só para os prints da seção de cartões)
const OF_CARDS = {
  at: '2026-11-08T14:00:00.000Z',
  today: '2026-11-08',
  cards: [
    { itemId: 'i1', accountId: 'a1', name: 'Itaú Visa Platinum', number: '4417', usedCents: 412000, limitCents: 900000, availableCents: 488000, minimumPaymentCents: 39500, closeDate: '2026-11-21', dueDate: '2026-11-28', openCents: 98000, cycleFrom: '2026-10-21', bills: [{ id: 'b1', dueDate: '2026-10-28', totalCents: 263892, paidCents: 263892 }], bank: 'Itaú' },
    { itemId: 'i2', accountId: 'a2', name: 'PicPay Mastercard Gold', number: '8812', usedCents: 618000, limitCents: 700000, availableCents: 82000, minimumPaymentCents: 61000, closeDate: '2026-11-09', dueDate: '2026-11-16', openCents: 121000, cycleFrom: '2026-10-09', bills: [{ id: 'b2', dueDate: '2026-11-16', totalCents: 158966, paidCents: 0 }], bank: 'PicPay' },
    { itemId: 'i3', accountId: 'a3', name: 'Inter Black', number: '0031', usedCents: 34000, limitCents: 300000, availableCents: 266000, minimumPaymentCents: null, closeDate: '2026-11-25', dueDate: '2026-12-02', openCents: 34000, cycleFrom: '2026-10-25', bills: [], bank: 'Inter' },
  ],
}

async function shoot(browser, { name, path, theme = 'light', width = 390, height = 844, before, of = false }) {
  const baseMeta = user.user_metadata
  if (of) user.user_metadata = { ...baseMeta, pluggy_items: [{ itemId: 'i1', bank: 'Itaú' }, { itemId: 'i2', bank: 'PicPay' }, { itemId: 'i3', bank: 'Inter' }] }
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' })
  const page = await ctx.newPage()
  await page.clock.setFixedTime(new Date('2026-11-08T15:00:00-03:00'))
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && log.push(`[${name}] ${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => log.push(`[${name}] PAGEERROR: ${e.message}`))
  await mock(page)
  await page.addInitScript(([s, t, ofc]) => {
    if (ofc) {
      localStorage.setItem('finance:of-cards', JSON.stringify(ofc))
      localStorage.setItem('finance:of-auto', JSON.stringify({ at: new Date().toISOString(), fresh: 0, from: '', to: '', tagged: 0, error: null }))
    }
    if (s) localStorage.setItem('sb-mock-auth-token', JSON.stringify(s))
    localStorage.setItem('finance-pwa:theme', t)
    localStorage.setItem('finance:passkey-prompt-dismissed', '1')
  }, [path === '/login' ? null : { ...session, user }, theme, of ? OF_CARDS : null])
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  if (before) await before(page)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
  await ctx.close()
  user.user_metadata = baseMeta
}

const browser = await chromium.launch()
const screens = [
  { name: '01-inicio', path: '/' },
  { name: '02-inicio-escuro', path: '/', theme: 'dark' },
  { name: '03-extrato', path: '/transactions' },
  { name: '04-extrato-editar', path: '/transactions', before: async (p) => { await p.locator('button[aria-expanded]').first().click(); await p.waitForTimeout(400) } },
  { name: '05-adicionar', path: '/import' },
  { name: '06-orcamento', path: '/orcamento' },
  { name: '07-metas', path: '/metas' },
  { name: '08-mes', path: '/mes' },
  { name: '09-fechamento', path: '/fechamento' },
  { name: '10-visao-geral', path: '/historico' },
  { name: '11-menu', path: '/', before: async (p) => { await p.getByRole('button', { name: /menu|conta|perfil|mais/i }).first().click().catch(() => {}); await p.waitForTimeout(400) } },
  { name: '12-login', path: '/login' },
  { name: '13-extrato-escuro', path: '/transactions', theme: 'dark' },
  { name: '14-inicio-desktop', path: '/', width: 1280, height: 900 },
  { name: '15-cartoes', path: '/cards' },
  { name: '16-categorias', path: '/categories' },
  { name: '17-casa', path: '/casa' },
  { name: '18-extrato-casa', path: '/transactions?filtro=dup' },
  { name: '19-credito', path: '/credito', height: 2400 },
  { name: '20-credito-escuro', path: '/credito', theme: 'dark', height: 2400 },
  { name: '21-panorama', path: '/panorama' },
  { name: '22-cartoes-of', path: '/cards', of: true, height: 1600 },
  { name: '23-cartoes-of-escuro', path: '/cards', of: true, theme: 'dark', height: 1600 },
]
for (const s of screens) {
  try {
    await shoot(browser, s)
  } catch (e) {
    log.push(`[${s.name}] FALHOU: ${e.message}`)
  }
}
await browser.close()
fs.writeFileSync(`${OUT}/console.txt`, log.join('\n') || 'sem erros')
console.log(log.join('\n') || 'sem erros')
