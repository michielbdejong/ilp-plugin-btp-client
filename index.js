const EventEmitter = require('eventemitter2')
const Spider = require('./spider')
const Codec = require('./codec')
const { URL } = require('url')
const uuid = require('uuid/v4')

const TESTNET_VERSION = '17q3'

class Plugin extends EventEmitter {
  constructor (config) {
    super()
    this.config = config
    this.codec = new Codec(TESTNET_VERSION)
    this.responsePromise = {}
  }

  connect () {
    // The BTP URI must follow one of the following formats:
    // btp+wss://auth_username:auth_token@host:port/path
    // btp+wss://auth_username:auth_token@host/path
    // btp+ws://auth_username:auth_token@host:port/path
    // btp+ws://auth_username:auth_token@host/path
    // See also: https://github.com/interledger/rfcs/pull/300
    const parsedBtpUri = new URL(this.config.btpUri)
    this._authUsername = parsedBtpUri.username
    this._authToken = parsedBtpUri.password
    parsedBtpUri.username = ''
    parsedBtpUri.password = ''
    // Note that setting the parsedBtpUri.protocol does not work as expected,
    // so removing the 'btp+' prefix from the full URL here:
    if (!parsedBtpUri.toString().startsWith('btp+')) {
      throw new Error('server uri must start with "btp+"')
    }
    this._wsUri = parsedBtpUri.toString().substring('btp+'.length)
    const spiderConnected = new Promise(resolve => {
      this.spider = new Spider({
        version: this.config.btpVersion,
        name: this._authUsername,
        upstreams: [ {
          url: this._wsUri,
          token: this._authToken
        } ]
      }, (peerId) => {
        console.log('connected!', peerId)
        this._peerId = peerId
        resolve()
      }, (obj, peerId) => {
        console.log('incoming message!', obj, peerId)
        if (this.responsePromise[obj.requestId]) {
          this.codec.fromBtpToPromise(obj, this.responsePromise[obj.requestId])
          delete this.responsePromise[obj.requestId]
        } else {
          this.codec.fromBtpToEvent(obj, this.emit.bind(this))
        }
      })
    })
    return this.spider.start().then(() => {
      console.log('spider started!')
      return spiderConnected
    }).then(() => {
      console.log('spider connected!')
      return Promise.all([
        this._send('request', [ { custom: { 'info': Buffer.from([ 0 ]) } } ]).then(result => this._account = result).then(() => console.log('now know account', this._account)),
        this._send('request', [ { custom: { 'info': Buffer.from([ 2 ]) } } ]).then(result => this._info = result).then(() => console.log('now know account', this._account))
      ])
    }).then(() => {
      this._isConnected = true
    })
  }
  disconnect () {
    this.spider.stop().then(() => {
      this._isConnected = true
    })
  }
  isConnected () { return Boolean(this._isConnected) }

  registerRequestHandler (handler) {
    if (this._requestHandler) {
      throw new Error('RequestHandlerAlreadyRegistered')
    }
    this._requestHandler = handler
  }
  deregisterRequestHandler () { delete this._requestHandler }

  _send(eventName, eventArgs) {
    const btpRequest = this.codec.toBtp(eventName, eventArgs)
    const serverResponse = new Promise((resolve, reject) => {
      this.responsePromise[btpRequest.requestId] = { resolve, reject }
    })
    console.log('plugin btp client sends a btp request', btpRequest)
    return this.spider.send(btpRequest, this._peerId).then(() => serverResponse)
  }

  getInfo () { return this._info }
  getAccount() { return this._account }
  getBalance () { return this._send('request', [ { custom: { 'balance': Buffer.from([ 0 ]) } } ]) } 
  getFulfillment (transferId) { return this._send('request', [ { custom: { 'get_fulfillment': transferId } } ]) } 
  sendTransfer (transfer) { return this._send('prepare', [ transfer ]) } 
  sendRequest (message) {
    return this._send('request', [ message ]).then(ilpResponseBase64 => {
      return {
        id: uuid(),
        from: message.to,
        to: message.from,
        ledger: message.ledger,
        ilp: ilpResponseBase64,
        custom: {}
      }
    })
  }
  fulfillCondition (transferId, fulfillment) { return this._send('fulfill', [ { id : transferId }, fulfillment ]) } 
  rejectIncomingTransfer (transferId, rejectionReason) { return this._send('reject', [ { id : transferId }, rejectionReason ]) }
}

module.exports = Plugin
