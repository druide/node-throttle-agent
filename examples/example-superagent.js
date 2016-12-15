const Agent = require('..')
const request = require('superagent')

const URL = 'http://localhost:8000'
const TIMEOUT = 500

let keepAliveAgent = new Agent({
  keepAlive: true,
  maxSockets: 5,
  rate: 15
})

function doRequest () {
  return request
    .get(URL)
    .timeout({response: TIMEOUT, deadline: TIMEOUT * 2})
    .agent(keepAliveAgent)
    .then(response => {
      if (response.statusCode === 200) process.stdout.write(response.text)
    })
}

setInterval(() => {
  for (var i = 0; i < 10; i++) doRequest()
}, 1)

setInterval(() => {
  console.dir(keepAliveAgent.getStats())
}, 5000)
