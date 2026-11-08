import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = pdfWorker

export async function extractPdfText(data: ArrayBuffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(data.slice(0)) }).promise
  const parts: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const lineChunks: { y: number; str: string }[] = []
    for (const item of content.items) {
      if (!('str' in item)) continue
      const tm = item.transform
      const y = tm[5]
      lineChunks.push({ y, str: item.str })
    }
    lineChunks.sort((a, b) => b.y - a.y || a.str.localeCompare(b.str))
    const pageText = lineChunks.map((c) => c.str).join(' ')
    parts.push(pageText)
  }
  return parts.join('\n')
}

/** Texto com posição (x, y de cima para baixo) — necessário para PDFs em colunas (faturas de cartão). */
export async function extractPdfLayout(
  data: ArrayBuffer,
): Promise<{ width: number; height: number; items: { x: number; y: number; w: number; str: string }[] }[]> {
  const doc = await getDocument({ data: new Uint8Array(data.slice(0)) }).promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const vp = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const items: { x: number; y: number; w: number; str: string }[] = []
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const [, , , , e, f] = item.transform as number[]
      items.push({ x: e!, y: vp.height - f!, w: item.width, str: item.str })
    }
    pages.push({ width: vp.width, height: vp.height, items })
  }
  return pages
}
