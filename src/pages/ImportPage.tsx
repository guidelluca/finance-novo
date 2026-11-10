import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Camera, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/contexts/AuthContext'
import { loadMerchantMemory, suggestCategory, type MerchantMemory } from '@/lib/categorize'
import { supabase } from '@/lib/supabase'
import {
  ensureCategoriesForImportHints,
  resolveImportCategoryHint,
} from '@/lib/categoryImportHint'
import { accountLabelFromImport } from '@/lib/importAccount'
import { normalizeTransactionLogicalDescription, transactionContentFingerprint, transactionDedupCandidates } from '@/lib/dedupKey'
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
import { parseItauExtratoLayout, type BalanceMismatch } from '@/parsers/itauExtratoLayout'
import { looksLikeInterCsv, parseInterCsv, parseInterPdfLayout } from '@/parsers/inter'
import { parseMercadoPagoLayout } from '@/parsers/mercadoPagoLayout'
import { parseMercadoPagoExtrato } from '@/parsers/mercadoPagoExtrato'
import { parseNubankExtrato } from '@/parsers/nubankExtrato'
import { extractPdfLayout, extractPdfText } from '@/parsers/pdfText'
import { draftsFromVisionResult } from '@/parsers/screenshotAi'
import { parseScreenshotsLocally } from '@/parsers/screenshotLocal'
import { parseFaturaCartao } from '@/parsers/faturaCartao'
import { identifyMerchant } from '@/lib/merchantIdentify'
import { learnRules } from '@/lib/learnRules'
import type { ParserId, TransactionDraft } from '@/parsers/types'
import type { Category, ImportBatch, ImportFile, Rule } from '@/types/database'
import { formatBRLFromCents, parseMoneyToCents } from '@/lib/currency'
import { cn } from '@/lib/utils'
import { Link, useSearchParams } from 'react-router-dom'
import { matchAccount, readAccounts } from '@/lib/accounts'
import { refreshSalaryAnchors } from '@/hooks/usePeriods'
import { SALARY_RE } from '@/lib/period'

const PARSER_OPTIONS: { id: ParserId; label: string }[] = [
  { id: 'screenshot_ai_v1', label: 'Print / Foto — extraído por IA' },
  { id: 'controle_gastos_pdf_v1', label: 'Controle de Gastos — PDF (export planilha)' },
  { id: 'fatura_cartao_pdf_v1', label: 'Fatura de cartão — PDF (PicPay, Itaú e parecidos)' },
  { id: 'nubank_extrato_v1', label: 'Nubank — extrato PDF' },
  { id: 'mercadopago_extrato_v1', label: 'Mercado Pago — extrato PDF' },
  { id: 'inter_extrato_v1', label: 'Banco Inter — extrato PDF' },
  { id: 'csv_finance_pwa_v1', label: 'Finance PWA — CSV (lançamentos + categorias)' },
  { id: 'csv_nubank_v1', label: 'Nubank — CSV' },
  { id: 'csv_nubank_planilha_v1', label: 'Nubank — planilha (TSV / Excel colar)' },
  { id: 'itau_extrato_v1', label: 'Itaú — extrato PDF' },
  { id: 'csv_itau_v1', label: 'Itaú — CSV (;)' },
  { id: 'csv_mercadopago_v1', label: 'Mercado Pago — CSV (,)' },
  { id: 'csv_inter_v1', label: 'Banco Inter — CSV (;)' },
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
  if (parserId === 'csv_inter_v1') return parseInterCsv(text)
  return parseCsvBrazil(text, csvProfileFor(parserId))
}

/**
 * Identifica o estabelecimento de cada lançamento (local, sem API) e escolhe a categoria:
 * regras do usuário → estabelecimento identificado → categoria impressa pelo banco.
 * `hintFirst`: a coluna Categoria do CSV é do próprio usuário, então vem antes de tudo.
 */
/** Categoria que você mais usou em cada estabelecimento (carregada ao abrir a tela). */
let merchantMemory: MerchantMemory = new Map()

function enrichDrafts(
  drafts: TransactionDraft[],
  enabledRules: Rule[],
  categories: Category[],
  opts: { hintFirst?: boolean } = {},
): TransactionDraft[] {
  return drafts.map((d) => {
    const m = identifyMerchant(d.descriptionRaw, d.cityHint)
    const fromHint = resolveImportCategoryHint(d.categoryHint, categories)
    // regra aprendida → estabelecimento → o que você já usou nesse lugar → regras gerais → banco → VR
    const smart = suggestCategory(
      { description: d.descriptionRaw, account: d.accountHint ?? null, hint: null },
      { rules: enabledRules, categories, memory: merchantMemory },
    ).categoryId
    const auto = (opts.hintFirst ? (fromHint ?? smart) : (smart ?? fromHint)) ?? d.categoryId ?? null
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
/** Busca paginada (o Supabase devolve no máximo 1000 linhas por consulta). */
async function fetchTxRange<T>(userId: string, from: string, to: string, columns: string): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; ; i += 1000) {
    const { data, error } = await supabase
      .from('transactions')
      .select(columns)
      .eq('user_id', userId)
      .gte('date', from)
      .lte('date', to)
      .order('id')
      .range(i, i + 999)
    if (error) throw error
    out.push(...((data ?? []) as unknown as T[]))
    if (!data || data.length < 1000) break
  }
  return out
}

/**
 * Compara com o que já está salvo (mesma data, valor e tipo):
 * - descrição igual → é o mesmo lançamento (arquivo importado de novo): desmarca;
 * - descrição diferente (outra fonte: print × fatura, Nubank × Itaú) → importa mesmo assim,
 *   sinalizado; o consolidado só passa a contar quando você confirmar que não é repetida.
 */
async function flagPossibleDuplicates(
  userId: string,
  drafts: TransactionDraft[],
  /** lançamentos que vão ser substituídos (não contam como "já existe") */
  ignoreIds: Set<string> = new Set(),
): Promise<TransactionDraft[]> {
  if (drafts.length === 0) return drafts
  const dates = drafts.map((d) => d.date).sort()
  type Row = { id: string; date: string; amount_cents: number; kind: string; description_raw: string; description_normalized: string | null }
  let data: Row[]
  try {
    data = await fetchTxRange<Row>(
      userId,
      shiftIso(dates[0]!, -1),
      shiftIso(dates[dates.length - 1]!, 1),
      'id, date, amount_cents, kind, description_raw, description_normalized',
    )
  } catch {
    return drafts
  }
  data = data.filter((r) => !ignoreIds.has(r.id))
  const logical = (raw: string, norm: string | null) => normalizeTransactionLogicalDescription(norm ?? raw.toLowerCase(), raw)
  // conta quantas já existem por data+valor+tipo: 2 Ubers iguais no arquivo e 1 salvo → só 1 é desmarcado
  const exact = new Map<string, number>()
  const near = new Map<string, Row[]>()
  for (const t of data) {
    const ek = `${t.date}|${t.amount_cents}|${t.kind}|${logical(t.description_raw, t.description_normalized)}`
    exact.set(ek, (exact.get(ek) ?? 0) + 1)
    for (const dd of [-1, 0, 1]) {
      const nk = `${shiftIso(t.date, dd)}|${t.amount_cents}|${t.kind}`
      near.set(nk, [...(near.get(nk) ?? []), t])
    }
  }
  return drafts.map((d) => {
    const ek = `${d.date}|${d.amountCents}|${d.kind}|${logical(d.descriptionRaw, null)}`
    const n = exact.get(ek) ?? 0
    if (n > 0) {
      exact.set(ek, n - 1)
      return { ...d, excluded: true, reviewFlags: [...(d.reviewFlags ?? []), 'já está salvo (igual)'] }
    }
    const other = near.get(`${d.date}|${d.amountCents}|${d.kind}`)?.[0]
    if (!other) return d
    return {
      ...d,
      reviewFlags: [
        ...(d.reviewFlags ?? []),
        `possível repetida de “${identifyMerchant(other.description_raw).name.slice(0, 40)}” (${other.date.slice(8)}/${other.date.slice(5, 7)}): entra, mas só conta quando você confirmar`,
      ],
    }
  })
}

export type OldRow = {
  id: string
  date: string
  amount_cents: number
  kind: 'debit' | 'credit'
  category_id: string | null
}

/** Lançamentos de importações anteriores do mesmo leitor, dentro do período do arquivo novo. */
async function findOldImportRows(userId: string, parserId: string, from: string, to: string): Promise<{ rows: OldRow[]; full: unknown[] }> {
  const { data: batches } = await supabase.from('import_batches').select('id').eq('user_id', userId).eq('parser_id', parserId)
  const ids = ((batches ?? []) as { id: string }[]).map((b) => b.id)
  if (ids.length === 0) return { rows: [], full: [] }
  const full: Record<string, unknown>[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const { data } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .in('import_batch_id', ids.slice(i, i + 50))
      .gte('date', from)
      .lte('date', to)
    full.push(...((data ?? []) as Record<string, unknown>[]))
  }
  return { rows: full as unknown as OldRow[], full }
}

function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function isDocFile(f: File): boolean {
  return f.type === 'application/pdf' || /\.(pdf|csv|tsv|txt)$/i.test(f.name) || /csv/.test(f.type)
}

function centsToInput(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function inputToCents(v: string): number | null {
  const c = parseMoneyToCents(v.trim().replace(/^[+-]/, ''))
  return c == null || c <= 0 ? null : c
}

interface ShotItem {
  id: string
  file: File
  previewUrl: string
}

export function ImportPage() {
  const { user } = useAuth()
  useEffect(() => {
    if (!user) return
    loadMerchantMemory(user.id)
      .then((m) => {
        merchantMemory = m
      })
      .catch(() => undefined)
  }, [user])
  const [file, setFile] = useState<File | null>(null)
  const selectedFile = file
  const [parserFallback, setParserFallback] = useState<ParserId | 'auto'>('auto')
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
  const [searchParams] = useSearchParams()
  const trackedAccounts = useMemo(() => readAccounts(user), [user])
  /** conta escolhida na revisão (null = palpite automático) */
  const [pickedAccountId, setPickedAccountId] = useState<string | null>(() => searchParams.get('account'))
  const [shotError, setShotError] = useState<string | null>(null)
  const shotInputRef = useRef<HTMLInputElement | null>(null)
  const shotCameraRef = useRef<HTMLInputElement | null>(null)
  /** local = OCR no aparelho (grátis, sem limite); ia = Gemini multimodal (cota gratuita) */
  const [shotMode, setShotMode] = useState<'local' | 'ia'>('local')
  const [progress, setProgress] = useState<string | null>(null)
  const [detectedBank, setDetectedBank] = useState<string | null>(null)
  const [learnFromCorrections, setLearnFromCorrections] = useState(true)
  const [fileError, setFileError] = useState<string | null>(null)
  /** importação antiga do mesmo extrato (lida com o leitor antigo) que pode ser substituída */
  const [replaceOld, setReplaceOld] = useState<{ rows: OldRow[]; full: unknown[] } | null>(null)
  const [replaceChecked, setReplaceChecked] = useState(true)
  /** períodos do extrato em que a soma dos lançamentos não bate com o saldo */
  const [mismatches, setMismatches] = useState<BalanceMismatch[]>([])
  const restoreReplacedRef = useRef<() => Promise<void>>(async () => {})
  const parseFileRef = useRef<(f?: File) => Promise<void>>(async () => {})

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
    const all = Array.from(files)
    // PDF/CSV soltos ou escolhidos aqui vão direto para a leitura de arquivo
    const doc = all.find((f) => isDocFile(f))
    if (doc) {
      void parseFileRef.current(doc)
      return
    }
    const arr = all.filter((f) => f.type.startsWith('image/') || /\.(heic|heif|png|jpe?g|webp)$/i.test(f.name))
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
        if (!it || it.kind !== 'file' || !(it.type.startsWith('image/') || it.type === 'application/pdf' || /csv/.test(it.type))) continue
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

  const parseFile = async (picked?: File) => {
    const file = picked ?? selectedFile
    if (!file || !user) return
    if (picked) setFile(picked)
    setBusy(true)
    setWarnings([])
    setFileError(null)
    setReplaceOld(null)
    setMismatches([])
    setReplaceChecked(true)
    setSaveNotice(null)
    setProgress(/\.pdf$/i.test(file.name) ? 'Lendo o PDF…' : 'Lendo o arquivo…')
    try {
      const { data: r } = await supabase.from('rules').select('*').eq('user_id', user.id)
      const ruleRows = (r ?? []) as Rule[]

      let parserId: ParserId = parserFallback === 'auto' ? 'csv_brazil_v1' : parserFallback
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
          'csv_inter_v1',
        ]
        if (looksLikeInterCsv(text)) {
          parserId = 'csv_inter_v1'
        } else if (parserFallback !== 'auto' && csvModes.includes(parserFallback)) {
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
        const detected = detectParser(file.name, text) ?? (parserFallback === 'auto' ? null : parserFallback)
        if (!detected) {
          setFileError(
            'Não reconheci de qual banco é este PDF. Abra “Opções avançadas”, escolha o tipo do arquivo e toque em “Ler de novo”. Se for de um banco que o app ainda não lê, me mande o arquivo.',
          )
          setFile(file)
          return
        }
        parserId = detected

        if (parserId === 'fatura_cartao_pdf_v1') {
          const fatura = parseFaturaCartao(await extractPdfLayout(buf))
          if (fatura.drafts.length === 0) {
            setFileError(
              `Reconheci a fatura${fatura.bank ? ` ${fatura.bank}` : ''}, mas não achei os lançamentos. ${fatura.warnings.join(' ')} Me mande o PDF para eu ajustar o leitor.`,
            )
            return
          }
          const flagged = await flagPossibleDuplicates(user.id, fatura.drafts)
          setLastParserId(parserId)
          setDetectedBank(fatura.bank ? `Fatura ${fatura.bank}` : 'Fatura de cartão')
          setWarnings(fatura.warnings)
          setDrafts(enrichDrafts(flagged, ruleRows.filter((x) => x.enabled), categoryRows))
          setStep('review')
          return
        }

        // extrato de conta Mercado Pago: descrição em 2 linhas em volta da data, valor e saldo por movimento
        if (parserId === 'mercadopago_extrato_v1') {
          const mp = parseMercadoPagoLayout(await extractPdfLayout(buf))
          if (mp.drafts.length > 0) {
            setLastParserId(parserId)
            setDetectedBank('Extrato Mercado Pago (conta)')
            if (mp.holderName && mp.holderName.split(/\s+/).length >= 2 && !user.user_metadata?.owner_name) {
              void supabase.auth.updateUser({ data: { owner_name: mp.holderName } })
            }
            setWarnings(mp.warnings)
            setDrafts(enrichDrafts(await flagPossibleDuplicates(user.id, mp.drafts), ruleRows.filter((x) => x.enabled), categoryRows))
            setStep('review')
            return
          }
        }

        // extrato da conta Banco Inter: datas por extenso, valor e saldo após cada transação
        if (parserId === 'inter_extrato_v1') {
          const inter = parseInterPdfLayout(await extractPdfLayout(buf))
          if (inter.drafts.length === 0) {
            setFileError(`Reconheci o extrato do Banco Inter, mas não achei os lançamentos. ${inter.warnings.join(' ')}`)
            return
          }
          setLastParserId(parserId)
          setDetectedBank('Extrato Banco Inter (conta)')
          if (inter.holderName && inter.holderName.split(/\s+/).length >= 2 && !user.user_metadata?.owner_name) {
            void supabase.auth.updateUser({ data: { owner_name: inter.holderName } })
          }
          setWarnings(inter.warnings)
          setDrafts(enrichDrafts(await flagPossibleDuplicates(user.id, inter.drafts), ruleRows.filter((x) => x.enabled), categoryRows))
          setStep('review')
          return
        }

        // extrato de conta Itaú: lido linha a linha pela posição (valor × saldo), conferido com o saldo do dia
        if (parserId === 'itau_extrato_v1') {
          const ext = parseItauExtratoLayout(await extractPdfLayout(buf))
          if (ext.drafts.length > 0) {
            const ds = ext.drafts.map((d) => d.date).sort()
            const old = await findOldImportRows(user.id, parserId, ds[0]!, ds[ds.length - 1]!)
            if (old.rows.length > 0) setReplaceOld(old)
            // categoria que você já tinha dado ao lançamento antigo (mesma data, valor e tipo) é mantida
            const oldCat = new Map<string, string>()
            for (const r of old.rows) if (r.category_id) oldCat.set(`${r.date}|${r.amount_cents}|${r.kind}`, r.category_id)
            const flagged = await flagPossibleDuplicates(user.id, ext.drafts, new Set(old.rows.map((r) => r.id)))
            setLastParserId(parserId)
            setDetectedBank('Extrato Itaú (conta)')
            // guarda o nome do titular: Pix para esse nome em outros bancos = transferência entre suas contas
            if (ext.holderName && ext.holderName.split(/\s+/).length >= 2 && user.user_metadata?.owner_name !== ext.holderName) {
              void supabase.auth.updateUser({ data: { owner_name: ext.holderName } })
            }
            setWarnings(ext.warnings)
            setMismatches(ext.mismatchDetails ?? [])
            setDrafts(
              enrichDrafts(flagged, ruleRows.filter((x) => x.enabled), categoryRows).map((d) => {
                const c = oldCat.get(`${d.date}|${d.amountCents}|${d.kind}`)
                return c ? { ...d, categoryId: c, autoCategoryId: c } : d
              }),
            )
            setStep('review')
            return
          }
        }
      }

      setLastParserId(parserId)
      if (!text.trim()) {
        setFileError(
          'Este PDF não tem texto (é uma imagem escaneada). Tire um print da tela da fatura e envie como imagem.',
        )
        return
      }
      const result = runParse(parserId, text)
      if (result.drafts.length === 0) {
        setFileError(
          `Não encontrei lançamentos lendo como “${parserLabel(parserId)}”. ${result.warnings.slice(0, 2).join(' ')} Escolha o tipo certo abaixo e tente de novo.`,
        )
        return
      }

      let categoryRowsResolved = categoryRows
      if (parserId === 'csv_finance_pwa_v1') {
        const hints = result.drafts.map((d) => d.categoryHint).filter((h): h is string => !!h?.trim())
        categoryRowsResolved = await ensureCategoriesForImportHints(supabase, user.id, hints)
        setCategories(categoryRowsResolved)
      }

      const withRules = enrichDrafts(
        await flagPossibleDuplicates(user.id, result.drafts),
        ruleRows.filter((x) => x.enabled),
        categoryRowsResolved,
        { hintFirst: true },
      )
      setDetectedBank(null)
      setWarnings(result.warnings)
      setDrafts(withRules)
      setStep('review')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setFileError(
        /password|senha/i.test(msg)
          ? 'Este PDF tem senha. Abra no app do banco, baixe a fatura sem senha (ou tire um print) e tente de novo.'
          : `Não consegui ler o arquivo: ${msg}`,
      )
      setDrafts([])
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }
  parseFileRef.current = parseFile

  const updateDraft = (tempId: string, patch: Partial<TransactionDraft>) => {
    setDrafts((d) => d.map((x) => (x.tempId === tempId ? { ...x, ...patch } : x)))
  }

  const guessedAccount = useMemo(() => {
    const hint = drafts.find((d) => d.accountHint)?.accountHint
    const label = hint ?? accountLabelFromImport(lastParserId, file?.name ?? shotSourceName ?? '')
    return matchAccount(trackedAccounts, label, drafts.some((d) => d.cardLast4))
  }, [drafts, lastParserId, file, shotSourceName, trackedAccounts])
  const targetAccount = trackedAccounts.find((a) => a.id === pickedAccountId) ?? guessedAccount

  const saveAll = async () => {
    const toSave = drafts.filter((d) => !d.excluded)
    if (!user || toSave.length === 0) return
    const currentFilename = file?.name ?? shotSourceName ?? `import-${format(new Date(), 'yyyyMMdd-HHmm')}`
    if (!file && !shotSourceName) return
    setBusy(true)
    let createdBatchId: string | null = null
    let inserted = false
    restoreReplacedRef.current = async () => {}
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
      createdBatchId = batch!.id

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
          const account = targetAccount?.name ?? (d.accountHint?.trim() || defaultAccount)
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
      // substitui a importação antiga do mesmo extrato (lida com o leitor antigo) neste período
      let replaced: Record<string, unknown>[] = []
      if (replaceOld && replaceChecked && replaceOld.rows.length > 0) {
        const ids = replaceOld.rows.map((r) => r.id)
        for (let i = 0; i < ids.length; i += 100) {
          const { error: dErr } = await supabase.from('transactions').delete().eq('user_id', user.id).in('id', ids.slice(i, i + 100))
          if (dErr) throw dErr
        }
        replaced = replaceOld.full as Record<string, unknown>[]
      }
      restoreReplacedRef.current = async () => {
        if (replaced.length === 0) return
        // coluna gerada não pode ser enviada de volta
        const back = replaced.map(({ logical_fingerprint: _lf, ...rest }) => rest)
        await supabase.from('transactions').upsert(back as never[], { onConflict: 'id', ignoreDuplicates: true })
        replaced = []
      }

      // em lotes: uma fatura grande gera centenas de chaves e a URL da consulta passaria do limite
      const existing = new Set<string | null>()
      for (let i = 0; i < candidateKeys.length; i += 80) {
        const { data: existingRows, error: kErr } = await supabase
          .from('transactions')
          .select('dedup_key')
          .eq('user_id', user.id)
          .in('dedup_key', candidateKeys.slice(i, i + 80))
        if (kErr) throw kErr
        for (const r of existingRows ?? []) existing.add(r.dedup_key)
      }

      const minDate = toSave.reduce((a, d) => (d.date < a ? d.date : a), toSave[0]!.date)
      const maxDate = toSave.reduce((a, d) => (d.date > a ? d.date : a), toSave[0]!.date)
      const existingInRange = await fetchTxRange<{
        date: string
        amount_cents: number
        kind: string
        description_normalized: string | null
        description_raw: string
      }>(user.id, minDate, maxDate, 'date, amount_cents, kind, description_normalized, description_raw')

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
      let skipped = prepared.length - rows.length

      let conflictSkipped = 0
      const { error: tErr } = await supabase.from('transactions').upsert(rows, {
        onConflict: 'user_id,logical_fingerprint',
        ignoreDuplicates: true,
      })
      if (tErr) {
        if (tErr.code !== '23505') throw tErr
        // uma linha bateu em outra chave única (dedup_key): grava uma a uma e pula só as que já existem
        for (let i = 0; i < rows.length; i += 25) {
          const chunk = rows.slice(i, i + 25)
          const { error: cErr } = await supabase
            .from('transactions')
            .upsert(chunk, { onConflict: 'user_id,logical_fingerprint', ignoreDuplicates: true })
          if (!cErr) continue
          if (cErr.code !== '23505') throw cErr
          for (const row of chunk) {
            const { error: rErr } = await supabase
              .from('transactions')
              .upsert([row], { onConflict: 'user_id,logical_fingerprint', ignoreDuplicates: true })
            if (rErr && rErr.code !== '23505') throw rErr
            if (rErr) conflictSkipped += 1
            else inserted = true
          }
        }
      }
      inserted = true

      const learned = learnFromCorrections
        ? await learnRules(
            user.id,
            toSave
              .filter((d) => d.categoryId && d.categoryId !== d.autoCategoryId)
              .map((d) => ({ key: d.merchantRuleKey, categoryId: d.categoryId! })),
          )
        : 0
      skipped += conflictSkipped
      let savedCount = rows.length - conflictSkipped

      // conferência dupla: relê do banco o que esta importação gravou e compara quantidade e soma
      let verify = ''
      {
        const { data: back, error: vErr } = await supabase
          .from('transactions')
          .select('amount_cents, kind')
          .eq('user_id', user.id)
          .eq('import_batch_id', batch!.id)
        if (vErr) verify = ' Não consegui reler o que foi gravado para conferir — abra o Extrato e confira.'
        else {
          const got = back ?? []
          const net = (xs: { amount_cents: number; kind: string }[]) =>
            xs.reduce((a, r) => a + (r.kind === 'credit' ? r.amount_cents : -r.amount_cents), 0)
          const wantNet = net(rows)
          const gotNet = net(got as { amount_cents: number; kind: string }[])
          if (got.length !== savedCount || (got.length === rows.length && gotNet !== wantNet)) {
            const missing = rows.length - got.length
            verify =
              missing > 0
                ? ` Conferência: ${got.length} de ${rows.length} gravados — ${missing} não entrou(aram) porque já existia(m) um igual.`
                : ` Conferência: a soma gravada (${formatBRLFromCents(gotNet)}) difere da lida (${formatBRLFromCents(wantNet)}). Confira no Extrato.`
            savedCount = got.length
            skipped = prepared.length - got.length
          } else if (got.length > 0) {
            verify = ` Conferido no banco: ${got.length} gravado(s), soma ${formatBRLFromCents(gotNet)}.`
          }
        }
      }
      const possibleDup = toSave.filter((d) => d.reviewFlags?.some((f) => f.startsWith('possível repetida'))).length
      const linkedCards = rows.filter((r) => r.credit_card_id).length
      const extra =
        (replaced.length ? ` ${replaced.length} lançamento(s) antigos deste período foram substituídos.` : '') +
        (possibleDup
          ? ` ${possibleDup} possível(is) repetida(s) entraram sem contar nos totais: confirme no Extrato ou no Mês.`
          : '') +
        (linkedCards ? ` ${linkedCards} ligados ao cartão cadastrado.` : '') +
        (learned ? ` ${learned} regra(s) aprendida(s) com suas correções.` : '') +
        verify
      setSaveNotice(
        (skipped > 0
          ? `${savedCount} lançamento(s) gravados. ${skipped} ignorado(s) (já estavam salvos, idênticos).`
          : savedCount > 0
            ? `${savedCount} lançamento(s) gravados.`
            : '') + extra || null,
      )
      setDetectedBank(null)

      // salário novo pode mudar o dia em que o mês financeiro começa
      if (toSave.some((d) => d.kind === 'credit' && SALARY_RE.test(d.descriptionRaw))) void refreshSalaryAnchors(user.id)
      setStep('pick')
      setReplaceOld(null)
      setPickedAccountId(null)
      setFile(null)
      setDrafts([])
      setShotSourceName(null)
      clearShots()
      setShotHint('')
      void loadImports()
    } catch (e) {
      // nada foi gravado: devolve os lançamentos antigos que tinham sido tirados e apaga o registro vazio
      if (!inserted) await restoreReplacedRef.current()
      if (createdBatchId && !inserted) {
        await supabase.from('import_files').delete().eq('batch_id', createdBatchId)
        await supabase.from('import_batches').delete().eq('id', createdBatchId)
      }
      setWarnings([`Não foi possível salvar: ${(e as Error).message}`])
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

      </header>

      {fileError || (busy && progress && step === 'pick') ? (
        <div
          role={fileError ? 'alert' : 'status'}
          className={cn(
            'flex items-start gap-2 rounded-2xl border p-3.5 text-sm',
            fileError ? 'border-danger/40 bg-danger/10 text-danger' : 'border-border bg-surface',
          )}
        >
          <span className="flex-1">{fileError ?? progress}</span>
          {fileError ? (
            <button type="button" aria-label="Fechar aviso" onClick={() => setFileError(null)} className="text-xs font-semibold underline">
              Fechar
            </button>
          ) : null}
        </div>
      ) : null}

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
        <section className="space-y-3 rounded-3xl border border-border bg-surface p-[18px]">
          {saveNotice ? (
            <p role="status" className="rounded-xl bg-accent-muted px-3 py-2.5 text-sm">
              {saveNotice}
            </p>
          ) : null}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              addShotFiles(e.dataTransfer.files)
            }}
            className="flex flex-col items-center gap-2.5 rounded-2xl border-2 border-dashed border-border bg-background px-4 py-6 text-center"
          >
            <span className="flex size-12 items-center justify-center rounded-2xl bg-ink text-lime" aria-hidden>
              <Upload className="size-6" />
            </span>
            <p className="text-[15px] font-semibold">Fatura, extrato ou prints</p>
            <p className="max-w-sm text-xs text-muted">
              PDF ou CSV do banco (Itaú, Nubank, Inter, PicPay, Mercado Pago…) ou prints da tela do app. O banco é
              reconhecido sozinho e tudo é lido no seu aparelho.
            </p>
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              <Button type="button" onClick={() => shotInputRef.current?.click()} disabled={busy}>
                <Upload className="size-4" />
                {busy && !shots.length ? (progress ?? 'Lendo…') : 'Escolher arquivo'}
              </Button>
              <Button type="button" variant="secondary" onClick={() => shotCameraRef.current?.click()} disabled={busy}>
                <Camera className="size-4" />
                Tirar foto
              </Button>
            </div>
            <p className="hidden text-[11px] text-muted sm:block">
              ou arraste para cá · cole um print com <kbd className="rounded bg-surface px-1">Cmd/Ctrl+V</kbd>
            </p>
            <input
              ref={shotInputRef}
              type="file"
              accept="image/*,.heic,.heif,.pdf,application/pdf,.csv,text/csv,.tsv,.txt"
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
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {shots.map((s) => (
                  <div key={s.id} className="relative overflow-hidden rounded-xl border border-border bg-background">
                    <img src={s.previewUrl} alt="Print escolhido" className="h-24 w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removeShot(s.id)}
                      className="absolute right-1 top-1 rounded-full bg-black/60 p-1.5 text-white transition hover:bg-black/80"
                      aria-label="Remover imagem"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
              <div>
                <Label htmlFor="shot-hint">Contexto (opcional)</Label>
                <Input
                  id="shot-hint"
                  placeholder="Ex.: fatura Nubank, cartão final 1234, outubro"
                  value={shotHint}
                  onChange={(e) => setShotHint(e.target.value)}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={(shotMode === 'ia' && !isVisionConfigured()) || busy}
                  onClick={() => void extractFromShots()}
                >
                  <Sparkles className="size-4" />
                  {busy ? (progress ?? 'Lendo…') : `Ler ${shots.length} ${shots.length === 1 ? 'print' : 'prints'}${shotMode === 'ia' ? ' com IA' : ''}`}
                </Button>
                <Button type="button" variant="secondary" onClick={clearShots} disabled={busy}>
                  Limpar
                </Button>
              </div>
              <p className="text-xs text-muted">Vários prints da mesma tela? Pode mandar todos: o que se repete entre eles entra uma vez só.</p>
            </div>
          ) : null}
          {shotError ? <p className="text-sm text-danger">{shotError}</p> : null}

          <details className="rounded-2xl border border-border px-3.5 py-2.5 text-sm">
            <summary className="cursor-pointer font-medium">Opções avançadas</summary>
            <div className="mt-3 space-y-4">
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted">Como ler prints</p>
                <div role="radiogroup" aria-label="Como ler os prints" className="grid grid-cols-2 gap-1 rounded-xl bg-background p-1 text-sm">
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
                    <span className="block text-[11px] font-normal text-muted">Mais precisa · usa cota do Gemini</span>
                  </button>
                </div>
                {shotMode === 'local' ? (
                  <p className="text-xs text-muted">Na primeira vez o leitor baixa o idioma português (~10 MB). Depois, cada print leva poucos segundos e nada sai do seu aparelho.</p>
                ) : !isVisionConfigured() ? (
                  <p className="text-xs text-warning">A leitura com IA não está configurada neste app (falta a chave do Gemini). Use “No aparelho”.</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="parser-tipo">Tipo do arquivo</Label>
                <select
                  id="parser-tipo"
                  className="flex h-11 w-full rounded-xl border border-border bg-background px-3 text-sm"
                  value={parserFallback}
                  onChange={(e) => setParserFallback(e.target.value as ParserId | 'auto')}
                >
                  <option value="auto">Detectar automaticamente (recomendado)</option>
                  {PARSER_OPTIONS.filter((p) => p.id !== 'screenshot_ai_v1' && p.id !== 'screenshot_local_v1').map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {file && parserFallback !== 'auto' ? (
                  <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void parseFile()}>
                    Ler “{file.name.slice(0, 28)}” de novo com este tipo
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted">
                <strong>CSV do próprio app</strong>: colunas <code>data</code>, <code>descricao</code>, <code>valor</code>,{' '}
                <code>tipo</code> (C/D ou entrada/saída); opcionais <code>categoria</code> e <code>conta</code>. Separador , ou ;
              </p>
            </div>
          </details>
        </section>
      ) : null}

      {step === 'pick' ? (
        <details className="rounded-3xl border border-border bg-surface px-[18px] py-3.5">
          <summary className="cursor-pointer text-base font-semibold">
            Arquivos importados{importRows.length ? ` (${importRows.length})` : ''}
          </summary>
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted">“Apagar” remove o arquivo e todos os lançamentos que vieram dele.</p>
            {importError ? <p className="text-sm text-danger">{importError}</p> : null}
            {importsLoading ? (
              <p className="text-sm text-muted">Carregando…</p>
            ) : importRows.length === 0 ? (
              <p className="text-sm text-muted">Nenhum arquivo importado ainda.</p>
            ) : (
              <ul className="divide-y divide-border">
                {importRows.map((row) => (
                  <li key={row.file.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{row.file.filename}</p>
                      <p className="truncate text-xs text-muted">
                        {format(parseISO(row.file.created_at), "d MMM yyyy 'às' HH:mm", { locale: ptBR })} · {row.txCount} lançamento(s) ·{' '}
                        {parserLabel(row.batch.parser_id)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-danger"
                      disabled={deletingId === row.file.id}
                      onClick={() => void removeImport(row)}
                      aria-label={`Apagar ${row.file.filename} e seus lançamentos`}
                    >
                      <Trash2 className="size-4" />
                      {deletingId === row.file.id ? 'Apagando…' : 'Apagar'}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
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
              <label className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">De qual conta é?</span>
                <select
                  value={targetAccount?.id ?? ''}
                  onChange={(e) => setPickedAccountId(e.target.value || null)}
                  className={cn(
                    'h-9 rounded-lg border bg-background px-2 text-sm',
                    targetAccount ? 'border-border' : 'border-warning',
                  )}
                >
                  <option value="">Escolher…</option>
                  {trackedAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                {!targetAccount ? <span className="text-xs text-warning">escolha para o fechamento do mês saber</span> : null}
              </label>
              {replaceOld ? (
                <label className="mt-2 flex items-start gap-2 rounded-xl border border-warning/50 bg-warning/10 p-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={replaceChecked}
                    onChange={(e) => setReplaceChecked(e.target.checked)}
                  />
                  <span>
                    <strong>Substituir {replaceOld.rows.length} lançamento(s) importados antes deste extrato</strong>, no mesmo período (
                    {(() => {
                      const ds = replaceOld.rows.map((r) => r.date).sort()
                      return `${ds[0]!.slice(8)}/${ds[0]!.slice(5, 7)} a ${ds[ds.length - 1]!.slice(8)}/${ds[ds.length - 1]!.slice(5, 7)}`
                    })()}
                    ). A versão anterior do leitor trocava valores e lia “Saldo do Dia” como gasto. Categorias que você já tinha escolhido são mantidas.
                  </span>
                </label>
              ) : null}
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
            {mismatches.length ? (
              <div className="space-y-2.5">
                {mismatches.map((mm) => {
                  const fmtD = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
                  const diff = mm.balanceDeltaCents - mm.sumCents
                  const list = drafts.filter((d) => mm.draftIds.includes(d.tempId))
                  const signed = (d: TransactionDraft) => (d.kind === 'credit' ? d.amountCents : -d.amountCents)
                  // provável culpado: um lançamento do período com exatamente o valor da diferença
                  const suspect = list.find((d) => Math.abs(signed(d)) === Math.abs(diff))
                  return (
                    <details key={`${mm.from}-${mm.to}`} open className="rounded-xl border border-warning/40 bg-surface p-3 text-sm">
                      <summary className="cursor-pointer font-semibold">
                        {fmtD(mm.from)} a {fmtD(mm.to)}: diferença de {formatBRLFromCents(Math.abs(diff))}
                      </summary>
                      <p className="mt-1.5 text-xs text-muted">
                        O saldo variou {diff + mm.sumCents >= 0 ? '+' : '−'}
                        {formatBRLFromCents(Math.abs(mm.balanceDeltaCents))}, mas os lançamentos somam {mm.sumCents >= 0 ? '+' : '−'}
                        {formatBRLFromCents(Math.abs(mm.sumCents))}.{' '}
                        {suspect
                          ? `Provável causa: “${suspect.descriptionRaw}” (${formatBRLFromCents(suspect.amountCents)}) — pode ter sido estornado ou não afetou o saldo. Se for o caso, desmarque.`
                          : list.length === 0
                            ? 'Nenhum lançamento lido neste trecho: falta alguma linha no PDF?'
                            : 'Confira estes lançamentos no app do banco:'}
                      </p>
                      {list.length ? (
                        <ul className="mt-2 divide-y divide-border">
                          {list.map((d) => (
                            <li key={d.tempId} className={cn('flex items-center gap-2 py-1.5', suspect?.tempId === d.tempId && 'font-semibold text-warning')}>
                              <span className="w-12 shrink-0 text-xs text-muted">{fmtD(d.date)}</span>
                              <span className="min-w-0 flex-1 truncate">{d.merchantName ?? d.descriptionRaw}</span>
                              <span className={cn('shrink-0 tabular-nums', d.kind === 'credit' && 'text-positive')}>
                                {d.kind === 'credit' ? '+' : '−'}
                                {formatBRLFromCents(d.amountCents)}
                              </span>
                              {d.excluded ? <span className="text-xs text-muted">(desmarcado)</span> : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </details>
                  )
                })}
              </div>
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
