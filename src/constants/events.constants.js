/**
 * Emitted for initating or destroying socket connections
 */
export const Connection = 'Connection';
export const Disconnect = 'Disconnect';
export const Handshake = 'Handshake';

/**
 * Topic payload when message does not belong to dedicated topic.
 */
export const noTopic = 'noTopic';

/**
 * Nonce payload when constructing recieved message failed.
 */
export const noNonce = 'noNonce';

/**
 * Emitted when a node sends valid message.
 */
export const General = 'General';

/**
 * Emitted when a node explicitly rejects a request from a remote peer.
 * This is typically used to signal failures, invalid state,
 * or unsupported operations.
 */
export const Reject = "Reject";

/**
 * Emitted when a node advertises the list of spaces that it is currently
 * interested in or participating in.
 * This event is commonly used during initial handshake to
 * determine shared spaces and routing relevance.
 */
export const SpaceHashList = "SpaceHashList";

/**
 * Emitted to transmit space metadata to another node.
 * 
 */
export const SpaceSync = "SpaceSync";

/**
 * Generic application-level message event.
 * Used to send arbitrary, custom payloads that do not fit into the
 * predefined protocol events.
 */
export const SpaceMessage = "SpaceMessage";

/**
 * Emitted when a profile is updated or when a peer is requesting to join
 * a space using its profile information.
 * Depending on the sender, this event may represent either a propagated
 * update or an ownership-originated request.
 */
export const ProfileUpdate = "ProfileUpdate";

// Emitters related to local watchdog for local file registeries.
export const LocalFileChange = 'LocalFileChange';
export const LocalFileDetele = 'LocalFileDelete';

/**
 * Emitted when a file action (add/remove/merge) has been emitted within the space.
 */
export const SpaceFileEvent = "SpaceFileEvent";

/**
 * All event options for space file.
 */
export const SpaceFileEventOptions = {
    ADD: 'add',
    REMOVE: 'remove',
};


// Emitted when peer wants to ask for file Merkle tree information from connected node.
export const SpaceFileTreeRequest = "SpaceFileTreeRequest";
// Emitted when peer response to space file tree request.
export const SpaceFileTreeResponse = "SpaceFileTreeResponse";
// Emitted when peers wants to ask for file download.
export const SpaceFileContentRequest = "SpaceFileContentRequest";
// Emitter once individual peer wants to cancel their previous file content request.
export const SpaceFileContentCancel = "SpaceFileContentCancel";