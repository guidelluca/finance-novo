import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, ImagePlus, Sparkles, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/contexts/AuthContext'
import { suggestCategoryId } from '@/lib/rulesEngine'
import { supabase } from '@/lib/supabase'
import {
  ensureCategoriesForImportHints,
  resolveImportCategoryHint,
} from '@/lib/categoryImportHint'
import { accountLabelFromImport } from '@/lib/importAccount'
import { transactionContentFingerprint, transactionDedupCandidates } from '@/lib/dedupKey'
import {
  extractTransactionsFromImages,
  fileToVisionImage,
  isVisionConfigured,
  type VisionImage,
} from '@/lib/visionExtract'
import { CSV_PROFILES, parseCsvBrazil, parseFinancePwaCsv, type CsvProfileId } from '@/parsers/csvImport'
import { detectParser } from '@/parsers/detect'
import { parseControleGastosExtrato } from '@/parsers/controleGastosExtrato'
import { parseItauExtrato } from '@/parsers/itauExtrato'
import { parseMercadoPagoExtrato } from '@/parsers/mercadoPagoExtrato'
import { parseNubankExtrato } from '@/parsers/nubankExtrato'
import { extractPdfLayout, extractPdfText } from '@/parsers/pdfText'
import { draftsFromVisionResult } from '@/parsers/screenshotAi'
import { parseScreenshotsLocally } from '@/parsers/screenshotLocal'
import { parseFaturaCartao } from '@/parsers/faturaCartao'
import { identifyMerchant, pickCategoryId } from '@/lib/merchantIdentify'
import { learnRules } from '@/lib/learnRules'
import type { ParserId, TransactionDraft } from '@/parsers/types'
import type { Category, ImportBatch, ImportFile, Rule } from '@/types/database'
import { cn } from '@/lib/utils'
import { Link } from 'react-router-dom'

const PARSER_OPTIONS: { id: ParserId; label: string }[] = [
  { id: 'screenshot_ai_v1', label: 'Print / Foto — extraído por IA' },
  { id: 'controle_gastos_pdf_v1', label: 'Controle de Gastos — PDF (export planilha)' },
  { id: 'fatura_cartao_pdf_v1', label: 'Fatura de cartão — PDF (PicPay, Itaú e parecidos)' },
  { id: 'nubank_extrato_v1', label: 'Nubank — extrato PDF' },
  { id: 'mercadopago_extrato_v1', label: 'Mercado Pago — extrato PDF' },
  { id: 'csv_finance_pwa_v1', label: 'Finance PWA — CSV (lançamentos + categorias)' },
  { id: 'csv_nubank_v1', label: 'Nubank — CSV' },
  { id: 'csv_nubank_planilha_v1', label: 'Nubank — planilha (TSV / Excel colar)' },
  { id: 'itau_extrato_v1', label: 'Itaú — extrato PDF' },
  { id: 'csv_itau_v1', label: 'Itaú — CSV (;)' },
  { id: 'csv_mercadopago_v1', label: 'Mercado Pago — CSV (,)' },
  { id: 'csv_brazil_v1', label: 'CSV — genérico BR (;)' },
]

function csvProfileFor(parserId: ParserId): (typeof CSV_PROFILES)[number] {
  const map: Partial<Record<ParserId, CsvProfileId>> = {
    csv_finance_pwa_v1: 'finance_pwa_csv',
    csv_nubank_v1: 'nubank_csv',
    csv_nubank_planilha_v1: 'nubank_planilha_tsv',
    csv_itau_v1: 'itau_csv',
    csv_mercadopago_v1: 'mercadopago_csv',
    csv_brazil_v1: 'generic_br',
  }
  const pid = map[parserId] ?? 'generic_br'
  return CSV_PROFILES.find((p) => p.id === pid) ?? CSV_PROFILES[0]!
}

type ImportListRow = {
  file: ImportFile
  batch: ImportBatch
  txCount: number
}

async function deleteImportDocument(userId: string, fileId: string): Promise<{ deletedTx: number }> {
  const { data: txs, error: selErr } = await supabase
    .from('transactions')
    .select('id')
    .eq('user_id', userId)
    .eq('import_file_id', fileId)
  if (selErr) throw selErr
  const ids = (txs ?? []).map((t) => t.id)
  if (ids.length > 0) {
    const { error: delTxErr } = await supabase.from('transactions').delete().eq('user_id', userId).in('id', ids)
    if (delTxErr) throw delTxErr
  }

  const { data: fileRow, error: fSelErr } = await supabase
    .from('import_files')
    .select('batch_id')
    .eq('id', fileId)
    .maybeSingle()
  if (fSelErr) throw fSelErr

  const { error: delFileErr } = await supabase.from('import_files').delete().eq('id', fileId)
  if (delFileErr) throw delFileErr

  const batchId = fileRow?.batch_id
  if (batchId) {
    const { count, error: cErr } = await supabase
      .from('import_files')
      .select('id', { count: 'exact', head: true })
      .eq('batch_id', batchId)
    if (cErr) throw cErr
    if ((count ?? 0) === 0) {
      const { error: bErr } = await supabase.from('import_batches').delete().eq('id', batchId).eq('user_id', userId)
      if (bErr) throw bErr
    }
  }

  return { deletedTx: ids.length }
}

function parserLabel(parserId: string): string {
  return PARSER_OPTIONS.find((p) => p.id === parserId)?.label ?? parserId
}

function runParse(parserId: ParserId, text: string) {
  if (parserId === 'controle_gastos_pdf_v1') return parseControleGastosExtrato(text)
  if (parserId === 'nubank_extrato_v1') return parseNubankExtrato(text)
  if (parserId === 'itau_extrato_v1') return parseItauExtrato(text)
  if (parserId === 'mercadopago_extrato_v1') return parseMercadoPagoExtrato(text)
  if (parserId === 'csv_finance_pwa_v1') return parseFinancePwaCsv(text)
  return parseCsvBrazil(text, csvProfileFor(parserId))
}

/**
 * Identifica o estabelecimento de cada lançamento (local, sem API) e escolhe a categoria:
 * regras do usuário → estabelecimento identificado → categoria impressa pelo banco.
 * `hintFirst`: a coluna Categoria do CSV é do próprio usuário, então vem antes de tudo.
 */
function enrichDrafts(
  drafts: TransactionDraft[],
  enabledRules: Rule[],
  categories: Category[],
  opts: { hintFirst?: boolean } = {},
): TransactionDraft[] {
  return drafts.map((d) => {
    const m = identifyMerchant(d.descriptionRaw, d.cityHint)
    const fromRules = suggestCategoryId(d.descriptionRaw, enabledRules)
    const fromHint = resolveImportCategoryHint(d.categoryHint, categories)
    const fromMerchant = pickCategoryId(m.categories, categories)
    const auto =
      (opts.hintFirst ? (fromHint ?? fromRules ?? fromMerchant) : (fromRules ?? fromMerchant ?? fromHint)) ??
      d.categoryId ??
      null
    return {
      ...d,
      merchantName: m.name,
      merchantDetail: [m.kind, m.via ? `via ${m.via}` : null].filter(Boolean).join(' · ') || null,
      merchantRuleKey: m.ruleKey,
      categoryId: auto,
      autoCategoryId: auto,
    }
  })
}

/**
 * Prints e PDFs do mesmo período descrevem a mesma compra com textos diferentes,
 * então a dedup por texto não pega. Aqui: mesma data + valor + tipo já gravados → desmarca e avisa.
 */
async function flagPossibleDuplicates(userId: string, drafts: TransactionDraft[]): Promise<TransactionDraft[]> {
  if (drafts.length === 0) return drafts
  const dates = drafts.map((d) => d.date).sort()
  const { data, error } = await supabase
    .from('transactions')
    .select('date, amount_cents, kind, description_raw')
    .eq('user_id', userId)
    .gte('date', dates[0]!)
    .lte('date', dates[dates.length - 1]!)
  if (error || !data) return drafts
  const existing = new Map<string, string>()
  for (const t of data) existing.set(`${t.date}|${t.amount_cents}|${t.kind}`, t.description_raw)
  return drafts.map((d) => {
    const hit = existing.get(`${d.date}|${d.amountCents}|${d.kind}`)
    if (!hit) return d
    return { ...d, excluded: true, reviewFlags: [...(d.reviewFlags ?? []), `já existe: “${hit.slice(0, 40)}”`] }
  })
}

function centsToInput(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function inputToCents(v: string): number | null {
  const t = v.trim().replace(/R\$/gi, '').replace(/\s/g, '').replace(/^[+-]/, '')
  if (!t) return null
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100)
}

interface ShotItem {
  id: string
  file: File
  previewUrl: string
}

export function ImportPage() {
  const { user } = useAuth()
  const [file, setFile] = useState<File | null>(null)
  const [parserFallback, setParserFallback] = useState<ParserId>('nubank_extrato_v1')
  const [lastParserId, setLastParserId] = useState<ParserId>('nubank_extrato_v1')
  const [drafts, setDrafts] = useState<TransactionDraft[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<'pick' | 'review'>('pick')
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [importRows, setImportRows] = useState<ImportListRow[]>([])
  const [importsLoading, setImportsLoading] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Estado da importação por print (IA multimodal).
  const [shots, setShots] = useState<ShotItem[]>([])
  const [shotHint, setShotHint] = useState('')
  const [shotSourceName, setShotSourceName] = useState<string | null>(null)
  const [shotError, setShotError] = useState<string | null>(null)
  const shotInputRef = useRef<HTMLInputElement | null>(null)
  const shotCameraRef = useRef<HTMLInputElement | null>(null)
  /** local = OCR no aparelho (grátis, sem limite); ia = Gemini multimodal (cota gratuita) */
  const [shotMode, setShotMode] = useState<'local' | 'ia'>('local')
  const [progress, setProgress] = useState<string | null>(null)
  const [detectedBank, setDetectedBank] = useState<string | null>(null)
  const [learnFromCorrections, setLearnFromCorrections] = useState(true)

  const loadImports = useCallback(async () => {
    if (!user) return
    setImportsLoading(true)
    setImportError(null)
    try {
      const { data: files, error: fErr } = await supabase
        .from('import_files')
        .select('*')
        .order('created_at', { ascending: false })
      if (fErr) throw fErr

      const fileList = (files ?? []) as ImportFile[]
      if (fileList.length === 0) {
        setImportRows([])
        return
      }
      const batchIds = [...new Set(fileList.map((f) => f.batch_id))]
      const { data: batches, error: bErr } = await supabase
        .from('import_batches')
        .select('*')
        .eq('user_id', user.id)
        .in('id', batchIds)
      if (bErr) throw bErr
      const batchById = new Map((batches as ImportBatch[]).map((b) => [b.id, b]))

      const { data: txRows, error: tErr } = await supabase
        .from('transactions')
        .select('import_file_id')
        .eq('user_id', user.id)
        .not('import_file_id', 'is', null)
      if (tErr) throw tErr
      const countByFile = new Map<string, number>()
      for (const r of txRows ?? []) {
        const fid = r.import_file_id as string
        countByFile.set(fid, (countByFile.get(fid) ?? 0) + 1)
      }

      const rows: ImportListRow[] = []
      for (const file of fileList) {
        const batch = batchById.get(file.batch_id)
        if (!batch) continue
        rows.push({ file, batch, txCount: countByFile.get(file.id) ?? 0 })
      }
      setImportRows(rows.sort((a, b) => b.file.created_at.localeCompare(a.file.created_at)))
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Erro ao carregar importações.')
      setImportRows([])
    } finally {
      setImportsLoading(false)
    }
  }, [user])

  useEffect(() => {
    if (!user) return
    void (async () => {
      const { data: c } = await supabase.from('categories').select('*').eq('user_id', user.id)
      setCategories(c ?? [])
    })()
  }, [user])

  useEffect(() => {
    if (!user || step !== 'pick') return
    void loadImports()
  }, [user, step, loadImports])

  const addShotFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return
    const arr = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (arr.length === 0) return
    setShots((prev) => {
      const next = [...prev]
      for (const f of arr) {
        const previewUrl = URL.createObjectURL(f)
        next.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file: f, previewUrl })
      }
      return next
    })
  }, [])

  const removeShot = useCallback((id: string) => {
    setShots((prev) => {
      const found = prev.find((s) => s.id === id)
      if (found) URL.revokeObjectURL(found.previewUrl)
      return prev.filter((s) => s.id !== id)
    })
  }, [])

  const clearShots = useCallback(() => {
    setShots((prev) => {
      for (const s of prev) URL.revokeObjectURL(s.previewUrl)
      return []
    })
  }, [])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (step !== 'pick') return
      const items = e.clipboardData?.items
      if (!items) return
      const imgs: File[] = []
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        if (!it || !it.type.startsWith('image/')) continue
        const f = it.getAsFile()
        if (f) imgs.push(f)
      }
      if (imgs.length > 0) {
        e.preventDefault()
        addShotFiles(imgs)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [step, addShotFiles])

  useEffect(() => {
    return () => {
      // limpa URLs.createObjectURL na saída da página
      setShots((prev) => {
        for (const s of prev) URL.revokeObjectURL(s.previewUrl)
        return prev
      })
    }
  }, [])

  const extractFromShots = async () => {
    if (!user || shots.length === 0) return
    setBusy(true)
    setShotError(null)
    setWarnings([])
    setSaveNotice(null)
    try {
      const { data: r } = await supabase.from('rules').select('*').eq('user_id', user.id)
      const ruleRows = ((r ?? []) as Rule[]).filter((x) => x.enabled)
      const { data: catFresh } = await supabase.from('categories').select('*').eq('user_id', user.id)
      const categoryRows = (catFresh ?? []) as Category[]
      setCategories(categoryRows)

      const useAi = shotMode === 'ia' && isVisionConfigured()
      let parsed: { drafts: TransactionDraft[]; warnings: string[] }
      if (useAi) {
        setProgress('A extrair com IA…')
        const images: VisionImage[] = await Promise.all(shots.map((s) => fileToVisionImage(s.file)))
        const result = await extractTransactionsFromImages(images, shotHint.trim() || undefined)
        parsed = draftsFromVisionResult(result)
        setDetectedBank(result.accountLabel ?? null)
      } else {
        const local = await parseScreenshotsLocally(
          shots.map((s) => s.file),
          setProgress,
        )
        parsed = local
        setDetectedBank(local.bank)
      }
      if (parsed.drafts.length === 0) {
        setShotError(
          useAi
            ? 'A IA não encontrou transações reconhecíveis nesta imagem. Tenta um crop mais nítido ou envia várias imagens.'
            : 'Não encontrei transações neste print. Confira se ele mostra a lista de lançamentos (data, descrição e valor) ou tente a leitura com IA.',
        )
        setBusy(false)
        setProgress(null)
        return
      }

      setProgress('Conferindo duplicados…')
      const flagged = await flagPossibleDuplicates(user.id, parsed.drafts)
      const withRules = enrichDrafts(flagged, ruleRows, categoryRows)

      setLastParserId(useAi ? 'screenshot_ai_v1' : 'screenshot_local_v1')
      setShotSourceName(
        shots.length === 1
          ? `print-${format(new Date(), 'yyyyMMdd-HHmm')}.${(shots[0]!.file.type.split('/')[1] || 'png').replace(/[^a-z]/gi, '')}`
          : `prints-${shots.length}-${format(new Date(), 'yyyyMMdd-HHmm')}.imgs`,
      )
      setFile(null)
      setWarnings(parsed.warnings)
      setDrafts(withRules)
      setStep('review')
    } catch (e) {
      setShotError(e instanceof Error ? e.message : 'Falha ao ler os prints.')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const parseFile = async () => {
    if (!file || !user) return
    setBusy(true)
    setWarnings([])
    setSaveNotice(null)
    try {
      const { data: r } = await supabase.from('rules').select('*').eq('user_id', user.id)
      const ruleRows = (r ?? []) as Rule[]

      let parserId: ParserId = parserFallback
      let text = ''

      const { data: catFresh } = await supabase.from('categories').select('*').eq('user_id', user.id)
      const categoryRows = (catFresh ?? []) as Category[]

      const lowerName = file.name.toLowerCase()
      const isTabularText =
        lowerName.endsWith('.csv') ||
        lowerName.endsWith('.tsv') ||
        lowerName.endsWith('.txt')

      if (isTabularText) {
        text = await file.text()
        const head = text.slice(0, 2000).toLowerCase()
        const looksLikeNubankPlanilha =
          /\t/.test(text.slice(0, 500)) &&
          /data\b/.test(head) &&
          (/descri/.test(head) || /historico/.test(head)) &&
          (/entrada/.test(head) || /sa[ií]da/.test(head))

        const csvModes: ParserId[] = [
          'csv_finance_pwa_v1',
          'csv_nubank_v1',
          'csv_nubank_planilha_v1',
          'csv_brazil_v1',
          'csv_itau_v1',
          'csv_mercadopago_v1',
        ]
        if (csvModes.includes(parserFallback)) {
          parserId = parserFallback
        } else if (looksLikeNubankPlanilha) {
          parserId = 'csv_nubank_planilha_v1'
        } else if (/^nu[_-]/i.test(file.name)) {
          parserId = 'csv_nubank_v1'
        } else if (/itau|itaú/i.test(file.name)) {
          parserId = 'csv_itau_v1'
        } else if (/mercado\s*pago|mercadopago|mp[_-]/i.test(file.name)) {
          parserId = 'csv_mercadopago_v1'
        } else {
          parserId = 'csv_brazil_v1'
        }
      } else {
        const buf = await file.arrayBuffer()
        text = await extractPdfText(buf)
        parserId = detectParser(file.name, text) ?? parserFallback

        if (parserId === 'fatura_cartao_pdf_v1') {
          const fatura = parseFaturaCartao(await extractPdfLayout(buf))
          const flagged = await flagPossibleDuplicates(user.id, fatura.drafts)
          setLastParserId(parserId)
          setDetectedBank(fatura.bank ? `Fatura ${fatura.bank}` : 'Fatura de cartão')
          setWarnings(fatura.warnings)
          setDrafts(enrichDrafts(flagged, ruleRows.filter((x) => x.enabled), categoryRows))
          setStep('review')
          return
        }
      }

      setLastParserId(parserId)
      const result = runParse(parserId, text)

      let categoryRowsResolved = categoryRows
      if (parserId === 'csv_finance_pwa_v1') {
        const hints = result.drafts.map((d) => d.categoryHint).filter((h): h is string => !!h?.trim())
        categoryRowsResolved = await ensureCategoriesForImportHints(supabase, user.id, hints)
        setCategories(categoryRowsResolved)
      }

      const withRules = enrichDrafts(
        result.drafts,
        ruleRows.filter((x) => x.enabled),
        categoryRowsResolved,
        { hintFirst: true },
      )
      setDetectedBank(null)
      setWarnings(result.warnings)
      setDrafts(withRules)
      setStep('review')
    } catch (e) {
      setWarnings([(e as Error).message])
      setDrafts([])
    } finally {
      setBusy(false)
    }
  }

  const updateDraft = (tempId: string, patch: Partial<TransactionDraft>) => {
    setDrafts((d) => d.map((x) => (x.tempId === tempId ? { ...x, ...patch } : x)))
  }

  const saveAll = async () => {
    const toSave = drafts.filter((d) => !d.excluded)
    if (!user || toSave.length === 0) return
    const currentFilename = file?.name ?? shotSourceName ?? `import-${format(new Date(), 'yyyyMMdd-HHmm')}`
    if (!file && !shotSourceName) return
    setBusy(true)
    try {
      const parserId = lastParserId
      const defaultAccount = accountLabelFromImport(parserId, currentFilename)

      const { data: batch, error: bErr } = await supabase
        .from('import_batches')
        .insert({
          user_id: user.id,
          parser_id: parserId,
          parser_version: 'v1',
          status: 'completed',
        })
        .select('id')
        .single()
      if (bErr) throw bErr

      const { data: fileRow, error: fErr } = await supabase
        .from('import_files')
        .insert({
          batch_id: batch!.id,
          filename: currentFilename,
          parser_id: parserId,
        })
        .select('id')
        .single()
      if (fErr) throw fErr

      // Compras iguais no mesmo arquivo (ex.: 2 Ubers de R$ 8,93 no mesmo dia) são legítimas:
      // a 2ª, 3ª… ganham "#2", "#3" na chave para não colidirem nos índices únicos
      // (dedup_key e logical_fingerprint). Reimportar o mesmo arquivo continua idempotente.
      const occ = new Map<string, number>()
      const descKeys = toSave.map((d) => {
        const base = `${d.date}|${d.amountCents}|${d.kind}|${d.descriptionRaw.trim().toLowerCase()}`
        const n = (occ.get(base) ?? 0) + 1
        occ.set(base, n)
        return n === 1 ? d.descriptionRaw : `${d.descriptionRaw} #${n}`
      })

      // Fatura: liga cada compra ao cartão cadastrado (pelo final do cartão ou, se só houver um, pelo banco)
      let cardIdFor: (d: TransactionDraft) => string | null = () => null
      if (toSave.some((d) => d.cardLast4)) {
        const { data: cards } = await supabase
          .from('credit_cards')
          .select('id, name, last4, archived')
          .eq('user_id', user.id)
        type CardRow = { id: string; name: string; last4: string | null; archived: boolean }
        const list = ((cards ?? []) as CardRow[]).filter((c) => !c.archived)
        cardIdFor = (d) => {
          const byLast4 = d.cardLast4
            ? list.find((c) => (c.last4 ?? '').replace(/\D/g, '').slice(-4) === d.cardLast4)
            : undefined
          if (byLast4) return byLast4.id
          const bank = (d.accountHint ?? '').replace(/^cart[aã]o\s*/i, '').trim().toLowerCase()
          const byName = bank ? list.filter((c) => c.name.toLowerCase().includes(bank)) : []
          return byName.length === 1 ? byName[0]!.id : null
        }
      }

      const prepared = await Promise.all(
        toSave.map(async (d, i) => {
          const descKey = descKeys[i]!
          const account = d.accountHint?.trim() || defaultAccount
          const candidates = await transactionDedupCandidates(
            user.id,
            d.date,
            d.amountCents,
            d.kind,
            descKey,
            d.sourceId,
            account,
            parserId,
          )
          const dedup_key = candidates[0]!
          return {
            row: {
              user_id: user.id,
              date: d.date,
              amount_cents: d.amountCents,
              description_raw: d.descriptionRaw,
              description_normalized: descKey.toLowerCase(),
              kind: d.kind,
              account: account || null,
              dedup_key,
              category_id: d.categoryId ?? null,
              import_batch_id: batch!.id,
              import_file_id: fileRow!.id,
              credit_card_id: cardIdFor(d),
            },
            candidates,
          }
        }),
      )

      const candidateKeys = [...new Set(prepared.flatMap((p) => p.candidates))]
      const { data: existingRows } = await supabase
        .from('transactions')
        .select('dedup_key')
        .eq('user_id', user.id)
        .in('dedup_key', candidateKeys)
      const existing = new Set((existingRows ?? []).map((r) => r.dedup_key))

      const minDate = toSave.reduce((a, d) => (d.date < a ? d.date : a), toSave[0]!.date)
      const maxDate = toSave.reduce((a, d) => (d.date > a ? d.date : a), toSave[0]!.date)
      const { data: existingInRange } = await supabase
        .from('transactions')
        .select('date, amount_cents, kind, description_normalized, description_raw')
        .eq('user_id', user.id)
        .gte('date', minDate)
        .lte('date', maxDate)

      const existingFp = new Set(
        (existingInRange ?? []).map((t) =>
          transactionContentFingerprint(
            t.date,
            t.amount_cents,
            t.kind as 'debit' | 'credit',
            t.description_normalized,
            t.description_raw,
          ),
        ),
      )

      const seenBatchFp = new Set<string>()
      const rows = prepared
        .filter((p) => {
          if (p.candidates.some((k) => existing.has(k))) return false
          const fp = transactionContentFingerprint(
            p.row.date,
            p.row.amount_cents,
            p.row.kind as 'debit' | 'credit',
            p.row.description_normalized,
            p.row.description_raw,
          )
          if (existingFp.has(fp)) return false
          if (seenBatchFp.has(fp)) return false
          seenBatchFp.add(fp)
          return true
        })
        .map((p) => p.row)
      const skipped = prepared.length - rows.length

      const { error: tErr } = await supabase.from('transactions').upsert(rows, {
        onConflict: 'user_id,logical_fingerprint',
        ignoreDuplicates: true,
      })
      if (tErr) throw tErr

      const learned = learnFromCorrections
        ? await learnRules(
            user.id,
            toSave
              .filter((d) => d.categoryId && d.categoryId !== d.autoCategoryId)
              .map((d) => ({ key: d.merchantRuleKey, categoryId: d.categoryId! })),
          )
        : 0
      const linkedCards = rows.filter((r) => r.credit_card_id).length
      const extra =
        (linkedCards ? ` ${linkedCards} ligados ao cartão cadastrado.` : '') +
        (learned ? ` ${learned} regra(s) aprendida(s) com suas correções.` : '')
      setSaveNotice(
        (skipped > 0
          ? `${rows.length} lançamento(s) gravados. ${skipped} ignorado(s) (já existiam ou linha repetida no arquivo).`
          : rows.length > 0
            ? `${rows.length} lançamento(s) gravados.`
            : '') + extra || null,
      )
      setDetectedBank(null)

      setStep('pick')
      setFile(null)
      setDrafts([])
      setShotSourceName(null)
      clearShots()
      setShotHint('')
      void loadImports()
    } catch (e) {
      setWarnings([(e as Error).message])
    } finally {
      setBusy(false)
    }
  }

  const removeImport = async (row: ImportListRow) => {
    if (!user) return
    const n = row.txCount
    if (
      !window.confirm(
        `Apagar o arquivo “${row.file.filename}” e ${n} lançamento(s) ligados a esta importação? Isto não pode ser desfeito.`,
      )
    )
      return
    setDeletingId(row.file.id)
    setImportError(null)
    try {
      const { deletedTx } = await deleteImportDocument(user.id, row.file.id)
      setSaveNotice(
        deletedTx > 0
          ? `Importação removida. ${deletedTx} lançamento(s) apagados do extrato.`
          : 'Registo de importação removido (nenhum lançamento estava ligado a este arquivo).',
      )
      void loadImports()
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Erro ao apagar.')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-6 pb-24">
      <header className="space-y-3.5">
        <h1 className="text-[30px] font-bold tracking-tight">Adicionar</h1>
        <div className="grid grid-cols-2 gap-1 rounded-2xl border border-border bg-surface p-1 text-sm" role="tablist">
          <span role="tab" aria-selected="true" className="rounded-xl bg-primary py-2.5 text-center font-semibold text-primary-fg">
            Importar extrato
          </span>
          <Link to="/transactions?new=1" role="tab" aria-selected="false" className="rounded-xl py-2.5 text-center font-medium text-muted">
            Lançar à mão
          </Link>
        </div>
        <ol className="flex items-center gap-2 text-[13px]" aria-label="Etapas">
          {(['Arquivo', 'Revisar', 'Pronto'] as const).map((label, i) => {
            const current = step === 'review' ? 1 : saveNotice ? 2 : 0
            const state = i < current ? 'done' : i === current ? 'now' : 'next'
            return (
              <li key={label} className="flex flex-1 items-center gap-2" aria-current={state === 'now' ? 'step' : undefined}>
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                    state === 'now' && 'bg-ink text-lime',
                    state === 'done' && 'bg-lime text-ink',
                    state === 'next' && 'border border-border text-muted',
                  )}
                >
                  {state === 'done' ? '✓' : i + 1}
                </span>
                <span className={cn(state === 'next' ? 'text-muted' : 'font-semibold')}>{label}</span>
                {i < 2 ? <span className="h-px flex-1 bg-border" aria-hidden /> : null}
              </li>
            )
          })}
        </ol>
        {step === 'pick' ? (
          <details className="rounded-2xl border border-border bg-surface px-3.5 py-2.5 text-sm text-muted">
            <summary className="cursor-pointer font-medium text-foreground">Formatos aceitos</summary>
            <p className="mt-2">
              Prints do app do banco, faturas em PDF (Itaú, PicPay e outros), extratos em PDF, CSV ou TSV.{' '}
              <strong>CSV do Finance</strong>: colunas <code className="text-xs">data</code>,{' '}
              <code className="text-xs">descricao</code>, <code className="text-xs">valor</code>,{' '}
              <code className="text-xs">tipo</code> (C/D ou entrada/saída); opcionais{' '}
              <code className="text-xs">categoria</code> e <code className="text-xs">conta</code>. Separador{' '}
              <strong>,</strong> ou <strong>;</strong> detectado automaticamente.
            </p>
          </details>
        ) : null}
      </header>

      {step === 'review' ? (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {[
            { label: 'Encontradas', value: drafts.length, tone: '' },
            { label: 'Já existiam / desmarcadas', value: drafts.filter((d) => d.excluded).length, tone: '' },
            { label: 'Categorizadas', value: drafts.filter((d) => !d.excluded && d.categoryId).length, tone: 'text-positive' },
            {
              label: 'Precisam de você',
              value: drafts.filter((d) => !d.excluded && (!d.categoryId || (d.reviewFlags?.length ?? 0) > 0)).length,
              tone: 'text-warning',
            },
          ].map((b) => (
            <div key={b.label} className="rounded-[18px] border border-border bg-surface px-3.5 py-3">
              <p className={cn('font-display text-2xl font-bold tabular-nums', b.tone)}>{b.value}</p>
              <p className="text-xs text-muted">{b.label}</p>
            </div>
          ))}
        </div>
      ) : null}

      {step === 'pick' ? (
        <Card className="border-accent/30 bg-accent-muted/20">
          <CardHeader className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-accent" aria-hidden />
              Print / Foto
              <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                novo
              </span>
            </CardTitle>
            <CardDescription>
              Envia, tira ou cola (Cmd/Ctrl+V) uma captura de tela do teu app do banco/cartão. O app
              identifica data, valor e descrição de cada linha. Podes juntar várias imagens (na ordem em
              que rolaste a tela — o que se repete entre prints entra uma vez só).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div role="radiogroup" aria-label="Como ler os prints" className="grid grid-cols-2 gap-1 rounded-xl bg-surface-elevated p-1 text-sm">
              <button
                type="button"
                role="radio"
                aria-checked={shotMode === 'local'}
                onClick={() => setShotMode('local')}
                className={cn('rounded-lg px-3 py-2 text-left', shotMode === 'local' ? 'bg-surface font-semibold shadow-sm' : 'text-muted')}
              >
                No aparelho
                <span className="block text-[11px] font-normal text-muted">Grátis e sem limite</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={shotMode === 'ia'}
                onClick={() => setShotMode('ia')}
                className={cn('rounded-lg px-3 py-2 text-left', shotMode === 'ia' ? 'bg-surface font-semibold shadow-sm' : 'text-muted')}
              >
                Com IA
                <span className="block text-[11px] font-normal text-muted">Mais precisa · usa cota Gemini</span>
              </button>
            </div>
            {shotMode === 'local' ? (
              <p className="text-xs text-muted">
                Na primeira vez o leitor baixa o idioma português (~10 MB) e guarda no navegador. Depois, cada
                print leva poucos segundos e nada sai do teu aparelho.
              </p>
            ) : null}
            {shotMode === 'ia' && !isVisionConfigured() ? (
              <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                Configura <code className="rounded bg-surface-elevated px-1 text-xs">VITE_GEMINI_API_KEY</code>{' '}
                no build para ativar a extração por IA (Gemini multimodal).
              </p>
            ) : null}

            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                addShotFiles(e.dataTransfer.files)
              }}
              className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border/70 bg-surface/50 p-5 text-center text-sm"
            >
              <p className="text-muted">
                Arrasta imagens aqui, cola com <kbd className="rounded bg-surface-elevated px-1">Cmd/Ctrl+V</kbd>
                {' '}ou usa os botões:
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => shotInputRef.current?.click()}
                  disabled={busy}
                >
                  <ImagePlus className="size-4" />
                  Escolher imagens
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => shotCameraRef.current?.click()}
                  disabled={busy}
                >
                  <Camera className="size-4" />
                  Tirar foto
                </Button>
              </div>
              <input
                ref={shotInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  addShotFiles(e.target.files)
                  if (e.target) e.target.value = ''
                }}
              />
              <input
                ref={shotCameraRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  addShotFiles(e.target.files)
                  if (e.target) e.target.value = ''
                }}
              />
            </div>

            {shots.length > 0 ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {shots.map((s) => (
                  <div
                    key={s.id}
                    className="relative overflow-hidden rounded-xl border border-border bg-surface-elevated"
                  >
                    <img
                      src={s.previewUrl}
                      alt="Preview do print"
                      className="h-24 w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeShot(s.id)}
                      className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white transition hover:bg-black/80"
                      title="Remover imagem"
                      aria-label="Remover imagem"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {shots.length > 0 ? (
              <div>
                <Label>Contexto (opcional)</Label>
                <Input
                  placeholder="Ex.: fatura Nubank cartão final 1234, outubro/2025"
                  value={shotHint}
                  onChange={(e) => setShotHint(e.target.value)}
                />
              </div>
            ) : null}

            {shotError ? <p className="text-sm text-danger">{shotError}</p> : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={(shotMode === 'ia' && !isVisionConfigured()) || shots.length === 0 || busy}
                onClick={() => void extractFromShots()}
              >
                <Sparkles className="size-4" />
                {busy
                  ? (progress ?? 'A ler…')
                  : `Ler ${shots.length || ''} imagem(ns)${shotMode === 'ia' ? ' com IA' : ''}`}
              </Button>
              {shots.length > 0 ? (
                <Button type="button" variant="secondary" onClick={clearShots} disabled={busy}>
                  Limpar
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 'pick' ? (
        <Card>
          {saveNotice ? (
            <CardContent className="pb-0 pt-5">
              <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
                {saveNotice}
              </p>
            </CardContent>
          ) : null}
          <CardHeader>
            <CardTitle className="text-base">Arquivo (PDF / CSV)</CardTitle>
            <CardDescription>
              PDF: o parser é escolhido por detecção (nome + texto). Use o seletor como fallback se
              necessário.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              type="file"
              accept=".pdf,.csv,.tsv,.txt"
              className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-4 file:py-2 file:text-sm file:font-medium file:text-[#04120c]"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <div>
              <Label>Tipo (PDF ou CSV)</Label>
              <select
                className="mt-1 flex h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm"
                value={parserFallback}
                onChange={(e) => setParserFallback(e.target.value as ParserId)}
              >
                {PARSER_OPTIONS.filter((p) => p.id !== 'screenshot_ai_v1').map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <Button type="button" disabled={!file || busy} onClick={() => void parseFile()}>
              {busy ? (progress ?? 'Lendo…') : 'Analisar arquivo'}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {step === 'pick' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Arquivos importados</CardTitle>
            <CardDescription>
              Remove o registo do ficheiro e <strong>todos</strong> os lançamentos criados nessa importação
              (os que ficaram de fora por duplicados não são apagados).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {importError ? (
              <p className="text-sm text-danger">{importError}</p>
            ) : null}
            {importsLoading ? (
              <p className="text-sm text-muted">A carregar…</p>
            ) : importRows.length === 0 ? (
              <p className="text-sm text-muted">Ainda não há importações guardadas nesta conta.</p>
            ) : (
              <ul className="space-y-2">
                {importRows.map((row) => (
                  <li
                    key={row.file.id}
                    className="flex flex-col gap-2 rounded-xl border border-border bg-surface-elevated/50 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{row.file.filename}</p>
                      <p className="text-xs text-muted">
                        {format(parseISO(row.file.created_at), "d MMM yyyy 'às' HH:mm", {
                          locale: ptBR,
                        })}{' '}
                        · {row.txCount} lançamento(s) · {parserLabel(row.batch.parser_id)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      className="shrink-0 gap-1"
                      disabled={deletingId === row.file.id}
                      onClick={() => void removeImport(row)}
                    >
                      <Trash2 className="size-4" />
                      {deletingId === row.file.id ? 'A apagar…' : 'Apagar arquivo e lançamentos'}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      {step === 'review' ? (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Revisão</CardTitle>
              <CardDescription>
                {drafts.filter((d) => !d.excluded).length} de {drafts.length} lançamentos marcados
                {detectedBank ? ` · ${detectedBank}` : ''}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => setStep('pick')}>
                Voltar
              </Button>
              <Button
                type="button"
                disabled={busy || drafts.every((d) => d.excluded)}
                onClick={() => void saveAll()}
              >
                {busy ? 'Salvando…' : `Salvar ${drafts.filter((d) => !d.excluded).length}`}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {warnings.length ? (
              <ul className="list-inside list-disc rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-accent)]"
                checked={learnFromCorrections}
                onChange={(e) => setLearnFromCorrections(e.target.checked)}
              />
              Aprender com minhas correções de categoria (cria regras automaticamente)
            </label>
            <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
              {drafts.map((d) => (
                <div
                  key={d.tempId}
                  className={cn(
                    'rounded-xl border border-border bg-surface-elevated/60 p-2 text-sm transition-opacity',
                    d.excluded && 'opacity-50',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label="Incluir este lançamento"
                      className="size-5 accent-[var(--color-accent)]"
                      checked={!d.excluded}
                      onChange={(e) => updateDraft(d.tempId, { excluded: !e.target.checked })}
                    />
                    <input
                      type="date"
                      aria-label="Data"
                      value={d.date}
                      onChange={(e) => e.target.value && updateDraft(d.tempId, { date: e.target.value })}
                      className="h-9 rounded-lg border border-border bg-background px-2 text-xs"
                    />
                    <button
                      type="button"
                      title="Trocar entre entrada e saída"
                      onClick={() => updateDraft(d.tempId, { kind: d.kind === 'credit' ? 'debit' : 'credit' })}
                      className={cn(
                        'ml-auto h-9 rounded-lg px-2 text-xs font-semibold',
                        d.kind === 'credit' ? 'bg-positive/15 text-positive' : 'bg-danger/10 text-danger',
                      )}
                    >
                      {d.kind === 'credit' ? '+ Entrada' : '− Saída'}
                    </button>
                    <input
                      key={`${d.tempId}-${d.amountCents}`}
                      defaultValue={centsToInput(d.amountCents)}
                      inputMode="decimal"
                      aria-label="Valor em reais"
                      onBlur={(e) => {
                        const c = inputToCents(e.target.value)
                        if (c) updateDraft(d.tempId, { amountCents: c })
                        else e.target.value = centsToInput(d.amountCents)
                      }}
                      className="h-9 w-24 rounded-lg border border-border bg-background px-2 text-right font-mono text-xs tabular-nums"
                    />
                  </div>
                  {d.merchantName ? (
                    <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-semibold">{d.merchantName}</span>
                      {d.merchantDetail ? <span className="text-xs text-muted">{d.merchantDetail}</span> : null}
                      {d.cardLast4 ? <span className="text-xs text-muted">· final {d.cardLast4}</span> : null}
                    </p>
                  ) : null}
                  <input
                    value={d.descriptionRaw}
                    aria-label="Descrição original"
                    onChange={(e) => {
                      const m = identifyMerchant(e.target.value, d.cityHint)
                      updateDraft(d.tempId, {
                        descriptionRaw: e.target.value,
                        merchantName: m.name,
                        merchantRuleKey: m.ruleKey,
                        merchantDetail: [m.kind, m.via ? `via ${m.via}` : null].filter(Boolean).join(' · ') || null,
                      })
                    }}
                    className="mt-1 h-8 w-full rounded-lg border border-border bg-background px-2 font-mono text-[11px] text-muted"
                  />
                  {d.reviewFlags?.length ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {d.reviewFlags.map((f) => (
                        <span key={f} className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] text-warning">
                          {f}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <select
                    className="mt-2 w-full rounded-lg border border-border bg-background px-2 py-1 text-xs"
                    value={d.categoryId ?? ''}
                    onChange={(e) => updateDraft(d.tempId, { categoryId: e.target.value || null })}
                  >
                    <option value="">Sem categoria</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {learnFromCorrections && d.categoryId && d.categoryId !== d.autoCategoryId && d.merchantRuleKey ? (
                    <p className="mt-1 text-[11px] text-accent">
                      Vou lembrar: “{d.merchantRuleKey}” → {categories.find((c) => c.id === d.categoryId)?.name}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
