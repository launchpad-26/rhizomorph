import http from 'node:http'

const port = Number(process.env.PORT ?? 8787)
const req = http.request(
  { host: '127.0.0.1', port, path: '/v1/rhizomorph/ingest', method: 'GET', timeout: 2000 },
  (res) => process.exit(res.statusCode === 405 ? 0 : 1),
)
req.on('error', () => process.exit(1))
req.on('timeout', () => {
  req.destroy()
  process.exit(1)
})
req.end()
