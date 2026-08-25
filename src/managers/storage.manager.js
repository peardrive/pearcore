import { createChild } from '../logger.js';
import { stripIds } from "../utils/general.utils.js"
import { decodeShareLink, deleteShareLink, queryShareLink, saveShareLink } from '../utils/sharelink.utils.js';
import {
    generateSpaceTopic,
    createSpaceForPublicKey,
    updateSpaceForPublicKey,
    upsertSpace,
    listSpaces,
    querySpace,
    getSpace,
    deleteSpace,
    getSpaceTopicHash,
} from '../utils/space.utils.js';
import {
    createMessageRecord,
    queryMessageRecord,
    flushMessageRecord
} from "../utils/message.utils.js"
import {
    queryProfileRecord,
    createProfileForPublicKey,
    createProfile,
    updateProfile,
    getProfileByPublicKey,
    updateProfileForPublicKey,
} from "../utils/profile.utils.js"
import { now } from '../utils/general.utils.js';
import { hash, hex } from '../utils/crypto.utils.js';
import { deleteFileRecord, generateFileRecord, getSpaceFromRegistryRecord, listFileRegisteryRecords, queryFileIndexRecord, queryFileRegistryRecords } from '../utils/files.utils.js';

const logger = createChild('SpaceStorageManager');

export class StorageManager {
    constructor(emitter, { sessionManager }) {
        this.sessionManager = sessionManager
    }

    get db() {
        return this.sessionManager.getDatabase().db;
    }

    /**
     * Create a new space and persist it to the database.
     *
     * The space is derived from the provided public key and secret key pair.
     * After creation, the full space record is retrieved, a share link is
     * generated for external access, and a deterministic messaging topic
     * is computed for use in network communications.
     *
     * @param {Object} spaceData - Space metadata used during creation.
     * @param {string} secretKey - Secret key used to derive and authorize
     *                             the space creation.
     *
     * @returns {Promise<Object>} Result object containing:
     * @returns {Object} returns.space - The persisted space record.
     */
    async createSpace(spaceData, secretKey) {
        const { spaceId } = await createSpaceForPublicKey(
            this.db,
            spaceData,
            secretKey
        );
        const space = await getSpace(this.db, spaceId);
        return stripIds(space);
    }

    async querySpace(criteria) {
        const queryResult = await querySpace(this.db, criteria);
        return queryResult.map(space => stripIds(space))
    }

    async upsertSpace(spaceData) {
        const space = await upsertSpace(this.db, spaceData);
        return stripIds(space)
    }

    async updateSpace(newParams, secretKey) {
        const { spaceName, publicKey, nonce } = newParams;

        const spaceQuery = await querySpace(this.db, { spaceName, publicKey, nonce });
        if (spaceQuery.length === 0) throw new Error('space record not found for update');

        const oldSpace = spaceQuery[0];
        const updatedSpace = { ...oldSpace, ...newParams, id: oldSpace.id };
        await updateSpaceForPublicKey(this.db, oldSpace.id, updatedSpace, secretKey);
    }

    /**
     * Deletes space records from databse fetched by query parameters.
     * @param {Object} queryParams - The space query parameters
     * @returns {Promise<void>} Resolves when the queried spaces get deleted.
     */
    async deleteSpace(queryParams) {
        const spaceQuery = await querySpace(this.db, queryParams);
        for (const space of spaceQuery) {
            await deleteSpace(this.db, space.id);
        }
    }

    /**
     * Retrieve list of all recorded spaces.
     *
     * If a public key is provided, the result is filtered to spaces associated
     * with that public key. If omitted, all spaces visible to the current
     * database are returned.
     *
     * @param {string} [publicKey] - Optional public key used to filter spaces
     *                              owned by or associated with the key.
     * @returns {Promise<Array<Object>>} Array of space objects.
     */
    async listSpaces(publicKey) {
        const spaces = await listSpaces(this.db, publicKey ? { publicKey } : undefined);
        return spaces.map(space => ({ ...stripIds(space) }));
    }

    /**
     * Generates a dictionary that maps hashes of space topics to their original space objects.
     * 
     * @returns {Promise<Object>} A promise that resolves to an object where:
     *   - Keys are hexadecimal hash strings (computed from topic names)
     *   - Values are the original space objects
     */
    async generateSpaceTopicHashMap() {
        const spaces = await this.listSpaces();
        const hashMap = {};

        spaces.forEach(space => {
            const topicHash = getSpaceTopicHash(space);
            hashMap[topicHash] = space;
        });

        return hashMap;
    }

    /**
     * save a new message record.
     * @param {Object} params
     * @param {Object} params.message - Original message from the network
     * @param {string} params.senderPublicKey - Immediate sender's public key
     * @param {number} params.broadcastTimestamp - When the message was broadcasted
     * @returns {Promise<Object>} Created message record
     */
    async saveMessageRecord({ message, senderPublicKey }) {
        const messageRecord = await createMessageRecord(this.db, {
            message,
            senderPublicKey,
            broadcastTimestamp: now(),
        });

        return stripIds(messageRecord)
    }

    /**
     * Query message records using filters.
     * 
     * @param {Object} filters - query filters (all optional)
     * @param {number} filters.id - exact ID match
     * @param {string} filters.type - exact type match
     * @param {string} filters.topic - exact topic match
     * @param {boolean} filters.isRelay - relay status (true/false)
     * @param {string} filters.senderPublicKey - sender's public key (exact match)
     * @param {Object} filters.broadcastTimestamp - broadcast timestamp range
     * @param {number} filters.broadcastTimestamp.start - start timestamp (inclusive)
     * @param {number} filters.broadcastTimestamp.end - end timestamp (inclusive)
     * @param {Object} filters.messageTimestamp - message timestamp range
     * @param {number} filters.messageTimestamp.start - start timestamp (inclusive)
     * @param {number} filters.messageTimestamp.end - end timestamp (inclusive)
     * @param {string} filters.nonce - exact nonce match
     * @param {string} filters.messageOwnerPublicKey - owner's public key (exact match)
     * @param {string} filters.signature - exact signature match
     * @param {string} filters.payloadContains - substring search in payload (case-insensitive)
     * @param {number} filters.limit - maximum records to return (default: 100, max: 1000)
     * @param {number} filters.offset - records to skip (default: 0)
     * @param {string} filters.orderBy - field to order by: 'messageTimestamp', 'broadcastTimestamp', or 'id' (default: 'messageTimestamp')
     * @param {string} filters.orderDirection - 'asc' for ascending, 'desc' for descending (default: 'desc')
     * @returns {Promise<Array>} array of message records with isRelay as boolean
     */
    async queryMessages(filters = {}) {
        const isDefined = obj => obj !== null && obj !== undefined;
        const shouldBeString = obj => typeof obj === 'string';

        const { sharelink, ...baseFilters } = filters;
        let resolvedFilters = baseFilters;

        if (isDefined(sharelink) && shouldBeString(sharelink)) {
            const decoded = decodeShareLink(sharelink)
            if (decoded) {
                const topic = generateSpaceTopic(
                    decoded.spaceName,
                    decoded.publicKey,
                    decoded.nonce
                )

                resolvedFilters = { ...resolvedFilters, topic };
            }
        }

        const flushedResult = await queryMessageRecord(this.db, resolvedFilters);
        return flushedResult.map(message => stripIds(message));
    }

    /**
     * Delete message records from the database based on filter criteria.
     * 
     * @param {Object} filters - query filters to determine which records to delete (all optional)
     * @param {string} filters.sharelink - encoded sharelink for specific space.
     * @param {number} filters.id - exact ID match
     * @param {string} filters.type - exact type match
     * @param {string} filters.topic - exact topic match
     * @param {boolean} filters.isRelay - relay status (true/false)
     * @param {string} filters.senderPublicKey - sender's public key (exact match)
     * @param {Object} filters.broadcastTimestamp - broadcast timestamp range
     * @param {number} filters.broadcastTimestamp.start - start timestamp (inclusive)
     * @param {number} filters.broadcastTimestamp.end - end timestamp (inclusive)
     * @param {Object} filters.messageTimestamp - message timestamp range
     * @param {number} filters.messageTimestamp.start - start timestamp (inclusive)
     * @param {number} filters.messageTimestamp.end - end timestamp (inclusive)
     * @param {string} filters.nonce - exact nonce match
     * @param {string} filters.messageOwnerPublicKey - owner's public key (exact match)
     * @param {string} filters.signature - exact signature match
     * @param {string} filters.payloadContains - substring search in payload (case-insensitive)
     * @param {number} filters.limit - maximum records to delete (default: 100, max: 1000, use with caution)
     * @returns {Promise<Array>} array of deleted message records with isRelay as boolean
     */
    async flushMessages(filters = {}) {
        const isDefined = obj => obj !== null && obj !== undefined;
        const shouldBeString = obj => typeof obj === 'string';

        const { sharelink, ...baseFilters } = filters;
        let resolvedFilters = baseFilters;

        if (isDefined(sharelink) && shouldBeString(sharelink)) {
            const decoded = decodeShareLink(sharelink)
            if (decoded) {
                const topic = generateSpaceTopic(
                    decoded.spaceName,
                    decoded.publicKey,
                    decoded.nonce
                )

                resolvedFilters = { ...resolvedFilters, topic };
            }
        }

        const flushedResult = await flushMessageRecord(this.db, resolvedFilters);
        return flushedResult.map(message => stripIds(message));
    }

    /**
     * Convenience helper to fetch messages for a topic.
     *
     * @param {string} topic
     * @param {Object} [options]
     * @returns {Promise<Array>}
     */
    async listMessagesByTopic(topic, options = {}) {
        return this.queryMessages({
            topic,
            ...options,
        });
    }

    /**
     * Convenience helper to fetch messages for a space owner.
     *
     * @param {string} publicKey
     * @param {Object} [options]
     * @returns {Promise<Array>}
     */
    async listMessagesByOwner(publicKey, options = {}) {
        return this.queryMessages({
            messageOwnerPublicKey: publicKey,
            ...options,
        });
    }

    /**
     * Create profile record from valid payload.
     * 
     * @param {Object} profile - The profile payload 
     * @returns {Object} - Resolves when the profile record gets stored.
     */
    async createProfile(profile) {
        const result = await createProfile(this.db, profile);
        return stripIds(result);
    }

    /**
     * Update profile record from valid payload. This payload should maintain existing
     * PublicKey from the user to fetch the existing profile record in order to update the database.
     * 
     * @param {Object} profile - The profile payload
     * @returns {Object} Resolves when the profile record updates
     */
    async updateProfile(profile) {
        const existingProfile = await getProfileByPublicKey(this.db, profile.publicKey);
        if (!existingProfile) throw new Error('No profile record has been found for publicKey');

        const result = await updateProfile(this.db, existingProfile.id, profile);
        return stripIds(result);
    }

    /**
     * Query user profiles. See src/utils/profile.utils.js (function queryProfileRecord) for filter options.
     *
     * @param {Object} [filters={}] - Filter, order, and pagination options
     * @returns {Promise<Array>} User profile records
     */
    async queryProfiles(filters = {}) {
        const queryResult = await queryProfileRecord(this.db, filters);
        return queryResult.map(profile => stripIds(profile));
    }

    /**
     * Fetch profile record by the publicKey
     * 
     * @param {String} publicKey - 64 character hex string as publicKey
     * @returns {Object|null} Returns profile object found by publicKey, or null if no record found.
     */
    async getProfileByPublicKey(publicKey) {
        const result = await getProfileByPublicKey(this.db, publicKey);
        if (result !== null) return stripIds(result);
        return null;
    }

    /**
     * Create profile record using keypair credentials.
     * @param {Object} profile 
     * @param {String} secretKey 
     */
    async createProfileForPublicKey(profile, secretKey) {
        const result = await createProfileForPublicKey(this.db, profile, secretKey);
        return stripIds(result);
    }

    /**
     * Update profile record using keypair credentials.
     * @param {Object} newProfile 
     * @param {String} secretKey 
     */
    async updateProfileForPublicKey(newProfile, secretKey) {
        const profileResult = await getProfileByPublicKey(this.db, newProfile.publicKey);
        if (!profileResult) return null;

        const updatedProfile = await updateProfileForPublicKey(this.db, profileResult.id, newProfile, secretKey);
        return stripIds(updatedProfile);
    }

    /**
     * Creates a sharelink record for a given space with optional prefix (prefix://link).
     * @param {Object} space - space object
     * @param {String} prefix - prefix name
     * @returns {Promise<Object>} returns sharelink record instance
     */
    async createShareLink(space) {
        const sharelink = await saveShareLink(this.db, {
            spaceName: space.spaceName,
            publicKey: space.publicKey,
            nonce: space.nonce
        });

        return stripIds(sharelink);
    }

    /**
     * Queries for existing sharelink records based on space name, publicKey, and nonce.
     * @param {Object} params
     * @param {String} params.spaceName - sharelink's space name
     * @param {String} params.publicKey - sharelink's author publicKey
     * @param {String} params.nonce - sharelink's space nonce
     * @returns {Promise<Array>} returns list of sharelinks based on the query parameters
     */
    async queryShareLink({ spaceName, publicKey, nonce }) {
        const queryResult = await queryShareLink(this.db, { spaceName, publicKey, nonce });
        //return queryResult.map(item => stripIds(item));
        return queryResult
    }

    async listSharelinkTopics(returnHash = false) {
        const query = await this.queryShareLink({});
        return query.map(sharelink => {
            const topicName = generateSpaceTopic(
                sharelink.spaceName,
                sharelink.publicKey,
                sharelink.nonce
            );

            return returnHash ? hex(hash(topicName)) : topicName;
        })
    }

    /**
     * Deletes sharelink record from the database.
     * @param {Number} sharelinkId - primaryKey ID for the sharelink within database
     * @returns {Promise<void>} Reolves when sharelinks get deleted.
     */
    async deleteShareLink(queryParams) {
        const queryResult = await queryShareLink(this.db, queryParams);

        for (const sharelink of queryResult) {
            await deleteShareLink(this.db, sharelink.id);
        }
    }

    /**
     * Generates a dictionary that maps hashes of sharelink topics to their original sharelink objects.
     * 
     * @returns {Promise<Object>} A promise that resolves to an object where:
     *   - Keys are hexadecimal hash strings (computed from topic names)
     *   - Values are the original sharelink objects
     */
    async generateShareLinkTopicHashMap() {
        const sharelinks = await queryShareLink(this.db, {});
        const hashMap = {};

        sharelinks.forEach(sharelink => {
            const topic = generateSpaceTopic(sharelink.spaceName, sharelink.publicKey, sharelink.nonce);
            const topicHash = hex(hash(topic));
            hashMap[topicHash] = sharelink;
        });

        return hashMap;
    }

    /**
     * Returns Arrays of 64 character hex strings that represents combined topics 
     * @returns {Promise<Array<string>>} A promise that resolves to an array of 64-character hexadecimal strings,
     * representing the combined topic hashes from both space topics and sharelinks
     */
    async getTopicHashList() {
        const spaceTopicHashMap = await this.generateSpaceTopicHashMap();
        const sharelinkTopicHashMap = await this.generateShareLinkTopicHashMap();

        const hashList = [];
        hashList.push(...Object.keys(spaceTopicHashMap));
        hashList.push(...Object.keys(sharelinkTopicHashMap));

        return Array.from(new Set(hashList));
    }

    /**
     * Create file record and generate indexing.
     * @param {{ spaceName: string, publicKey: string, nonce: string }} params.space - Associated space to this file.
     * @param {string} params.filePath - Local file path.
     * @param {string} params.spacePath - Virtual directory path for space.
     * @param {string} params.spaceFilename - Virtual file name for space.
     * @param {EventEmitter} params.emitter - Optional emitter to track indexing progress.
     * @returns {Promise<void>} Resolved when the indexing has been saved into database.
     */
    async createFileRecord(params) {
        const {
            space,
            filePath,
            spacePath,
            spaceFilename,
            emitter
        } = params;

        const { publicKey, spaceName, nonce } = space;
        const spaceQuery = await querySpace(this.db, { publicKey, spaceName, nonce });
        if (spaceQuery.length === 0) {
            throw new Error('Space not found');
        }

        const { rootHash } = await generateFileRecord({
            db: this.db,
            spaceId: spaceQuery[0].id,
            fileSourcePath: filePath,
            spacePath: spacePath,
            spaceFilename: spaceFilename,
            emitter: emitter
        });

        return rootHash;
    }

    async queryFileRegistryRecords(filters) {
        return await queryFileRegistryRecords(this.db, filters);
    }

    /**
     * Get referenced space object from registry record.
     * @param {Object} registryRecord - The file registry record object.
     * @returns {Promise<Object>} - Resolves with associated space object.
     */
    async getSpaceFromFileRecord(registryRecord) {
        const space = await getSpaceFromRegistryRecord(this.db, registryRecord);
        return stripIds(space);
    }

    /**
     * List of file registry records from database.
     * @returns {Promise<Array<Object>>} Resolves when all records has been fetched.
     */
    async listFileRecords() {
        const query = await listFileRegisteryRecords(this.db);
        return query.map(item => stripIds(item));
    }

    /**
     * Deletes a file record with all the indexing from the database.
     * @param {Object} fileSourcePath - The file source path from registry record.
     * @returns {Promise<Array>} - Resolves array of all deleted registry records.
     */
    async deleteFileRecords(fileSourcePath) {
        const query = await queryFileRegistryRecords(
            this.db,
            { fileSourcePath }
        );

        for (const record in query) {
            await deleteFileRecord(this.db, record.id);
        }

        return query;
    }
}