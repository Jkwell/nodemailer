'use strict';

const packageData = require('../../package.json');
const shared = require('../shared');
const LeWindows = require('../sendmail-transport/le-windows');

/**
 * Generates a Transport object for Sendmail
 *
 * Possible options can be the following:
 *
 *  * **path** optional path to sendmail binary
 *  * **args** an array of arguments for the sendmail binary
 *
 * @constructor
 * @param {Object} optional config parameter for the AWS Sendmail service
 */
class SESTransport {
    constructor(options) {
        options = options || {};

        this.options = options || {};
        this.ses = this.options.SES;

        this.name = 'SESTransport';
        this.version = packageData.version;

        this.logger = shared.getLogger(this.options, {
            component: this.options.component || 'ses-transport'
        });

        // parallel sending connections
        this.maxConnections = Number(this.options.maxConnections) || Infinity;
        this.connections = 0;

        // max messages per second
        this.sendingRate = Number(this.options.sendingRate) || Infinity;
        this.sendingRateTTL = null;
        this.rateInterval = 1000;
        this.rateMessages = [];

        this.pending = [];
    }

    /**
     * Schedules a sending of a message
     *
     * @param {Object} emailMessage MailComposer object
     * @param {Function} callback Callback function to run when the sending is completed
     */
    send(mail, callback) {
        if (this.connections >= this.maxConnections) {
            return this.pending.push({
                mail,
                callback
            });
        }
        if (!this._checkSendingRate()) {
            return this.pending.push({
                mail,
                callback
            });
        }
        this._send(mail, (...args) => {
            setImmediate(() => callback(...args));
            this._sent();
        });
    }

    _checkRatedQueue() {
        if (this.connections >= this.maxConnections || !this._checkSendingRate() || !this.pending.length) {
            return;
        }

        let next = this.pending.shift();
        this._send(next.mail, (...args) => {
            setImmediate(() => next.callback(...args));
            this._sent();
        });
    }

    _checkSendingRate() {
        clearTimeout(this.sendingRateTTL);

        let now = Date.now();
        // delete older messages
        let remove = 0;
        for (let i = 0; i < this.rateMessages.length; i++) {
            if (this.rateMessages[i] > now - this.rateInterval) {
                break;
            }
            remove++;
        }
        if (remove) {
            this.rateMessages.splice(0, remove);
        }

        if (this.rateMessages.length < this.sendingRate) {
            return true;
        }

        let delay = Math.max(this.rateMessages[0] + 1001, now + 20);
        this.sendingRateTTL = setTimeout(() => this._checkRatedQueue(), now - delay);
        this.sendingRateTTL.unref();
        return false;
    }

    _sent() {
        this.connections--;
        this._checkRatedQueue();
    }

    /**
     * Compiles a mailcomposer message and forwards it to SES
     *
     * @param {Object} emailMessage MailComposer object
     * @param {Function} callback Callback function to run when the sending is completed
     */
    _send(mail, callback) {
        this.connections++;
        this.rateMessages.push(Date.now());

        let envelope = mail.data.envelope || mail.message.getEnvelope();
        let messageId = mail.message.messageId();

        let recipients = [].concat(envelope.to || []);
        if (recipients.length > 3) {
            recipients.push('...and ' + recipients.splice(2).length + ' more');
        }
        this.logger.info({
            tnx: 'send',
            messageId
        }, 'Sending message %s to <%s>', messageId, recipients.join(', '));

        let getRawMessage = next => {

            // do not use Message-ID and Date in DKIM signature
            if (!mail.data._dkim) {
                mail.data._dkim = {};
            }
            if (mail.data._dkim.skipFields && typeof mail.data._dkim.skipFields === 'string') {
                mail.data._dkim.skipFields += ':date:message-id';
            } else {
                mail.data._dkim.skipFields = 'date:message-id';
            }

            let stream = mail.message.createReadStream().pipe(new LeWindows());
            let chunks = [];
            let chunklen = 0;

            stream.on('readable', () => {
                let chunk;
                while ((chunk = stream.read()) !== null) {
                    chunks.push(chunk);
                    chunklen += chunk.length;
                }
            });

            stream.once('error', err => {
                next(err);
            });

            stream.once('end', () => next(null, Buffer.concat(chunks, chunklen)));
        };

        setImmediate(() => getRawMessage((err, raw) => {
            if (err) {
                this.logger.error({
                    err,
                    tnx: 'send',
                    messageId
                }, 'Failed creating message for %s. %s', messageId, err.message);
                return callback(err);
            }

            let sesMessage = {
                RawMessage: { // required
                    Data: raw // required
                },
                Source: envelope.from,
                Destinations: envelope.to
            };

            Object.keys(mail.data.ses || {}).forEach(key => {
                sesMessage[key] = mail.data.ses[key];
            });

            this.ses.sendRawEmail(sesMessage, (err, data) => {
                if (err) {
                    this.logger.error({
                        err,
                        tnx: 'send'
                    }, 'Send error for %s: %s', messageId, err.message);
                    return callback(err);
                }

                let region = this.ses.config && this.ses.config.region || 'us-east-1';
                if (region === 'us-east-1') {
                    region = 'email';
                }

                callback(null, {
                    envelope: {
                        from: envelope.from,
                        to: envelope.to
                    },
                    messageId: '<' + data.MessageId + (!/@/.test(data.MessageId) ? '@' + region + '.amazonses.com' : '') + '>'
                });
            });
        }));
    }
}

module.exports = SESTransport;
