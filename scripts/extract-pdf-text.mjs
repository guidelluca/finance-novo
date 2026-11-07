import fs from 'node:fs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const path = process.argv[2]
if (!path) {
  console.error('Usage: node scripts/extract-pdf-text.mjs <file.pdf>')
  process.exit(1)
}

const data = new Uint8Array(fs.readFileSync(path))
const doc = await pdfjs.getDocument({ data, disableWorker: true }).promise
const parts = []
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i)
  const content = await page.getTextContent()
  const lineChunks = []
  for (const item of content.items) {
    if (!('str' in item)) continue
    const tm = item.transform
    const y = tm[5]
    lineChunks.push({ y, str: item.str })
  }
  lineChunks.sort((a, b) => b.y - a.y || a.str.localeCompare(b.str))
  parts.push(lineChunks.map((c) => c.str).join(' '))
}
console.log(parts.join('\n'))
