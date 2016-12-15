// @flow
const http: Object = require('http')
const https: Object = require('https')
const RateLimiter = require('@druide/rate-limiter')
const Url = require('url')

const MAX_RATE: number = 1e6 // max possible rate per domain
const MIN_RATE: number = 1 // min rate per domain
const RATE_INTERVAL: number = 1000
const RATE_LOWER_WEIGHT: number = 18 // weight of fails compared to successes
const RATE_LOWER_KOEF: number = 0.2
const RATE_RAISE_KOEF: number = 0.02
const MAX_PENDING: number = 3000 // max request queue size per domain
const MAX_BUFFER: number = 50 // max average socket buffer size per domain to prevent net overload
const AVG_TIME: number = 400
const CLEANUP_TIME: number = 60000 // self cleanup time

// -----------------------------------------------------------------------------
type RateCallback = (name: string, flag?: string) => number;
type FlagCallback = (url: string) => string;
type RateDirectionCallback =
    (code: string|number, agent: BaseThrottleAgent, limiter: RateLimiter) => number;
type RateLimiterMap = {[name: string]: RateLimiter};
type ClientRequest = Object;
type Socket = Object;
type ErrorWithCode = Error&{code?: number|string};
type StatsObject = {[name: string]: Object};
// -----------------------------------------------------------------------------

/**
 * Mixin for creating Agent classes with throttling.
 */
const BaseThrottleAgent = Base => class extends Base {
  rate: number
  rateInterval: number
  rateLowerWeight: number
  rateLowerKoef: number
  rateRaiseKoef: number
  getRate: RateCallback
  getFlag: FlagCallback
  maxPending: number
  checkBeforeRequest: boolean
  getRateDirection: RateDirectionCallback
  rateLimiters: RateLimiterMap
  lastCleanupTime: number

  /**
   * @param  {Object} options http.Agent options plus:
   *
   * - [checkBeforeRequest: Boolean] - check before request with `canAcceptRequest` method (true) or
   *   check on request (false)
   * - [rate: Number] - default rate limit. Override with `getRate()`.
   * - [rateInterval: Number] - rate interval, milliseconds. Default 1000.
   * - [rateLowerWeight: Number] - weight of lowering of rate compared to raising of rate. Default 18.
   * - [rateLowerKoef: Number] - decrease of rate koefficient, default 0.1
   * - [rateRaiseKoef: Number] - increase of rate koefficient, default 0.02
   * - [maxPending: Number] - max pending requests, default 3000
   * - [maxBuffer: Number] - max socket buffer size, default 50
   * - [getRate: RateCallback] - function to return max rate for endpoint.
   * - [getFlag: FlagCallback] - function to get stat label from URL. Return '' to use Agent's default `domain:port:`
   * - [getRateDirection: RateDirectionCallback] - function to make decision of rate modification. Returns
   *   -1 to decrease, 1 to increase and 0 to do nothing.
   *   By default rate is increased on every 2xx, 3xx code or if there are free opened sockets available, and decreased
   *   on timeouts, errors or when pending sockets number is high.
   *
   *  Emits 'stat' on stat update (current interval count reset).
   */
  constructor (options?: Object) {
    options = options || {}
    super(options)

    this.rate = options.rate || MAX_RATE

    this.rateInterval = options.rateInterval || RATE_INTERVAL
    this.rateLowerWeight = options.rateLowerWeight || RATE_LOWER_WEIGHT
    this.rateLowerKoef = options.rateLowerKoef || RATE_LOWER_KOEF
    this.rateRaiseKoef = options.rateRaiseKoef || RATE_RAISE_KOEF
    this.getRate = options.getRate || (() => this.rate)
    this.getFlag = options.getFlag || (() => '')
    this.maxPending = options.maxPending || MAX_PENDING
    this.maxBuffer = options.maxBuffer || MAX_BUFFER
    this.checkBeforeRequest = !!options.checkBeforeRequest
    this.rateLimiters = {}
    this.lastCleanupTime = Date.now()

    this.getRateDirection = options.getRateDirection || ((code, agent, limiter) => {
      let sockets = agent.sockets[limiter.name]
      if (!sockets || agent.maxSockets - sockets.length > 0) return 1
      let requests = agent.requests[limiter.name]
      if (requests && requests.length > 1000) return -1
      if (typeof code === 'number' && code >= 200 && code < 400) return 1
      return -1
    })
  }

  /**
   * Check if agent can accept request before request object creation. Need option `checkBeforeRequest: true`.
   * Recommended to use to save CPU resource, as is called before request object is created.
   * @param  {String} url
   * @return {Boolean}
   */
  canAcceptRequest (url: string): boolean {
    if (!this.checkBeforeRequest) return true
    let _url: Object = Url.parse(url)
    let name = _url.hostname + ':' + (_url.port || 80) + ':'
    let flag: string = this.getFlag(url)
    return this._canAcceptRequest(name, flag, true)
  }

  /**
   * Internal check if agent can accept request.
   */
  _canAcceptRequest (name: string, flag: string, withFailed: boolean): boolean {
    let limiter: RateLimiter = this._getLimiter(name, flag)

    let requests = this.requests[name]

    // Preventive rate limit based on request queue count.
    if (requests && requests.length >= this.maxPending) {
      limiter.incomingThisInterval++
      if (withFailed) limiter.failed++
      return false
    }

    // Preventive rate limit based on socket buffer size. Important is to stop requests when buffer size is raising.
    if (limiter.tokensThisInterval) {
      let sockets = this.sockets[name]
      if (sockets) {
        let maxBuffer = limiter.averageTime < AVG_TIME ? this.maxBuffer * 7 : this.maxBuffer
        let bufferSize = 0
        let bufferCount = 0
        for (var i = 0, len = sockets.length; i < len; i++) {
          bufferSize += sockets[i].bufferSize
          bufferCount++
        }
        if (bufferCount && bufferSize / bufferCount > maxBuffer) {
          limiter.incomingThisInterval++
          if (withFailed) limiter.failed++
          return false
        }
      }
    }

    return limiter.accept(1)
  }

  /**
   * http.Agent method
   * @param {request: ClientRequest}
   * @param {info: Object}
   */
  addRequest (request: ClientRequest, info: Object) {
    let name: string = this.getName(info)
    let flag: string = this.getFlag(info.uri ? info.uri.href : '')

    if (!this.checkBeforeRequest) {
      if (!this._canAcceptRequest(name, flag, false)) {
        request.abort()
        let errorListeners = request._events['error']
        if (errorListeners && errorListeners.length) {
          let e: ErrorWithCode = new Error('429 Too Many Requests')
          e.code = 429
          request.emit('error', e)
        }
        return
      }
    }

    let limiter: RateLimiter = this._getLimiter(name, flag)
    let startTime: number = Date.now()

    let clearAgentTimeout = function () {
      if (request._agentTimeout) {
        clearTimeout(request._agentTimeout)
        request._agentTimeout = null
      }
    }

    request.on('response', (response) => {
      clearAgentTimeout()
      limiter.addTime(Date.now() - startTime)
      this._changeRate(limiter, response.statusCode)
    }).on('error', (err) => {
      clearAgentTimeout()
      limiter.addTime(Date.now() - startTime)
      this._changeRate(limiter, err.code)
    }).on('abort', () => {
      clearAgentTimeout()
      if (request.socket) request.socket.destroy()
    })

    if (info.timeout) {
      request._agentTimeout = setTimeout(() => {
        request.abort()
      }, info.timeout)
    }

    return super.addRequest(request, info)
  }

  /**
   * http.Agent method
   */
  /* createSocket (req: ClientRequest, options: Request, cb: Function) {
    return super.createSocket(req, options, (err: Error, s: Socket) => {
      if (err) return cb(err)
      // s.setNoDelay(true);
      // s.setKeepAlive(true, this.keepAliveMsecs || 2000);
      // set the default timer
      if (options.timeout) s.setTimeout(options.timeout)
      cb(null, s)
    })
  } */

  /**
   * http.Agent method
   * @param  {Socket} socket
   * @param  {Request} request
   */
  removeSocket (socket: Socket, request: Request, cb?: Function) {
    if (this.lastCleanupTime + CLEANUP_TIME < Date.now()) this._cleanup()
    return super.removeSocket(socket, request, cb)
  }

  /**
   * Get stats
   * @return {Object}
   */
  getStats (): StatsObject {
    let stats: StatsObject = {}
    Object.keys(this.rateLimiters).forEach((key: string) => {
      let limiter = this.rateLimiters[key]
      let name = limiter.name
      let limiterStat: {[key: string]: number} = limiter.getStat()
      let bufferSize = 0
      let sockets = this.sockets[name]
      if (sockets) {
        sockets.forEach((socket) => {
          if (socket.bufferSize) bufferSize += socket.bufferSize
        })
      }
      stats[limiter.flag || name] = {
        name: name,
        accepted: limiterStat.accepted,
        incoming: limiterStat.incoming,
        rate: limiterStat.limit,
        averageTime: limiterStat.averageTime,
        used: sockets ? sockets.length : 0,
        free: this.freeSockets[name] ? this.freeSockets[name].length : 0,
        pending: this.requests[name] ? this.requests[name].length : 0,
        bufferSize: bufferSize
      }
    })
    return stats
  }

  /**
   * Get rate limiter by name and flag
   */
  _getLimiter (name: string, flag: string): RateLimiter {
    let key = name + (flag || '')
    let limiter: ?RateLimiter = this.rateLimiters[key]
    let rate: number = this.getRate(name, flag) || MAX_RATE
    if (!limiter) {
      limiter = new RateLimiter(rate, this.rateInterval)
      limiter.success = limiter.failed = 0
      limiter.lastRate = rate
      limiter.lastRateTime = Date.now()
      limiter.name = name
      limiter.flag = flag
      this.rateLimiters[key] = limiter
    }
    if (limiter.lastRate !== rate) {
      limiter.lastRate = rate
      limiter.setLimit(Math.min(limiter.limit, rate))
    }
    return limiter
  }

  /**
   * Change rate based on response code
   */
  _changeRate (limiter: RateLimiter, code: string|number) {
    let dir: number = this.getRateDirection(code, this, limiter)
    if (dir === 1) {
      limiter.success++
    } else if (dir === -1) {
      limiter.failed++
    }

    if (limiter.lastRateTime + this.rateInterval <= Date.now()) {
      let rate: number = this.getRate(limiter.name, limiter.flag) || MAX_RATE
      limiter.lastRateTime = Date.now()
      let diff = limiter.success - limiter.failed * this.rateLowerWeight
      if (diff !== 0) {
        let limitDiff = Math.max(Math.floor(limiter.limit *
                    (diff < 0 ? this.rateLowerKoef : this.rateRaiseKoef)), 1)
        let limit = limiter.limit + Math.sign(diff) * limitDiff
        if (limit > rate) limit = rate
        if (limit < MIN_RATE) limit = MIN_RATE
        limiter.setLimit(limit)
      }
      limiter.success = limiter.failed = 0
    }
  }

  /**
   * Internal cleanup
   */
  _cleanup () {
    this.lastCleanupTime = Date.now()
    Object.keys(this.rateLimiters).forEach((key: string) => {
      let name: string = this.rateLimiters[key].name
      if (this.rateLimiters[key].curIntervalStart + CLEANUP_TIME < Date.now() &&
                (!this.sockets[name] || !this.sockets[name].length) &&
                (!this.freeSockets[name] || !this.freeSockets[name].length) &&
                (!this.requests[name] || !this.requests[name].length)) {
        delete this.rateLimiters[key]
      }
    })
  }
}

// -----------------------------------------------------------------------------

/**
 * HTTP Agent class with throttling.
 */
class HTTPThrottleAgent extends BaseThrottleAgent(http.Agent) {}

/**
 * HTTPS Agent class with throttling.
 */
class HTTPSThrottleAgent extends BaseThrottleAgent(https.Agent) {}

// -----------------------------------------------------------------------------

module.exports = HTTPThrottleAgent
HTTPThrottleAgent.HTTPSThrottleAgent = HTTPSThrottleAgent
