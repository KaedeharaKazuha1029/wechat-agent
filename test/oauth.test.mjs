import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Store } from '../src/core.mjs';
import { DotOAuth } from '../src/oauth.mjs';

const origin = 'https://bridge.example.test';
const client = 'https://chatgpt.com/oauth/client.json';
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const setup = t => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.putTarget({ alias: 'dot', kind: 'dot' });
  store.putTarget({ alias: 'other-dot', kind: 'dot' });
  return { store, auth: new DotOAuth(store, origin) };
};
const proof = () => randomBytes(32).toString('base64url');
const authorize = (resource, verifier) => new URLSearchParams({ resource, client_id: client, redirect_uri: redirect,
  response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), state: 'opaque-client-state' });

test('OAuth pairing is one-use and a code requires the correct PKCE proof, redirect and resource', async t => {
  const { auth } = setup(t);
  const verify = proof();
  const resource = auth.resource('dot');
  const params = authorize(resource, verify);
  const bad = new URLSearchParams(params);
  bad.set('redirect_uri', 'https://bad.example.test/callback');
  assert.equal(await auth.startAuthorization(bad), null);
  const id = await auth.startAuthorization(params);
  assert.ok(id);
  assert.equal(auth.authorize(id, auth.issuePair('other-dot').code), null);
  const pair = auth.issuePair('dot').code;
  assert.equal(auth.authorize(id, 'FFFF0000FFFF0000'), null);
  const next = new URL(auth.authorize(id, pair));
  assert.equal(next.origin + next.pathname, redirect);
  assert.equal(next.searchParams.get('iss'), origin);
  assert.equal(next.searchParams.get('state'), 'opaque-client-state');
  assert.equal(auth.authorize(await auth.startAuthorization(params), pair), null);
  const token = new URLSearchParams({ grant_type: 'authorization_code', resource, client_id: client,
    redirect_uri: redirect, code: next.searchParams.get('code'), code_verifier: proof() });
  assert.equal(auth.token(token).error, 'invalid_grant');
  token.set('code_verifier', verify);
  token.set('resource', auth.resource('other-dot'));
  assert.equal(auth.token(token).error, 'invalid_grant');
  token.set('resource', resource);
  const issued = auth.token(token);
  assert.ok(issued.access_token);
  assert.equal(auth.token(token).error, 'invalid_grant');
  assert.equal(auth.authorized('dot', `Bearer ${issued.access_token}`), true);
  assert.equal(auth.authorized('other-dot', `Bearer ${issued.access_token}`), false);
  assert.equal(auth.authorized('dot', undefined), false);
  const refresh = new URLSearchParams({ grant_type: 'refresh_token', client_id: client, refresh_token: issued.refresh_token });
  const rotated = auth.token(refresh);
  assert.ok(rotated.access_token);
  assert.equal(auth.token(refresh).error, 'invalid_grant');
  assert.equal(auth.authorized('dot', `Bearer ${issued.access_token}`), false);
  auth.revoke('dot');
  assert.equal(auth.authorized('dot', `Bearer ${rotated.access_token}`), false);
});

test('expired pair and replaced pairing codes cannot authorize', async t => {
  const { store, auth } = setup(t);
  const request = await auth.startAuthorization(authorize(auth.resource('dot'), proof()));
  const original = auth.issuePair('dot').code;
  const replacement = auth.issuePair('dot').code;
  assert.equal(auth.authorize(request, original), null);
  store.run("UPDATE dot_oauth SET expires=0 WHERE kind='pair'");
  assert.equal(auth.authorize(request, replacement), null);
});
