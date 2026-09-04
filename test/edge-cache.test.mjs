import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Edge cache policy for the PropSpace proxy.
 *
 * The dangerous mistake with a cache in front of scoped data is caching the
 * ANSWER rather than the upstream response. These pin the policy half; the
 * safety half is structural and documented at cacheTtl: the key is built from
 * the already-scoped upstream URL, and filterPayload still runs on every
 * request, hit or miss.
 */
const here = dirname(fileURLToPath(import.meta.url));
const { cacheTtl } = await import(join(here, '..', 'functions', 'ps', '[[path]].js'));

test('the taxonomies outlive the data', () => {
  assert.equal(cacheTtl('/options/sub_statuses'), 3600, 'edited about never');
  assert.equal(cacheTtl('/listings?status=published'), 600, 'a few times a day');
  assert.equal(cacheTtl('/leads?assigned_to=1505600&page=2'), 120, 'acted on, so kept short');
});

test('anything not named is not cached', () => {
  // Defaulting to "cache it" would silently start caching whatever endpoint
  // someone routes through here next, including one that should not be.
  assert.equal(cacheTtl('/contacts'), 0);
  assert.equal(cacheTtl('/'), 0);
  assert.equal(cacheTtl('/something-new'), 0);
});

test('a lead TTL short enough to act on', () => {
  // A broker working a never-contacted queue must not be handed a lead
  // somebody else picked up ten minutes ago.
  assert.ok(cacheTtl('/leads') <= 180, 'leads go stale fast enough to matter');
  assert.ok(cacheTtl('/leads') > 0, 'but the multi-page pull is the whole point');
});
