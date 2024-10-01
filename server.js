const express = require('express')
const next = require('next')
const { createProxyMiddleware }= require('http-proxy-middleware')

const port = Number.parseInt(process.env.PORT, 10) || 3000
const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const server = express()

  server.use(
    '/api/v1',
    createProxyMiddleware({
      target: 'http://localhost:5278/api/v1',
      pathRewrite: {
        '^/api': '/api'
      },
      changeOrigin: false
    })
  );

  server.all('*', (req, res) => {
    return handle(req, res)
  })

  server.listen(port, err => {
    if (err) throw err
    console.log(`> Ready on http://localhost:${port}`)
  })
})
