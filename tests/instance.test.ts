/**
 * Tests unitaires pour InstanceStore et parseDocsUrl.
 * / Unit tests for InstanceStore and parseDocsUrl.
 *
 * LOCALISATION : tests/instance.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InstanceStore, parseDocsUrl } from '../src/auth/instance.js';

describe('parseDocsUrl', () => {
  it('should extract origin and uuid from a canonical doc URL', () => {
    const result = parseDocsUrl(
      'https://notes.liiib.re/docs/ccf11f43-a52e-48c6-bcb2-1858f8a42256/',
    );
    expect(result.origin).toBe('https://notes.liiib.re');
    expect(result.docId).toBe('ccf11f43-a52e-48c6-bcb2-1858f8a42256');
  });

  it('should accept a URL without trailing slash', () => {
    const result = parseDocsUrl(
      'https://notes.liiib.re/docs/ccf11f43-a52e-48c6-bcb2-1858f8a42256',
    );
    expect(result.docId).toBe('ccf11f43-a52e-48c6-bcb2-1858f8a42256');
  });

  it('should accept a URL with subpath after the uuid', () => {
    const result = parseDocsUrl(
      'https://notes.liiib.re/docs/ccf11f43-a52e-48c6-bcb2-1858f8a42256/edit',
    );
    expect(result.docId).toBe('ccf11f43-a52e-48c6-bcb2-1858f8a42256');
  });

  it('should throw on URL without /docs/<uuid>/ pattern', () => {
    expect(() => parseDocsUrl('https://notes.liiib.re/')).toThrow();
    expect(() => parseDocsUrl('https://notes.liiib.re/something/abc')).toThrow();
  });

  it('should throw on invalid UUID', () => {
    expect(() => parseDocsUrl('https://notes.liiib.re/docs/not-a-uuid/')).toThrow();
  });

  it('should throw on non-URL input', () => {
    expect(() => parseDocsUrl('not a url')).toThrow();
  });
});

describe('InstanceStore', () => {
  let store: InstanceStore;

  beforeEach(() => {
    store = new InstanceStore();
  });

  it('should start empty', () => {
    expect(store.has()).toBe(false);
    expect(store.get()).toBeNull();
  });

  it('should set and get an origin', () => {
    store.set('https://notes.liiib.re');
    expect(store.has()).toBe(true);
    expect(store.get()).toBe('https://notes.liiib.re');
  });

  it('should normalize origin (strip trailing slash and path)', () => {
    store.set('https://notes.liiib.re/');
    expect(store.get()).toBe('https://notes.liiib.re');
    store.set('https://notes.liiib.re/some/path');
    expect(store.get()).toBe('https://notes.liiib.re');
  });

  it('matches() should return true for matching origin', () => {
    store.set('https://notes.liiib.re');
    expect(store.matches('https://notes.liiib.re/api/v1.0/documents/')).toBe(true);
    expect(store.matches('https://notes.liiib.re/docs/abc/')).toBe(true);
  });

  it('matches() should return false for different origin', () => {
    store.set('https://notes.liiib.re');
    expect(store.matches('https://other.example.com/api/')).toBe(false);
  });

  it('matches() should return false when empty', () => {
    expect(store.matches('https://anywhere/')).toBe(false);
  });

  it('clear() should reset to empty', () => {
    store.set('https://notes.liiib.re');
    store.clear();
    expect(store.has()).toBe(false);
  });

  it('should accept env-based init via fromEnv()', () => {
    const env = InstanceStore.fromEnv({ DOCS_INSTANCE_URL: 'https://notes.liiib.re' });
    expect(env.has()).toBe(true);
    expect(env.get()).toBe('https://notes.liiib.re');
  });

  it('fromEnv() with missing env var should produce empty store', () => {
    const env = InstanceStore.fromEnv({});
    expect(env.has()).toBe(false);
  });
});
