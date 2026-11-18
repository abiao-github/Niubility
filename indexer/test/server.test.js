import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from '../server.js';

const store = {
  size: 0,
  stats: () => ({ total: 0 }),
  search: () => []
};

test('HTTP API requires a configured token', () => {
  assert.throws(
    () => createServer({ store, token: '' }),
    /INDEX_TOKEN 必须配置/
  );
});

test('HTTP API only accepts the bearer token header', async (t) => {
  const server = createServer({ store, token: 'test-token' });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/health`;
  const missing = await fetch(url);
  assert.equal(missing.status, 401);

  const queryToken = await fetch(`${url}?token=test-token`);
  assert.equal(queryToken.status, 401);

  const authorized = await fetch(url, {
    headers: { Authorization: 'Bearer test-token' }
  });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).ok, true);
});
