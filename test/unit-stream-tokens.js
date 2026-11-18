'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { StreamServer } = require('../src/stream-server');

test('stream tokens are random hex and expire', () => {
  const server = new StreamServer({ getTask: () => null });
  const token = server.register('task-id', 0);

  assert.match(token, /^[a-f0-9]{48}$/);
  assert.equal(server.tokens.has(token), true);

  server.tokens.get(token).createdAt = 0;
  assert.equal(server.resolveTarget(token), null);
  assert.equal(server.tokens.has(token), false);
});
