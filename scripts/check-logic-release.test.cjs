const assert = require('node:assert/strict');
const { test } = require('node:test');

const { getReleasePlan } = require('./check-logic-release.cjs');

const metadata = { name: '@deepctrls/craftjs', version: '0.2.14' };

test('published versions are verified without a duplicate publish', async () => {
  const plan = await getReleasePlan(metadata, async (url) => {
    assert.equal(
      url,
      'https://registry.npmjs.org/%40deepctrls%2Fcraftjs/0.2.14'
    );
    return { status: 200 };
  });
  assert.equal(plan.publish, false);
});

test('only a missing version is eligible for publication', async () => {
  assert.equal(
    (await getReleasePlan(metadata, async () => ({ status: 404 }))).publish,
    true
  );
});

test('authentication and registry failures must never be mistaken for a new version', async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      getReleasePlan(metadata, async () => ({ status })),
      /Cannot determine/
    );
  }
  await assert.rejects(
    getReleasePlan(metadata, async () => {
      throw new Error('offline');
    }),
    /offline/
  );
});

test('upstream packages and unsupported version strings cannot be published', async () => {
  for (const invalid of [
    { ...metadata, name: '@craftjs/core' },
    { ...metadata, version: 'latest' },
    { ...metadata, version: '0.2.15-rc.1' },
  ]) {
    await assert.rejects(
      getReleasePlan(invalid, () => assert.fail('must not fetch')),
      /Expected/
    );
  }
});
