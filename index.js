const EventEmitter = require('eventemitter2')
const BtpPacket = require('btp-packet')
const BtpSpider = require('btp-toolbox').Spider
const { URL } = require('url')
const Codec = require('../../interledgerjs/btp-toolbox/src/codec')

class Plugin extends EventEmitter {
  constructor (config) {
    super()
    this.config = config
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
    this.spider = new BtpSpider({
      version: this.config.btpVersion,
      name: this._authUsername,
      upstreams: [ {
        url: this._wsUri,
        token: this._authToken
      } ]
    }, (peerId) => {
      console.log('connected!', peerId)
      this.peerId = peerId
    }, (msg, peerId) => {
      const obj = BtpPacket.deserialize(msg, this.config.version)
      console.log('incoming message!', msg, obj, peerId)
    })
    return this.spider.start().then(() => {
      this._isConnected = true
    })
  }

  disconnect () {
    this.spider.stop().then(() => {
      this._isConnected = true
    })
  }

  isConnected () {
    return Boolean(this._isConnected)
  }

  getInfo () {
    return this.sendEvent('request', [ { custom: { 'info': Buffer.from([ 2 ]) } } ])
  }

  getAccount() {
    return this.sendEvent('request', [ { custom: { 'info': Buffer.from([ 0 ]) } } ])
  }

  getBalance () {
    return this.sendEvent('request', [ { custom: { 'balance': Buffer.from([ 0 ]) } } ])
  }

  getFulfillment (transferId) {
    return this.sendEvent('request', [ { custom: { 'get_fulfillment': transferId } } ])
  }

  sendTransfer (transfer) {
    return this.sendEvent('prepare', [ transfer ])
  }

  sendRequest (message) {
    return this.sendEvent('request', [ message ])
  }

  fulfillCondition (transferId, fulfillment) {
    return this.send('fulfill', [ { id : transferId }, fulfillment ])
  }

  rejectIncomingTransfer (transferId, rejectionReason) {
    return this.send('reject', [ { id : transferId }, rejectionReason ])
  }

  registerRequestHandler (handler) {
    if (this._requestHandler) {
      throw new Error('RequestHandlerAlreadyRegistered')
    }
    this._requestHandler = handler
  }

  deregisterRequestHandler () {
    delete this._requestHandler
  }
}

module.exports = Plugin
