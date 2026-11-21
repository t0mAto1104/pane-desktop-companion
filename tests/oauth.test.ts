import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createChatGPT } from '../vendor/siwc/src/index';

test('DevKit loopback authorization, encrypted storage, rotation and account model discovery', { timeout: 15000 }, async context => {
  const dir = await mkdtemp(join(tmpdir(), 'pane-oauth-fixture-'));
  const key = randomBytes(32);
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'pane-fixture', alg: 'RS256' };
  const issuer = 'https://auth.openai.com';
  const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  const clientId = 'pane-fixture-client';
  const localFetch = globalThis.fetch;
  let nonce: string;
  let challenge: string;
  let rotations = 0;
  let modelRequests = 0;
  let revoked = 0;

  context.mock.method(globalThis, 'fetch', async (url: string | URL, options: RequestInit = {}) => {
    switch (String(url)) {
      case issuer + '/.well-known/openid-configuration':
        return Response.json({ issuer, authorization_endpoint: issuer + '/oauth/authorize',
          token_endpoint: issuer + '/oauth/token', jwks_uri: issuer + '/jwks', revocation_endpoint: issuer + '/oauth/revoke' });
      case issuer + '/jwks':
        return Response.json({ keys: [jwk] });
      case issuer + '/oauth/token': {
        const body = new URLSearchParams(String(options.body));
        assert.equal(body.get('client_id'), clientId);
        assert.equal(body.get('resource'), 'https://api.openai.com/v1');
        if (body.get('grant_type') === 'refresh_token') {
          assert.equal(body.get('refresh_token'), 'fixture-refresh-original');
          rotations++;
          return Response.json({ token_type:'Bearer', access_token:'fixture-access-rotated', refresh_token:'fixture-refresh-rotated', expires_in:3600 });
        }
        assert.equal(body.get('code'), 'pane-fixture-code');
        assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), challenge);
        const idToken = await new SignJWT({ nonce, email: 'fixture@example.invalid' })
          .setProtectedHeader({ alg:'RS256', kid:'pane-fixture' }).setIssuer(issuer).setAudience(clientId)
          .setSubject('fixture-subject').setIssuedAt().setExpirationTime('1h').sign(privateKey);
        return Response.json({ id_token:idToken, token_type:'Bearer', scope:scopes, access_token:'fixture-access-original', refresh_token:'fixture-refresh-original', expires_in:45 });
      }
      case issuer + '/oauth/revoke':
        assert.equal(new URLSearchParams(String(options.body)).get('token'), 'fixture-refresh-rotated');
        revoked++;
        return new Response(null, { status:200 });
      case 'https://api.openai.com/v1/models':
        assert.equal(new Headers(options.headers).get('authorization'), 'Bearer fixture-access-rotated');
        modelRequests++;
        return Response.json({ models: [
          { slug:'fixture-vision', display_name:'Fixture Vision', visibility:'list' },
          { slug:'fixture-hidden', display_name:'Fixture Hidden', visibility:'hidden' },
        ] });
      default: throw new Error('Unexpected remote request');
    }
  });

  const config = {
    appId:'pane-oauth-fixture', appName:'Pane OAuth fixture', sendHostId:true, redirectPort:0, storageDir:dir,
    credentialEncryption: {
      id:'aes-256-test', isAvailable:() => true,
      encrypt(text: string) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
      },
      decrypt(value: Uint8Array) {
        const buffer = Buffer.from(value);
        const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
        decipher.setAuthTag(buffer.subarray(-16));
        return Buffer.concat([decipher.update(buffer.subarray(12, -16)), decipher.final()]).toString();
      },
    },
    async openBrowser(value: string) {
      const auth = new URL(value);
      assert.equal(auth.origin, issuer);
      assert.equal(auth.searchParams.get('client_id'), 'dynamic_agent_client');
      assert.equal(auth.searchParams.get('scope'), scopes);
      assert.match(auth.searchParams.get('ext_agent_host_id')!, /^urn:uuid:/);
      assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
      nonce = auth.searchParams.get('nonce')!;
      challenge = auth.searchParams.get('code_challenge')!;
      const callback = new URL(auth.searchParams.get('redirect_uri')!);
      assert.equal(callback.hostname, '127.0.0.1');
      callback.searchParams.set('state', 'fixture-invalid-state');
      assert.equal((await localFetch(callback)).status, 400);
      callback.searchParams.set('state', auth.searchParams.get('state')!);
      callback.searchParams.set('code', 'pane-fixture-code');
      callback.searchParams.set('client_id', clientId);
      assert.equal((await localFetch(callback)).status, 200);
    },
  };
  const authFile = join(dir, 'chatgpt-auth.json');
  try {
    const connected = await createChatGPT(config).signIn();
    assert.equal(connected.status, 'connected', connected.error?.message);
    assert.equal(connected.sharing, true);
    assert.equal(connected.identity?.email, 'fixture@example.invalid');
    assert.ok(!JSON.stringify(connected).includes('fixture-access'));
    const reopened = createChatGPT(config);
    assert.equal((await reopened.getSession()).sharing, true);
    const expected = [{ slug:'fixture-vision', displayName:'Fixture Vision' }];
    assert.deepEqual(await reopened.listModels(), expected);
    assert.deepEqual(await reopened.listModels(), expected);
    assert.equal(rotations, 1);
    assert.equal(modelRequests, 2);
    const stored = await readFile(authFile, 'utf8');
    for (const secret of ['fixture-refresh-original', 'fixture-refresh-rotated', 'fixture-access-original', 'fixture-access-rotated']) {
      assert.ok(!stored.includes(secret));
    }
    await reopened.disconnect();
    assert.equal((await reopened.getSession()).status, 'disconnected');
    assert.equal(revoked, 1);
  } finally {
    await Promise.all([authFile, join(dir, 'chatgpt-host.json')].map(file => unlink(file).catch(() => undefined)));
    await rmdir(dir).catch(() => undefined);
  }
});
