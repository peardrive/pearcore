import path from "node:path";

/**
 * Safely parse raw data as JSON.
 * Returns the parsed object if valid JSON, otherwise null.
 * @param {Buffer|string} rawData
 * @returns {any|null}
 */
export function parseJSON(rawData) {
    if (!rawData) return null

    let str
    if (Buffer.isBuffer(rawData)) {
        str = rawData.toString()
    } else if (typeof rawData === 'string') {
        str = rawData
    } else {
        return null
    }

    try {
        return JSON.parse(str)
    } catch {
        return null
    }
}

/**
 * Extracts the host and port from a bootstrap address string.
 *
 * @param address - A string in the format "host:port"
 * @returns An object with `host` and `port` properties, or null values if input is falsy.
 */
export function parseBootstrapAddress(address) {
  if (!address || address.trim() === '') {
    throw new Error('Missing port field in bootstrapper address');
  }
  
  const parts = address.split(':');
  if (parts.length < 2) {
    throw new Error('Missing port field in bootstrapper address');
  }
  
  const host = parts[0];
  const portStr = parts[1];
  
  if (!portStr || portStr.trim() === '') {
    throw new Error('Missing port field in bootstrapper address');
  }
  
  if (!host || host.trim() === '') {
    throw new Error('Missing host field in bootstrapper address');
  }

  return { host, port: parseInt(portStr, 10) };
}

/**
 * Parse a Hyperswarm topic name into its components
 * @param {string} topic - Topic string like "space___pubkey___nonce"
 * @returns {{ spaceName: string, publicKey: string, nonce: string }}
 */
export function parseSpaceTopic(topic) {
  if (!topic || typeof topic !== 'string') return null

  const parts = topic.split('___');
  if (parts.length !== 3) return null

  const [spaceName, publicKey, nonce] = parts;

  if (!spaceName || !publicKey || !nonce) return null;

  return { spaceName, publicKey, nonce};
}

/**
 * Parse filePath into directory and filename.
 * @param {string} filePath - The file path.
 * @returns {{dir: string, filename: string}}
 */
export function parseFilePath(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const parsed = path.parse(normalized);
    return { dir: parsed.dir || '', filename: parsed.base };
}