import {
  createPreloadedProfile,
  createProfileForPublicKey,
  getProfileByPublicKey,
  queryProfileRecord,
  updateProfileForPublicKey,
} from '../utils/profile.utils.js';
import { createProfileUpdateMessage } from '../utils/protocol.utils.js';
import { getShareLinkTopics } from '../utils/sharelink.utils.js';
import { getTopicList } from '../utils/space.utils.js';

export class ProfileService {
  [key: string]: any;

  constructor(emitter: any, { managers }: any) {
    this.managers = managers;
  }

  get db() {
    return this.managers.session.getDatabase().db;
  }

  /**
   * List user profiles with optional filtering, ordering, and pagination.
   *
   * @param [options] - Query options (all optional)
   *
   * - General options:
   * @param [options.username] - Exact username match
   * @param [options.tag] - Exact tag match
   * @param [options.profileURL] - Exact profile URL match
   * @param [options.publicKey] - Exact public key match
   *
   * - Time query options:
   * @param [options.timestampRange] - Timestamp range filter
   * @param [options.timestampRange.start] - Start timestamp (inclusive)
   * @param [options.timestampRange.end] - End timestamp (inclusive)
   *
   * - Sorting options:
   * @param [options.orderBy] - Field to order by: 'id', 'username', 'tag', 'timestamp'
   * @param [options.orderDirection] - 'asc' for ascending, 'desc' for descending
   *
   * - Pagination options:
   * @param [options.limit] - Maximum records to return (default: 50, max: 500)
   * @param [options.offset] - Records to skip (default: 0)
   */
  async list(options = {}) {
    const profiles = await queryProfileRecord(this.db, options);
    return profiles;
  }

  /**
   * Broadcast the profile context to the connnected nodes.
   * @returns Resolves when the payload has been sent to all nodes.
   */
  async broadcast() {
    const { publicKey, secretKey } = this.managers.session.getCredentials();
    const profile = await getProfileByPublicKey(this.db, publicKey);
    const spaceTopics = await getTopicList(this.db);
    const sharelinkTopics = await getShareLinkTopics(this.db);
    const topics = [...spaceTopics, ...sharelinkTopics];

    if (profile) {
      const message = await createProfileUpdateMessage({
        profile: profile,
        topics: topics,
        publicKey: publicKey,
        secretKey: secretKey,
      });

      const sockets = this.managers.sockets.getConnectedSockets();
      return await this.managers.message.broadcastMessageToSockets(
        message,
        sockets,
      );
    }
  }

  /**
   * Update the current user's profile
   * @param profile
   * @param profile.username
   * @param profile.tag
   * @param [profile.profileURL]
   * @returns updated profile row
   */
  async update(profile: any) {
    const { publicKey, secretKey } = this.managers.session.getCredentials();
    const profileRecord = await getProfileByPublicKey(this.db, publicKey);

    if (profileRecord) {
      const payload = { ...profileRecord, ...profile };
      await updateProfileForPublicKey(
        this.db,
        profileRecord.id,
        payload,
        secretKey,
      );
    } else {
      const preloadedProfile = createPreloadedProfile(publicKey);
      const payload = { ...preloadedProfile, ...profile };
      await createProfileForPublicKey(this.db, payload, secretKey);
    }

    return await this.broadcast();
  }

  /**
   * Get the profile of the current user
   * @param [publicKey] - optional, defaults to current session
   * @returns profile object or null if not found
   */
  async getCurrentProfile() {
    const { publicKey } = this.managers.session.getCredentials();
    const profile = await getProfileByPublicKey(this.db, publicKey);
    return profile;
  }
}
