/**
 * Tests unitaires pour CredentialsStore.
 * Vérifie en particulier les overrides qui empêchent la fuite des credentials
 * via toString, inspect, JSON.stringify, ou un console.log accidentel.
 * / Unit tests for CredentialsStore. Verifies leak-prevention overrides.
 *
 * LOCALISATION : tests/credentials.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as util from 'node:util';
import { CredentialsStore } from '../src/auth/credentials.js';

describe('CredentialsStore', () => {
  let store: CredentialsStore;

  beforeEach(() => {
    store = new CredentialsStore();
  });

  describe('lifecycle', () => {
    it('should start empty', () => {
      expect(store.has()).toBe(false);
    });

    it('should hold credentials after set', () => {
      store.set({ docs_sessionid: 'abc', csrftoken: 'xyz' });
      expect(store.has()).toBe(true);
      const got = store.get();
      expect(got?.docs_sessionid).toBe('abc');
      expect(got?.csrftoken).toBe('xyz');
    });

    it('should be empty after clear', () => {
      store.set({ docs_sessionid: 'abc', csrftoken: 'xyz' });
      store.clear();
      expect(store.has()).toBe(false);
      expect(store.get()).toBeNull();
    });

    it('should overwrite existing credentials on second set', () => {
      store.set({ docs_sessionid: 'a1', csrftoken: 'x1' });
      store.set({ docs_sessionid: 'a2', csrftoken: 'x2' });
      expect(store.get()?.docs_sessionid).toBe('a2');
      expect(store.get()?.csrftoken).toBe('x2');
    });
  });

  describe('leak prevention', () => {
    const sensitive = { docs_sessionid: 'SECRET_SESSION', csrftoken: 'SECRET_CSRF' };

    it('toString should not include credential values', () => {
      store.set(sensitive);
      const stringified = store.toString();
      expect(stringified).not.toContain('SECRET_SESSION');
      expect(stringified).not.toContain('SECRET_CSRF');
      expect(stringified).toBe('[CredentialsStore: set]');
    });

    it('toString should indicate empty state', () => {
      expect(store.toString()).toBe('[CredentialsStore: empty]');
    });

    it('util.inspect should not include credential values', () => {
      store.set(sensitive);
      const inspected = util.inspect(store);
      expect(inspected).not.toContain('SECRET_SESSION');
      expect(inspected).not.toContain('SECRET_CSRF');
    });

    it('JSON.stringify should not include credential values', () => {
      store.set(sensitive);
      const json = JSON.stringify(store);
      expect(json).not.toContain('SECRET_SESSION');
      expect(json).not.toContain('SECRET_CSRF');
    });

    it('console.log via template string should not leak', () => {
      store.set(sensitive);
      const formatted = `${store}`;
      expect(formatted).not.toContain('SECRET_SESSION');
      expect(formatted).not.toContain('SECRET_CSRF');
    });
  });
});
