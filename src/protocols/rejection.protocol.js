import * as EVENTS from '../constants/events.constants.js';
import { hex } from '../utils/crypto.utils.js';
import { BaseProtocolHandler } from "./base.js";

export class RejectionProtocolHandler extends BaseProtocolHandler {
    async handle(socket, message, info) {
        const publicKey = hex(info.publicKey);

        // trigger rejection event to be used within other managers/services.
        this.emit(EVENTS.Reject, {
            info,
            message,
            fromPublicKey: publicKey,
            reason: message.payload.reason,
            linkedMessageNonce: message.payload.linkedMessageNonce,
        });
    }
}