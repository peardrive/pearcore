import * as MESSAGES from '../../constants/messages.constants.js';
import * as EVENTS from '../../constants/events.constants.js';
import {
  createProfile,
  getProfileByPublicKey,
  updateProfile,
  verifyProfileSignature,
} from '../../utils/profile.utils.js';
import { validateProfileUpdateMessagePayload } from '../../utils/protocol.utils.js';
import { BaseProtocolHandler } from '../base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from '../base.js';
import { validPayload, verified } from '../shared/guards.js';
import type { SignedProfile } from '../../utils/profile.utils.js';

type ProfileUpdatePayload = {
  profile: SignedProfile;
  topics: string[];
};

export class ProfileProtocolHandler extends BaseProtocolHandler {
  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessage<ProfileUpdatePayload>,
    info: PeerInfo,
  ): Promise<void> {
    const ctx = this.context(socket, message, info);

    const { result, reason } = await this.enforce(ctx, [
      // payload must contain a valid profile and topic list.
      validPayload(validateProfileUpdateMessagePayload),
      // profile signature must verify against the profile key.
      verified(
        (context) => verifyProfileSignature(context.message.payload.profile),
        MESSAGES.BAD_PROFILE_SIGNATURE,
      ),
    ]);

    if (!result) {
      await this.reject(ctx, reason);
      return;
    }

    const { profile, topics } = message.payload;

    const existingProfile = await getProfileByPublicKey(
      this.db,
      profile.publicKey,
    );

    if (!existingProfile) {
      await createProfile(this.db, profile);
    } else if (existingProfile.timestamp < profile.timestamp) {
      // the new profile is newer compared to local record.
      await updateProfile(this.db, existingProfile.id, profile);
    }

    this.emitProtocol(EVENTS.ProfileUpdate, ctx);

    if (ctx.senderPublicKey !== message.publicKey) {
      return;
    }

    const peers = this.socketManager.getPeerKeys((key) => {
      return (
        key !== message.publicKey &&
        key !== ctx.senderPublicKey &&
        key !== message.payload.profile.publicKey
      );
    });

    await this.forwardTo(message, peers, topics);
  }
}
