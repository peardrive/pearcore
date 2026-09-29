import path from 'path';
import { fileURLToPath } from 'url';

// Path of this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root = go up from src/constants/database.constants.js
// adjust number of ".." depending on your structure
const projectRoot = path.resolve(__dirname, '../../');

// Bundled apps (Bare on mobile) have no migrations folder on disk: they write it out and point here.
export const DRIZZLE_MIGRATIONS_PATH = process.env.PEARCORE_MIGRATIONS_PATH || path.join(projectRoot, 'migrations');