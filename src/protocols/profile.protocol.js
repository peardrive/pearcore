import * as MESSAGES from '../constants/messages.constants.js';
import * as EVENTS from '../constants/events.constants.js';
import { createProfile, getProfileByPublicKey, updateProfile, verifyProfileSignature } from "../utils/profile.utils.js";
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

        const existingProfile = await getProfileByPublicKey(this.db, profile.publicKey);
        if (!existingProfile) {
            await createProfile(this.db, profile);
        }

        else if (existingProfile.timestamp < profile.timestamp) {
            // the new profile is newer compared to local record.
            await updateProfile(this.db, existingProfile.id, profile);
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