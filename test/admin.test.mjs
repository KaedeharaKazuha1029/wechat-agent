import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core.mjs';
import { PublicAdmin } from '../src/public-admin.mjs';

test('public admin password is hashed, authentication expires, and password changes revoke sessions', async t => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  const admin = new PublicAdmin(store, 'https://bridge.example.test');
  const first = 'fixture-admin-password-one';
  const second = 'fixture-admin-password-two';
  assert.equal(await admin.login(first), null);
  await admin.setPassword(first);
  assert.ok(!JSON.stringify(store.get('public-admin-password')).includes(first));
  assert.equal(await admin.login('wrong-admin-password'), null);
  const token=await admin.login(first);
  const request = { headers: { cookie: `__Secure-weixin-admin=${token}` } };
  assert.ok(admin.session(request));
  assert.equal(admin.session({ headers: { authorization: `Bearer ${token}` } }), null);
  await admin.setPassword(second);
  assert.equal(admin.session(request), null);
  const replacement = await admin.login(second);
  assert.ok(replacement);
  store.run('UPDATE admin_sessions SET expires=0');
  assert.equal(admin.session({ headers: { cookie: `__Secure-weixin-admin=${replacement}` } }), null);
});

test('disabled Codex Cloud is hidden and cannot be selected, while stored cloud history remains', t => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.putTarget({ alias: 'cloud',kind: 'codex-cloud' });
  store.putTarget({ alias: 'dot',kind: 'dot' });
  store.openCloud('bot','owner','cloud','archive');
  store.cloudEnabled = false;
  assert.equal(store.route('bot','owner'), 'dot');
  assert.equal(store.target('cloud'), undefined);
  assert.deepEqual(store.targets().map(target => target.alias), ['dot']);
  assert.throws(() => store.select('bot','owner','cloud'), /没有/);
  assert.throws(() => store.putTarget({ alias: 'new-cloud',kind: 'codex-cloud' }), /停用/);
  store.handleMessage('bot','owner','/cloud c1', () => null);
  assert.match(store.one('SELECT body FROM outbox WHERE account=?','bot').body, /已停用/);
  assert.equal(store.one('SELECT title FROM cloud_chats WHERE code=?','c1').title, 'archive');
});
