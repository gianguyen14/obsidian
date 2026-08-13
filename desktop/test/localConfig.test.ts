import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalAppUrl, isSafeExternalUrl, parseDesktopConfig } from '../src/localConfig';

test('accepts only local-first desktop configuration', () => {
  assert.deepEqual(parseDesktopConfig({ secret: '123456789012', vaultPath: '/notes' }), {
    secret: '123456789012', vaultPath: '/notes', dataDirName: 'server-data',
  });
  assert.equal(
    parseDesktopConfig({ secret: '123456789012', dataDirName: 'server-data-v3' })?.dataDirName,
    'server-data-v3',
  );
  assert.equal(parseDesktopConfig({ serverUrl: 'https://notes.example.com' }), null);
  assert.equal(parseDesktopConfig({ secret: 'short' }), null);
});

test('locks app navigation to its embedded loopback service', () => {
  assert.equal(isLocalAppUrl('http://127.0.0.1:43123/note/Test.md', 43123), true);
  assert.equal(isLocalAppUrl('http://localhost:43123/', 43123), false);
  assert.equal(isLocalAppUrl('https://notes.example.com/', 43123), false);
});

test('opens only credential-free HTTP(S) links externally', () => {
  assert.equal(isSafeExternalUrl('https://github.com/example/vault'), true);
  assert.equal(isSafeExternalUrl('https://token@github.com/example/vault'), false);
  assert.equal(isSafeExternalUrl('file:///etc/passwd'), false);
});
