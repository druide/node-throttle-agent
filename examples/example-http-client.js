const Agent = require('..')
const http = require('http')
const urlParser = require('url')

const URL = 'http://localhost:8000'
const TIMEOUT = 500

let keepAliveAgent = new Agent({
  keepAlive: true,
  maxSockets: 5,
  rate: 15
})

function doRequest () {
  let options = urlParser.parse(URL)
  options.agent = keepAliveAgent
  options.timeout = TIMEOUT

  http.request(options, (res) => {
    let str = ''
    res.on('data', (chunk) => {
      str += chunk
    }).on('end', () => {
      process.stdout.write(str)
    })
  }).end()
}

setInterval(() => {
  for (var i = 0; i < 10; i++) doRequest()
}, 1)

setInterval(() => {
  console.dir(keepAliveAgent.getStats())
}, 5000)
