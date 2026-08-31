import * as MESSAGES from '../constants/messages.constants.js';
import * as EVENTS from '../constants/events.constants.js';
import { verifyProfileSignature } from "../utils/profile.utils.js";
import { validateProfileUpdateMessagePayload } from "../utils/protocol.utils.js";
import { hex } from '../utils/crypto.utils.js';
import { BaseProtocolHandler } from "./base.js";

export class ProfileProtocolHandler extends BaseProtocolHandler {
    async handle(socket, message, info) {
        const senderPublicKey = hex(info.publicKey);
        const { isValid: payloadIsValid, reason } = validateProfileUpdateMessagePayload(message);
        if (!payloadIsValid) {
            await this.messageManager.reject(socket, message, reason);
            return;
        }

        const { profile, topics } = message.payload;

        const profileSignatureIsValid = await verifyProfileSignature(profile);
        if (!profileSignatureIsValid) {
            await this.messageManager.reject(socket, message, MESSAGES.BAD_PROFILE_SIGNATURE);
            return;
        }

        const existingProfile = await this.storageManager.getProfileByPublicKey(profile.publicKey);
        if (!existingProfile) {
            await this.storageManager.createProfile(profile);
        }

        else if (existingProfile.timestamp < profile.timestamp) {
            // the new profile is newer compared to local record.
            await this.storageManager.updateProfile(profile);
        }

        this.emit(EVENTS.ProfileUpdate, { info, message });

        if (senderPublicKey === message.publicKey) {
            const peers = this.socketManager.getPeerKeys(key => {
                return key !== message.publicKey &&
                    key !== senderPublicKey &&
                    key !== message.payload.profile.publicKey
            });
            
            const sockets = this.socketManager.getConnectedSockets({
                peers: peers,
                topics: topics
            });

            await this.messageManager.broadcastMessageToSockets(message, sockets);
        }
    }
}