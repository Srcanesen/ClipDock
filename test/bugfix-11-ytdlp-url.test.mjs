import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSocialUrl } from '../dist/ytdlp-url.js';

test('validateSocialUrl rejects . and .. segments', () => {
  const bad = [
    'https://www.instagram.com/./abc123',
    'https://www.instagram.com/../abc123',
    'https://www.instagram.com/p/../abc',
    'https://www.instagram.com/p/./',
    'https://x.com/user/./status/123',
    'https://x.com/../status/123',
    'https://www.facebook.com/../watch?v=123456',
    'https://www.facebook.com/./reel/123456',
    'https://www.facebook.com/username/../videos/123456',
    'https://www.facebook.com/videos/../123456',
    'https://fb.watch/../abc',
    'https://fb.watch/./abc',
    'https://www.instagram.com/p/abc/..',
    'https://www.instagram.com/p/abc/.',
  ];
  for (const url of bad) {
    assert.equal(validateSocialUrl(url), null, `${url} must be rejected`);
  }
  // Valid ones still pass
  assert.ok(validateSocialUrl('https://www.instagram.com/p/abc123'));
  assert.ok(validateSocialUrl('https://x.com/user/status/123456'));
  assert.ok(validateSocialUrl('https://www.facebook.com/watch?v=123456'));
});

test('validateSocialUrl rejects segments equal to . or .. exactly', () => {
  assert.equal(validateSocialUrl('https://www.instagram.com/p/./'), null);
  assert.equal(validateSocialUrl('https://www.instagram.com/p/../'), null);
  assert.equal(validateSocialUrl('https://www.instagram.com/reel/./'), null);
});
