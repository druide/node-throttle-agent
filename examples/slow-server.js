const http = require('http')

const PORT = 8000

const server = http.createServer((req, res) => {
  setTimeout(() => {
    res.end('.')
  }, Math.floor(Math.random() * 2000) + 100)
})
server.on('clientError', (err, socket) => {
  console.error(err.message)
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})
server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
})
