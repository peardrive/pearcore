import { validateHexString } from './general.utils.js';
import type { spaces } from '../database/schemas/space.schema.js';

type SpaceRow = typeof spaces.$inferSelect;

/**
 * The space fields permission checks depend on: the row plus its whitelists of public keys.
 * Permission flags are 0/1 in the database and booleans in protocol payloads, so both are accepted.
 */
export type SpacePolicy = Pick<SpaceRow, 'publicKey' | 'secret'> & {
  permissionRead: boolean | number;
  permissionBroadcast: boolean | number;
  readWhitelist: string[];
  broadcastWhitelist: string[];
};

/**
 * Checks if the space has requirements for message encryption.
 * @param space - The space object
 * @returns True if the space object meets the criteria.
 */
export function spaceShouldEncryptMessages(
  space: Pick<SpacePolicy, 'permissionRead' | 'readWhitelist' | 'secret'>,
): boolean {
  return (
    !space.permissionRead &&
    space.readWhitelist.length > 0 &&
    typeof space.secret === 'string' &&
    validateHexString(space.secret)
  );
}

/**
 * Checks if a publicKey is allowed to read from a space
 * @param publicKey - The publicKey to check permission
 * @param space - The space object containing permission settings
 * @returns True if the publicKey is allowed to read, false otherwise
 */
export function publicKeyIsAllowedToRead(
  publicKey: string,
  space: Pick<SpacePolicy, 'publicKey' | 'permissionRead' | 'readWhitelist'>,
): boolean {
  if (space.publicKey === publicKey) return true;
  if (space.permissionRead) return true;
  if (space.readWhitelist.includes(publicKey)) return true;

  return false;
}

/**
 * Checks if a publicKey is allowed to broadcast into a space
 * @param publicKey - The publicKey to check permission
 * @param space - The space object containing permission settings
 * @returns True if the publicKey is allowed to broadcast message, false otherwise
 */
export function publicKeyIsAllowedToBroadcast(
  publicKey: string,
  space: Pick<
    SpacePolicy,
    'publicKey' | 'permissionBroadcast' | 'broadcastWhitelist'
  >,
): boolean {
  if (space.publicKey === publicKey) return true;
  if (space.permissionBroadcast) return true;
  if (space.broadcastWhitelist.includes(publicKey)) return true;

  return false;
}
