import { describe, it, expect } from 'vitest';
import {
  parseJSON,
  parseBootstrapAddress,
  parseSpaceTopic,
} from '../../../src/utils/parsers.utils.js';
import { encodeShareLink } from '../../../src/utils/sharelink.utils.js';

describe('parseJSON', () => {
  it('should parse valid JSON string', () => {
    expect(parseJSON('{"key": "value"}')).toEqual({ key: 'value' });
  });

  it('should parse JSON Buffer', () => {
    const buffer = Buffer.from('{"num": 123}');
    expect(parseJSON(buffer)).toEqual({ num: 123 });
  });

  it('should return null for invalid JSON', () => {
    expect(parseJSON('invalid')).toBeNull();
  });

  it('should return null for non-string/Buffer input', () => {
    // @ts-expect-error -- runtime guard for untyped callers
    expect(parseJSON({})).toBeNull();
    // @ts-expect-error -- runtime guard for untyped callers
    expect(parseJSON(123)).toBeNull();
  });

  it('should return null for falsy input', () => {
    expect(parseJSON('')).toBeNull();
    expect(parseJSON(null)).toBeNull();
    expect(parseJSON(undefined)).toBeNull();
  });
});

describe('parseBootstrapAddress', () => {
  it('should parse host and port correctly', () => {
    expect(parseBootstrapAddress('example.com:8080')).toEqual({
      host: 'example.com',
      port: 8080,
    });
  });

  it('should throw if port is missing', () => {
    expect(() => {
      parseBootstrapAddress('example.com');
    }).toThrow();
  });

  it('should throw if address is empty', () => {
    expect(() => {
      parseBootstrapAddress(':9090');
    }).toThrow();
  });

  it('should parse numeric port as number', () => {
    expect(parseBootstrapAddress('host:1234').port).toBe(1234);
  });
});

describe('parseSpaceTopic', () => {
  it('should parse valid topic', () => {
    expect(parseSpaceTopic('space1___pk123___nonce456')).toEqual({
      spaceName: 'space1',
      publicKey: 'pk123',
      nonce: 'nonce456',
    });
  });

  it('should return null for invalid format', () => {
    expect(parseSpaceTopic('invalid')).toBeNull();
    expect(parseSpaceTopic('part1___part2')).toBeNull();
    expect(parseSpaceTopic('part1___part2___part3___part4')).toBeNull();
  });

  it('should return null for missing components', () => {
    expect(parseSpaceTopic('___pk___nonce')).toBeNull();
    expect(parseSpaceTopic('space______nonce')).toBeNull();
    expect(parseSpaceTopic('space___pk___')).toBeNull();
  });

  it('should return null for invalid input', () => {
    expect(parseSpaceTopic('')).toBeNull();
    // @ts-expect-error -- runtime guard for untyped callers
    expect(parseSpaceTopic(null)).toBeNull();
    // @ts-expect-error -- runtime guard for untyped callers
    expect(parseSpaceTopic(123)).toBeNull();
  });
});
