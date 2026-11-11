import path from 'node:path';

/**
 * Safely parse raw data as JSON.
 * Returns the parsed value if valid JSON, otherwise null.
 * The result is `unknown` because it usually comes from the network: validate before use.
 */
export function parseJSON(
  rawData: Buffer | string | null | undefined,
): unknown {
  if (!rawData) return null;

  let str;
  if (Buffer.isBuffer(rawData)) {
    str = rawData.toString();
  } else if (typeof rawData === 'string') {
    str = rawData;
  } else {
    return null;
  }

  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Extracts the host and port from a bootstrap address string.
 *
 * @param address - A string in the format "host:port"
 * @returns An object with `host` and `port` properties.
 * @throws If the host or port is missing.
 */
export function parseBootstrapAddress(address: string | null | undefined): {
  host: string;
  port: number;
} {
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
 * @param topic - Topic string like "space___pubkey___nonce"
 */
export function parseSpaceTopic(
  topic: string,
): { spaceName: string; publicKey: string; nonce: string } | null {
  if (!topic || typeof topic !== 'string') return null;

  const parts = topic.split('___');
  if (parts.length !== 3) return null;

  const [spaceName, publicKey, nonce] = parts;

  if (!spaceName || !publicKey || !nonce) return null;

  return { spaceName, publicKey, nonce };
}

/**
 * Parse filePath into directory and filename.
 * @param filePath - The file path.
 */
export function parseFilePath(filePath: string): {
  dir: string;
  filename: string;
} {
  const normalized = filePath.replace(/\\/g, '/');
  const parsed = path.parse(normalized);
  return { dir: parsed.dir || '', filename: parsed.base };
}
