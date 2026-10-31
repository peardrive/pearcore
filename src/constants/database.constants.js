import path from 'path';
import { fileURLToPath } from 'url';

// Path of this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '../../');

export const DRIZZLE_MIGRATIONS_PATH = path.join(projectRoot, 'migrations');