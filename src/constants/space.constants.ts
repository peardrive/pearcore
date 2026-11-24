/**
 * Outcomes of a `SpaceSync` reconciliation.
 * Kept outside the protocol layer so managers can compare against them
 * without importing a handler class.
 */
export const SPACE_SYNC_STATES = {
  FIRST_ENCOUNTER: 'first_encounter',
  IDENTICAL: 'indentical',
  LOCAL_SPACE_REQUIRE_UPDATE: 'local_space_require_update',
  PEER_REQUIRE_UPDATE: 'peer_require_update',
} as const;

export type SpaceSyncAction =
  (typeof SPACE_SYNC_STATES)[keyof typeof SPACE_SYNC_STATES];
