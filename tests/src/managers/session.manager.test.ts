import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../../src/managers/session.manager.js';

describe('SessionManager', () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager();
  });

  describe('constructor', () => {
    it('should accept custom default session', () => {
      const customSession = {
        messaging: {
          rawLimitSize: 1024,
        },
      };
      const manager = new SessionManager(customSession);
      expect(manager.session.messaging.rawLimitSize).toBe(1024);
    });
  });

  describe('_getProperty', () => {
    it('should get nested property using dot notation', () => {
      sessionManager._setProperty('messaging.rawLimitSize', 2048);
      const result = sessionManager._getProperty('messaging.rawLimitSize');
      expect(result).toBe(2048);
    });

    it('should return undefined for non-existent path', () => {
      const result = sessionManager._getProperty('non.existent.path');
      expect(result).toBeUndefined();
    });
  });

  describe('_setProperty', () => {
    it('should set nested property using dot notation', () => {
      sessionManager._setProperty('messaging.rawLimitSize', 4096);
      expect(sessionManager.session.messaging.rawLimitSize).toBe(4096);
    });

    it('should create intermediate objects when needed', () => {
      sessionManager._setProperty('newSection.subSection.property', 'value');
      expect(sessionManager.get('newSection.subSection.property')).toBe(
        'value',
      );
    });
  });

  describe('_updateSection', () => {
    it('should update entire section with new values', () => {
      sessionManager._updateSection('messaging', {
        rawLimitSize: 8192,
        newSetting: 'newValue',
      });

      expect(sessionManager.session.messaging.rawLimitSize).toBe(8192);
      expect(sessionManager.session.messaging.newSetting).toBe('newValue');
    });

    it('should create section if it does not exist', () => {
      sessionManager._updateSection('newSection', { property: 'value' });
      expect(sessionManager.get('newSection.property')).toBe('value');
    });
  });

  describe('proxy interface methods', () => {
    it('should work through proxy get method', () => {
      sessionManager._setProperty('messaging.rawLimitSize', 1024);
      const result = sessionManager.session.get('messaging.rawLimitSize');
      expect(result).toBe(1024);
    });

    it('should work through proxy set method', () => {
      sessionManager.session.set('messaging.rawLimitSize', 2048);
      expect(sessionManager.session.messaging.rawLimitSize).toBe(2048);
    });

    it('should work through proxy update method', () => {
      sessionManager.session.update('messaging', { rawLimitSize: 4096 });
      expect(sessionManager.session.messaging.rawLimitSize).toBe(4096);
    });
  });
});
