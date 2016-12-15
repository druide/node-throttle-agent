# throttle-agent

[![Standard - JavaScript Style Guide](https://img.shields.io/badge/code%20style-standard-brightgreen.svg)](http://standardjs.com/)
[![Flowtype](https://img.shields.io/badge/flowtype-yes-green.svg)](https://flowtype.org/)
[![npm version](https://img.shields.io/npm/v/throttle-agent.svg)](https://www.npmjs.com/package/throttle-agent)
[![license](https://img.shields.io/github/license/druide/node-throttle-agent.svg)](https://github.com/druide/node-throttle-agent)

Node.js HTTP Agent with throttling. Agent is doing adjustment of request rate
depending of connection throughput and settings.

## Install

```
npm install throttle-agent --save
```

## Usage

Use agent same way as http.Agent:

```js
const Agent = require('throttle-agent')
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

```

or use `canAcceptRequest()` method to check before request object creation:

```js
...

let keepAliveAgent = new Agent({
  keepAlive: true,
  maxSockets: 5,
  rate: 15,
  checkBeforeRequest: true
})

function doRequest () {
  if (!keepAliveAgent.canAcceptRequest(URL)) return

  // otherwise create request
  ...
}

...
```

## Options

- `checkBeforeRequest`: Boolean - check before request with `canAcceptRequest()`
  method (true) or check on request (false).
- `rate`: Number - default rate limit. Override with `getRate()`.
- `rateInterval`: Number - rate interval, milliseconds. Default 1000.
- `rateLowerWeight`: Number - weight of lowering of rate compared to raising of
  rate. Default 18.
- `rateLowerKoef`: Number - decrease of rate koefficient, default 0.1.
- `rateRaiseKoef`: Number - increase of rate koefficient, default 0.02.
- `maxPending`: Number - max pending requests, default 3000.
- `maxBuffer`: Number - max socket buffer size, default 50.
- `getRate`: RateCallback - function to return max rate for endpoint. Example:
  ```js
    function getRate (name, flag) {
      return flag === 'domain1' ? 12 : 100;
    }
  ```

- `getFlag`: FlagCallback - function to get stat label from URL. Return '' to
  use Agent's default `domain:port:`. Example:

  ```js
  function getFlag (url) {
    return url === 'http://test.com' ? 'domain1' : 'general';
  }
  ```

- `getRateDirection`: RateDirectionCallback - function to make decision of rate
  modification. Returns -1 to decrease, 1 to increase and 0 to do nothing.
  By default rate is increased on every 2xx, 3xx code or if there are free
  opened sockets available, and decreased on timeouts, errors or when pending
  sockets number is high.
