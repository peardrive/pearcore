import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";
import { spaces } from "./space.schema.js";

/**
 * fileRegistry table definition.
 * 
 * Stores all registery informations about files 
 * that the device wants to share inside spaces.
 * 
 * Columns:
 * - id: Primary key. Unique integer indentifier for the file registery.
 * - fileSourcePath: The actual file source path to register and create indexes.
 * - timestamp: Unix timestamp indicating when the file registery was created.
 * - spaceId: Foreign key referencing `space.id`.
 * - spacePath: Artificial directory as replacement of real destination within space.
 * - spaceFilename: Artificial filename as replacement of real filename within space.
 * - rootHash: The root hash value generated from Merkele Tree indexing.
 * - metaHash: The hash of local file metadata information.
 * - leafCount: Total number of leaf nodes for complete Merkle Tree.
 * - height: The height of Merkle Tree indexing.
 * - detachedAt: Unix timestamp since which the bytes at `file_path` are not this registry's
 *   (the file there changed for another registry, or went missing). NULL = attached.
 *   A detached registry keeps its root hash and its tree, is neither announced nor served,
 *   and can be attached again to any file that holds its bytes (LocalFileRegistry.reconnect).
 */
export const fileRegistry = sqliteTable('file_registry', {
    id: integer("id").primaryKey(),

    fileSourcePath: text("file_path").notNull(),
    timestamp: integer("timestamp").notNull(),

    spaceId: integer("space_id").notNull()
        .references(() => spaces.id, { onDelete: "cascade" }),

    spacePath: text("space_path").notNull(),
    spaceFilename: text("space_filename").notNull(),

    rootHash: text("root_hash"),
    metaHash: text("meta_hash").notNull(),

    leafCount: integer("leaf_count").notNull(),
    height: integer("height").notNull(),

    detachedAt: integer("detached_at"),
});


/**
 * FileIndex table definition.
 * 
 * Represents merkle tree node information including the node hash, 
 * branch level and the related tree root.
 * 
 * Columns: 
 * - registryId: Primary Key. Unique Integer identifier for file index.
 * - rootHash: The root hash value generated from Merkele Tree indexing.
 * - level: The height level that node is currenctly placed. Level 0 is the root.
 * - hash: The node's hash value.
 * - parentHash: The higher branch hash value.
 * - leaftIndex: the index of the leaf in the level 0.
 * - nodeIndex: the index of the node within the level.
 */
export const fileIndex = sqliteTable("file_index", {
    registryId: integer("file_registry_id").notNull()
        .references(() => fileRegistry.id, { onDelete: "cascade" }),

    rootHash: text("root_hash").notNull(),
    level: integer("level").notNull(),
    hash: text("hash").notNull(),
    parentHash: text("parent_hash"),
    leftChildHash: text("left_child_hash"),
    rightChildHash: text("right_child_hash"),
    nodeIndex: integer("node_index").notNull(),
    leafIndex: integer("leaf_index"),
}, (table) => [
    // Create a composite publicKey from rootHash and node's hash
    primaryKey({ columns: [table.registryId, table.level, table.nodeIndex] }),
    index('level_index').on(table.level),
    index('nodeIndex_index').on(table.nodeIndex),
]);


/**
 * partialDownloadRecord table definition
 * .
 * Tracks the progress of a file that is being downloaded from the space.
 * This record exists for files that are not yet fully local.
 *
 * Columns:
 * - id: Primary key.
 * - registryId: Reference to the file_registry row.
 * - lastPushedLeaf: The index of the last leaf that was successfully written
 *   to the temporary file. Leaves are assumed to be received sequentially.
 * - finalDestination: The final path where the file should be moved once
 *   all leaves have been downloaded.
 */
export const downloadRecord = sqliteTable("partial_download_record", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    registryId: integer("registry_id")
        .notNull()
        .unique()
        .references(() => fileRegistry.id, { onDelete: "cascade" }),

    lastPushedLeaf: integer("last_pushed_leaf").notNull().default(-1),
    finalDestination: text("final_destination").notNull(),
});