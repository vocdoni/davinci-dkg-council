import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { afterEach } from 'vitest';

// RTL auto-cleanup needs vitest globals; we don't enable them, so do it here.
afterEach(() => cleanup());

// jsdom's Blob/File lack .text(); every real browser has it.
if (typeof Blob !== 'undefined' && typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function (this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error ?? new Error('read failed'));
      r.readAsText(this);
    });
  };
}

// jsdom ships getRandomValues but not SubtleCrypto; the vault and the SDK
// need the real WebCrypto implementation.
if (globalThis.crypto?.subtle === undefined) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
