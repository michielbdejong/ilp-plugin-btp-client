const BtpPacket = require('btp-packet')
const IlpPacket = require('ilp-packet')
const crypto = require('crypto')
const uuid = require('uuid/v4')
function base64url (buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }

const lpiVersion = {
  '17q3': 5, // See https://interledger.org/rfcs/0004-ledger-plugin-interface/draft-5.html
  '17q4': 7 // See https://interledger.org/rfcs/0004-ledger-plugin-interface/draft-7.html
}

const btpVersion = {
  '17q3': 0, // BtpPacket.BTP_VERSION_ALPHA, see https://github.com/interledger/rfcs/blob/8b65d63e3aeaadeeb40ca5d2c86722eadf11ab77/asn1/CommonLedgerProtocol.asn
  '17q4': 1  // BtpPacket.BTP_VERSION_1, see https://github.com/interledger/rfcs/pull/300
}

function generateRequestId () {
  const buf = crypto.randomBytes(4)
  const hex = buf.toString('hex')
  return parseInt(hex, 16)
}

function MakeProtocolData (obj) {
  let protocolData = []
  if (obj.ilp) {
    protocolData.push({
      protocolName: 'ilp',
      contentType: BtpPacket.MIME_APPLICATION_OCTET_STRING,
      data: Buffer.from(obj.ilp, 'base64')
    })
  }
  if (obj.custom) {
    for (let protocolName in obj.custom) {
      if (protocolName === 'vouch') {
        protocolData.push({
          protocolName,
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
          data: Buffer.from(obj.custom[protocolName], 'base64')
        })
      } else if (['info', 'balance'].indexOf(protocolName) !== -1) {
        protocolData.push({
          protocolName,
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
          data: obj.custom[protocolName]
        })
      } else {
        protocolData.push({
          protocolName,
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify(obj.custom[protocolName]), 'ascii')
        })
      }
    }
  }
  if (obj.from) {
    protocolData.push({
      protocolName: 'from',
      contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
      data: Buffer.from(obj.from, 'ascii')
    })
  }
  if (obj.to) {
    protocolData.push({
      protocolName: 'to',
      contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
      data: Buffer.from(obj.to, 'ascii')
    })
  }
  return protocolData
}

function lpiErrorToBtpError (err, whileFulfilling = false) {
  const messageAndCode = {
    UnreachableError: { code: 'T00', message: 'Temporary error, indicating that the connector cannot process this request at the moment. Try again later' },
    NotAcceptedError: { code: 'F00', message: 'Data were symantically invalid' },
    InvalidFieldsError: { code: 'F01', message: 'At least one field contained structurally invalid data, e.g. timestamp full of garbage characters' },
    TransferNotFoundError: { code: 'F03', message: 'The transferId included in the packet does not reference an existing transfer' },
    InvalidFulfillmentError: { code: 'F04', message: 'The fulfillment included in the packet does not match the transfer\'s condition' },
    DuplicateIdError: { code: 'F05', message: 'The transferId and method match a previous request, but other data do not' },
    AlreadyRolledBackError: { code: 'F06', message: 'The transfer cannot be fulfilled because it has already been rejected or expired' },
    AlreadyFulfilledError: { code: 'F07', message: 'The transfer cannot be rejected because it has already been fulfilled' },
    InsufficientBalanceError: { code: 'F08', message: 'The transfer cannot be prepared because there is not enough available liquidity' }
  }

  function makeError (name) {
    let err = new Error(messageAndCode[name].message)
    err.code = messageAndCode[name].code
    err.name = name
    return err
  }

  switch (err.name) {
    // errors with one-to-one mapping:
    case 'InvalidFieldsError':
    case 'UnreachableError':
    case 'TransferNotFoundError':
    case 'DuplicateIdError':
    case 'AlreadyRolledBackError':
    case 'AlreadyFulfilledError':
    case 'InsufficientBalanceError':
      return makeError(err.name)
    case 'NotAcceptedError':
      if (whileFulfilling) {
        return makeError('InvalidFulfillmentError')
      }
      return makeError(err.name)
    // LPI-only errors:
    case 'TransferNotConditionalError': return makeError('F03', 'TransferNotFoundError')
    case 'AccountNotFoundError': return makeError('F01', 'InvalidFieldsError')
    case 'NoSubscriptionsError': return makeError('T00', 'UnreachableError')
    // case 'MissingFulfillmentError':
    // case 'RequestHandlerAlreadyRegisteredError':
    default: return makeError('F00', 'NotAcceptedError')
  }
}

function lpiErrorToRejectionMessage (err, triggeredBy) {
  return {
    code: err.code,
    name: err.name,
    message: err.message,
    triggered_by: triggeredBy,
    forwarded_by: [],
    triggered_at: new Date().toISOString(),
    additional_info: {}
  }
}

function btpErrorToLpiError (err) {
  const message = {
    InvalidFieldsError: 'Arguments or configuration were invalidated client-side',
    UnreachableError: 'An error occured due to connection failure',
    TransferNotFoundError: 'A requested transfer does not exist, or is not conditional, and cannot be fetched', // also used for TransferNotConditionalError
    DuplicateIdError: 'A transfer with the same ID and different fields has been sent',
    AlreadyRolledBackError: 'A requested transfer has already been timed out or rejected and cannot be modified',
    AlreadyFulfilledError: 'A requested transfer has already been fulfilled and cannot be modified',
    InsufficientBalanceError: 'An operation has been rejected because the source balance isn\'t high enough',
    NotAcceptedError: 'An operation has been rejected due to ledger-side logic'
  }

  function makeError (name) {
    let err = new Error(message[name])
    err.name = name
    return err
  }
  switch (err.name) {
    // errors with one-to-one mapping:
    case 'UnreachableError': return makeError(err.name)
    case 'NotAcceptedError': return makeError(err.name)
    case 'InvalidFieldsError': return makeError(err.name)
    case 'TransferNotFoundError': return makeError(err.name)
    case 'DuplicateIdError': return makeError(err.name)
    case 'AlreadyRolledBackError': return makeError(err.name)
    case 'AlreadyFulfilledError': return makeError(err.name)
    case 'InsufficientBalanceError': return makeError(err.name)

    // BTP-only error, see
    // https://github.com/interledger/rfcs/blob/726705c/0004-ledger-plugin-interface/0004-ledger-plugin-interface.md#fulfillcondition
    case 'InvalidFulfillmentError': return makeError('NotAcceptedError')
    default: return makeError('NotAcceptedError')
  }
}

class Codec {
  constructor (testnetVersion) {
    this.lpiVersion = lpiVersion[testnetVersion]
    this.btpVersion = btpVersion[testnetVersion]
  }

  toBtp (eventType, eventArgs) {
    switch (eventType) {
      case 'prepare': {
        const transfer = eventArgs[0]
        return {
          type: BtpPacket.TYPE_PREPARE,
          requestId: generateRequestId(),
          data: {
            transferId: transfer.id, // String in both LPI and BTP
            expiresAt: new Date(transfer.expiresAt), // String in LPI, DateTime in BTP
            amount: transfer.amount, // String in both
            executionCondition: transfer.executionCondition, // Base64 in both
            protocolData: MakeProtocolData(transfer)
          }
        }
      }
      case 'fulfill': {
        const transfer = eventArgs[0]
        return {
          type: BtpPacket.TYPE_FULFILL,
          requestId: generateRequestId(),
          data: {
            transferId: eventArgs[0].id, // String in both LPI and BTP
            fulfillment: eventArgs[1], // Base64 in both
            protocolData: []
          }
        }
      }
      case 'reject': {
        return {
          type: BtpPacket.TYPE_REJECT,
          requestId: generateRequestId(),
          data: {
            transferId: eventArgs[0].id, // String in both LPI and BTP
            rejectionReason: Buffer.from(eventArgs[1], 'base64'), // Base64 in LPI, Buffer in BTP
            protocolData: []
          }
        }
      }
      case 'request': {
        const request = eventArgs[0]
        // For now, we just ignore request.id, as it's a ledger-level message id which is
        // unrelated to the id of the response, and unrelated to the BTP requestId
        // TODO: deduplicate these incoming events from the ledger, based on request.id
        const btpRequestId = generateRequestId()
        return {
          type: BtpPacket.TYPE_MESSAGE,
          requestId: btpRequestId,
          data: MakeProtocolData(request)
        }
      }
      case 'response': {
        const obj = eventArgs[0]
        return {
          type: BtpPacket.TYPE_RESPONSE,
          requestId: obj.id,
          data: MakeProtocolData(obj)
        }
      }
    }
  }

  fromBtpToPromise(obj, promise) {
    switch (obj.type) {
      case BtpPacket.TYPE_ACK:
        promise.resolve(null)
        break
      case BtpPacket.TYPE_RESPONSE:
        let responseData = null
        if (obj.data.length) {
          switch (obj.data[0].contentType) {
            case BtpPacket.MIME_APPLICATION_OCTET_STREAM:
              responseData = base64url(obj.data[0].data)
              break
            case BtpPacket.MIME_TEXT_PLAIN_UTF8:
              responseData = obj.data[0].data.toString('utf8')
              break
            case BtpPacket.MIME_APPLICATION_JSON:
              try {
                responseData = JSON.parse(obj.data[0].data.toString('utf8'))
              } catch(e) {
                responseData = { unparseable: obj.data[0].data.toString('utf8') }
              }
              break
          }
        }
        promise.resolve(responseData)
        break
      case BtpPacket.TYPE_ERROR:
        promise.reject(new Error(btpErrorToLpiError(obj.data.rejectionReason)))
    }
  }

  fromBtpToEvent(obj, emit) {
    try {
      let protocolDataAsObj = {}
      let protocolDataAsArr
      if ([BtpPacket.TYPE_ACK, BtpPacket.TYPE_MESSAGE, BtpPacket.TYPE_RESPONSE].indexOf(obj.type) !== -1) {
        protocolDataAsArr = obj.data
      } else {
        protocolDataAsArr = obj.data.protocolData
      }

      for (let i = 0; i < protocolDataAsArr.length; i++) {
        protocolDataAsObj[protocolDataAsArr[i].protocolName] = protocolDataAsArr[i]
      }

      let primaryProtocol
      let primaryData
      if (protocolDataAsArr.length) {
        primaryProtocol = protocolDataAsArr[0].protocolName
        primaryData = protocolDataAsArr[0].data
      }

      switch (obj.type) {
        case BtpPacket.TYPE_PREPARE:
          emit('incoming_prepare', {
            id: obj.data.transferId.toString(), // String in LPI, Number in BTP
            // from: this.plugin.getAccount(), // String
            to: protocolDataAsObj.to.data.toString('utf8'),
            // ledger: this.plugin.getInfo().prefix, // String
            amount: obj.data.amount, // String in both objects
            ilp: protocolDataAsObj.ilp.data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), // Base64 in LPI, Buffer in BTP
            noteToSelf: {},
            executionCondition: obj.data.executionCondition, // Base64 in both
            expiresAt: obj.data.expiresAt.toISOString(), // String in LPI, DateTime in BTP
            custom: {}
          })
          break
        case BtpPacket.TYPE_FULFILL:
          emit('outgoing_fulfill', { id: obj.data.transferId.toString() }, obj.data.fulfillment)
          break
        case BtpPacket.TYPE_REJECT:
          // transferId String in both LPI and BTP
          // rejectionReason Buffer in BTP but Object in LPI! 
          const btpErrorObj = IlpPacket.deserializeIlpError(obj.data.rejectionReason)
          const lpiErrorThrowable = btpErrorToLpiError(btpErrorObj)
          const lpiRejectionMessage = lpiErrorToRejectionMessage(lpiErrorThrowable, this.plugin.getAccount())
          emit('outgoing_reject', { id: obj.data.transferId.toString() }, lpiRejectionMessage)
          break
        case BtpPacket.TYPE_MESSAGE:
          emit('incoming_request', primaryData)
      }
    } catch (err) {
      console.error(err)
    }
  }
}

module.exports = Codec
