// Fixture-adjacent capture tool, not part of the shipped codex organ (#322).
// A minimal HTTP sink that writes every POST body verbatim to OUT_DIR, so a
// real `codex exec` run's OTLP export can be captured byte-for-byte instead
// of hand-written. Usage:
//   OUT_DIR=/tmp/codex-otlp-capture PORT=4319 node otlp-capture-sink.mjs
// Each request is saved as <NNN>-<method>-<url-slug>.json (or .bin if the
// body isn't valid JSON) alongside a manifest.jsonl line recording the
// method, url, headers and byte length. Responds 200 with `{}` to every
// request so codex's exporter sees a normal accepted export.
import { createServer } from 'node:http'
import { mkdir, appendFile, writeFile } from 'node:fs/promises'

const PORT = Number(process.env.PORT ?? 4319)
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/codex-otlp-capture'

await mkdir(OUT_DIR, { recursive: true })

let seq = 0

function slug(url) {
  const clean = url.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return clean.length > 0 ? clean : 'root'
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', async () => {
    seq += 1
    const n = seq
    const body = Buffer.concat(chunks)
    const bodyText = body.toString('utf8')
    let ext = 'bin'
    let toWrite = body
    try {
      JSON.parse(bodyText)
      ext = 'json'
      toWrite = bodyText
    } catch {
      // not JSON — keep raw bytes
    }
    const name = `${String(n).padStart(3, '0')}-${req.method}-${slug(req.url ?? '/')}.${ext}`
    await writeFile(`${OUT_DIR}/${name}`, toWrite)
    await appendFile(
      `${OUT_DIR}/manifest.jsonl`,
      `${JSON.stringify({
        seq: n,
        method: req.method,
        url: req.url,
        headers: req.headers,
        bytes: body.length,
        savedAs: name,
      })}\n`,
    )
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`otlp-capture-sink listening on http://127.0.0.1:${PORT}, writing to ${OUT_DIR}`)
})
