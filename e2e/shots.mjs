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
    if (url.pathname.startsWith('/auth/v1/user')) return json(user)
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

async function shoot(browser, { name, path, theme = 'light', width = 390, height = 844, before }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' })
  const page = await ctx.newPage()
  await page.clock.setFixedTime(new Date('2026-11-08T15:00:00-03:00'))
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && log.push(`[${name}] ${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => log.push(`[${name}] PAGEERROR: ${e.message}`))
  await mock(page)
  await page.addInitScript(([s, t]) => {
    if (s) localStorage.setItem('sb-mock-auth-token', JSON.stringify(s))
    localStorage.setItem('finance-pwa:theme', t)
    localStorage.setItem('finance:passkey-prompt-dismissed', '1')
  }, [path === '/login' ? null : session, theme])
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  if (before) await before(page)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
  await ctx.close()
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
