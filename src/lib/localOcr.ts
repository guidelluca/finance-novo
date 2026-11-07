/**
 * OCR 100% local (Tesseract.js / WebAssembly): grátis e sem limite de uso.
 * O idioma "por" é baixado uma vez (~10 MB) e fica em cache no navegador (IndexedDB).
 */
import type { OcrLine, OcrPage } from '@/parsers/screenshotOcrParse'

type TesseractWorker = {
  recognize: (
    image: HTMLCanvasElement,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ) => Promise<{ data: TesseractData }>
  setParameters: (p: Record<string, string>) => Promise<unknown>
  terminate: () => Promise<unknown>
}
type Bbox = { x0: number; y0: number; x1: number; y1: number }
type TWord = { text: string; bbox: Bbox; confidence: number }
type TLine = { text: string; bbox: Bbox; confidence: number; words?: TWord[] }
type TesseractData = {
  blocks?: Array<{ paragraphs?: Array<{ lines?: TLine[] }> }> | null
  lines?: TLine[]
}

let workerPromise: Promise<TesseractWorker> | null = null
let progressCb: ((pct: number, status: string) => void) | null = null

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js')
      const w = (await createWorker('por', 1, {
        logger: (m: { status: string; progress: number }) => progressCb?.(m.progress, m.status),
      })) as unknown as TesseractWorker
      // PSM 11 = texto esparso: bom para listas de apps (descrição à esquerda, valor à direita)
      await w.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' })
      return w
    })().catch((e) => {
      workerPromise = null
      throw e
    })
  }
  return workerPromise
}

export async function terminateLocalOcr(): Promise<void> {
  if (!workerPromise) return
  const w = await workerPromise.catch(() => null)
  workerPromise = null
  await w?.terminate()
}

async function fileToCanvas(file: File): Promise<HTMLCanvasElement> {
  let src: ImageBitmap | HTMLImageElement
  try {
    src = await createImageBitmap(file)
  } catch {
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      src = img
    } catch {
      throw new Error(`Não consegui abrir “${file.name}”. Use print em PNG ou JPG.`)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  const w = 'naturalWidth' in src ? src.naturalWidth : src.width
  const h = 'naturalHeight' in src ? src.naturalHeight : src.height
  // Prints de celular têm texto pequeno: garantir ~1100–1600 px de largura
  const scale = w < 1000 ? Math.min(2, 1200 / w) : Math.min(1, 1600 / w)
  const c = document.createElement('canvas')
  c.width = Math.round(w * scale)
  c.height = Math.round(h * scale)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, 0, 0, c.width, c.height)
  if ('close' in src) src.close()
  return c
}

/** Cinza + inversão se o print estiver em modo escuro (Tesseract lê melhor texto escuro em fundo claro). */
function preprocess(original: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = original.width
  c.height = original.height
  const ctx = c.getContext('2d')!
  ctx.drawImage(original, 0, 0)
  const img = ctx.getImageData(0, 0, c.width, c.height)
  const d = img.data
  let sum = 0
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!
  const dark = sum / (d.length / 4) < 110
  for (let i = 0; i < d.length; i += 4) {
    let y = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!
    if (dark) y = 255 - y
    d[i] = d[i + 1] = d[i + 2] = y
  }
  ctx.putImageData(img, 0, 0)
  return c
}

/** Cor do texto dentro da caixa: verde (entrada) / vermelho (saída) / null. */
function textColorIn(ctx: CanvasRenderingContext2D, b: Bbox): 'green' | 'red' | null {
  const w = Math.max(1, b.x1 - b.x0)
  const h = Math.max(1, b.y1 - b.y0)
  const { data } = ctx.getImageData(b.x0, b.y0, w, h)
  // fundo = cor do canto
  const bg = [data[0]!, data[1]!, data[2]!]
  let r = 0
  let g = 0
  let bl = 0
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i]! - bg[0]!
    const dg = data[i + 1]! - bg[1]!
    const db = data[i + 2]! - bg[2]!
    if (dr * dr + dg * dg + db * db < 60 * 60) continue
    r += data[i]!
    g += data[i + 1]!
    bl += data[i + 2]!
    n++
  }
  if (n < 8) return null
  r /= n
  g /= n
  bl /= n
  if (g > r + 35 && g > bl + 10) return 'green'
  if (r > g + 50 && r > bl + 30) return 'red'
  return null
}

const AMOUNT_WORD = /\d{1,3}(?:\.\d{3})*,\d{2}/

export async function ocrScreenshot(
  file: File,
  onProgress?: (pct: number, status: string) => void,
): Promise<OcrPage> {
  const original = await fileToCanvas(file)
  const prepared = preprocess(original)
  progressCb = onProgress ?? null
  try {
    const worker = await getWorker()
    const { data } = await worker.recognize(prepared, {}, { blocks: true, text: true })
    const tLines: TLine[] =
      data.blocks?.flatMap((b) => b.paragraphs?.flatMap((p) => p.lines ?? []) ?? []) ?? data.lines ?? []
    const ctx = original.getContext('2d', { willReadFrequently: true })!
    const lines: OcrLine[] = tLines
      .filter((l) => l.text?.trim())
      .map((l) => {
        const amountWords = (l.words ?? []).filter((w) => AMOUNT_WORD.test(w.text))
        const target = amountWords[amountWords.length - 1]
        return {
          text: l.text.replace(/\s+/g, ' ').trim(),
          y0: l.bbox.y0,
          y1: l.bbox.y1,
          x0: l.bbox.x0,
          confidence: l.confidence,
          amountColor: target ? textColorIn(ctx, target.bbox) : null,
        }
      })
    return { lines, height: original.height }
  } finally {
    progressCb = null
  }
}
