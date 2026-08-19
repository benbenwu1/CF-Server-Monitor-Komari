import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import { initDatabase } from '../src/database/schema.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { handleGithubOAuthCallback } from '../src/handlers/githubOAuth.js';
import { cleanupGithubOAuthStartLimits } from '../src/services/githubOAuth.js';
import { generateTotpCode } from '../src/services/totp.js';
import worker from '../src/index.js';

const RETURN_URL = 'https://monitor.example/admin#admin';

function adminRequest(body, token = '', ipAddress = '203.0.113.120') {
  return new Request('https://monitor.example/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ipAddress,
      'User-Agent': 'GitHub OAuth integration test',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

test('GitHub OAuth start masks internal storage failure details', async () => {
  const sensitiveFailure = 'SENSITIVE_D1_OAUTH_STORAGE_DETAIL';
  const db = {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (String(sql).includes('INSERT INTO admin_oauth_start_limits')) {
            return {
              attempt_count: 1,
              expires_at: Date.now() + 300_000
            };
          }
          return null;
        },
        async run() {
          return { meta: { changes: 1 } };
        }
      };
    },
    async batch() {
      throw new Error(sensitiveFailure);
    }
  };
  const response = await handleAdminAPI(
    adminRequest({ action: 'github_oauth_start', return_url: RETURN_URL }),
    {
      DB: db,
      GITHUB_OAUTH_CLIENT_ID: 'test-client-id',
      GITHUB_OAUTH_CLIENT_SECRET: 'test-client-secret',
      GITHUB_OAUTH_CALLBACK_URL: 'https://oauth-worker.example/admin/oauth/github/callback',
      CORS_ALLOWED_ORIGINS: 'https://monitor.example'
    },
    { jwt_secret: 'test-jwt-secret' }
  );

  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.code, 'github_oauth_start_failed');
  assert.equal(JSON.stringify(body).includes(sensitiveFailure), false);
});

test('GitHub OAuth uses an exact configured callback and persists only hashed state', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'admin-github-oauth-start-test' }
  });
  const env = {
    DB: await miniflare.getD1Database('DB'),
    API_USER_NAME: 'oauth-admin',
    API_SECRET: 'oauth-password',
    TOTP_ENCRYPTION_KEY: 'test-oauth-totp-encryption-key-at-least-32-chars',
    GITHUB_OAUTH_CLIENT_ID: 'test-github-client-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'test-github-client-secret',
    CORS_ALLOWED_ORIGINS: 'https://monitor.example'
  };
  const sys = {
    username: 'oauth-admin',
    jwt_secret: 'oauth-jwt-secret-with-at-least-32-characters'
  };
  const originalFetch = globalThis.fetch;

  try {
    await initDatabase(env.DB);

    const unavailable = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_start', return_url: RETURN_URL }),
      env,
      sys
    );
    assert.equal(unavailable.status, 400);
    assert.equal(unavailable.headers.get('Cache-Control'), 'no-store');
    assert.equal((await unavailable.json()).error, 'github_oauth_unavailable');

    env.GITHUB_OAUTH_CALLBACK_URL = 'https://oauth-worker.example/admin/oauth/github/callback';
    const configResponse = await worker.fetch(
      new Request('https://oauth-worker.example/api/config'),
      env,
      { waitUntil() {} }
    );
    assert.equal(configResponse.status, 200);
    const configBody = await configResponse.json();
    assert.equal(configBody.github_oauth_available, true);
    assert.equal(JSON.stringify(configBody).includes(env.GITHUB_OAUTH_CLIENT_SECRET), false);

    const routedCallback = await worker.fetch(
      new Request(env.GITHUB_OAUTH_CALLBACK_URL),
      env,
      { waitUntil() {} }
    );
    assert.equal(routedCallback.status, 400);
    assert.equal((await routedCallback.json()).error, 'github_oauth_state_invalid');

    const started = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_start', return_url: RETURN_URL }),
      env,
      sys
    );
    assert.equal(started.status, 200);
    assert.equal(started.headers.get('Cache-Control'), 'no-store');

    const body = await started.json();
    const authorizeUrl = new URL(body.authorize_url);
    assert.equal(authorizeUrl.origin, 'https://github.com');
    assert.equal(authorizeUrl.pathname, '/login/oauth/authorize');
    assert.equal(authorizeUrl.searchParams.get('client_id'), env.GITHUB_OAUTH_CLIENT_ID);
    assert.equal(
      authorizeUrl.searchParams.get('redirect_uri'),
      env.GITHUB_OAUTH_CALLBACK_URL
    );
    assert.match(authorizeUrl.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
    assert.match(authorizeUrl.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorizeUrl.searchParams.has('client_secret'), false);

    const stateRows = await env.DB.prepare('SELECT * FROM admin_oauth_states').all();
    assert.equal(stateRows.results.length, 1);
    const serializedState = JSON.stringify(stateRows.results);
    assert.equal(serializedState.includes(authorizeUrl.searchParams.get('state')), false);
    assert.equal(serializedState.includes(env.GITHUB_OAUTH_CLIENT_SECRET), false);

    const oauthAccessToken = 'test-github-access-token-never-persist';
    const oauthRequests = [];
    let tokenScope = '';
    let githubUserId = 123456789;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      oauthRequests.push({ url, init });
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({
          access_token: oauthAccessToken,
          token_type: 'bearer',
          scope: tokenScope
        });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({ id: githubUserId, login: 'bound-admin' });
      }
      throw new Error(`Unexpected OAuth request: ${url}`);
    };

    const callbackUrl = new URL(env.GITHUB_OAUTH_CALLBACK_URL);
    callbackUrl.searchParams.set('code', 'temporary-github-code');
    callbackUrl.searchParams.set('state', authorizeUrl.searchParams.get('state'));

    const wrongHostCallbackUrl = new URL(callbackUrl);
    wrongHostCallbackUrl.host = 'monitor.example';
    const wrongHostCallback = await handleGithubOAuthCallback(
      new Request(wrongHostCallbackUrl),
      env
    );
    assert.equal(wrongHostCallback.status, 400);
    assert.equal((await wrongHostCallback.json()).error, 'github_oauth_callback_mismatch');
    assert.equal(oauthRequests.length, 0);

    const callbackResponse = await handleGithubOAuthCallback(
      new Request(callbackUrl, {
        headers: {
          'CF-Connecting-IP': '203.0.113.120',
          'User-Agent': 'GitHub OAuth integration test'
        }
      }),
      env
    );
    assert.equal(callbackResponse.status, 302);
    assert.equal(callbackResponse.headers.get('Cache-Control'), 'no-store');
    const callbackLocation = callbackResponse.headers.get('Location');
    assert.match(callbackLocation, /^https:\/\/monitor\.example\/admin#admin\?/);
    assert.match(callbackLocation, /oauth_error=github_oauth_not_bound/);
    assert.equal(callbackLocation.includes('oauth_code='), false);
    assert.equal(callbackLocation.includes(oauthAccessToken), false);

    assert.equal(oauthRequests.length, 2);
    const tokenRequest = oauthRequests[0];
    assert.equal(tokenRequest.init.redirect, 'manual');
    assert.equal(tokenRequest.init.cache, 'no-store');
    assert.ok(tokenRequest.init.signal instanceof AbortSignal);
    assert.match(String(tokenRequest.init.body), /code_verifier=/);
    assert.match(String(tokenRequest.init.body), /redirect_uri=/);
    const userRequest = oauthRequests[1];
    assert.equal(userRequest.init.redirect, 'manual');
    assert.equal(userRequest.init.cache, 'no-store');
    assert.ok(userRequest.init.signal instanceof AbortSignal);
    assert.equal(userRequest.init.headers.Authorization, `Bearer ${oauthAccessToken}`);
    assert.equal(userRequest.init.headers['X-GitHub-Api-Version'], '2026-03-10');

    const persistedAfterCallback = await env.DB.prepare(`
      SELECT state_hash, purpose, return_url, callback_url, consumed_at
      FROM admin_oauth_states
    `).all();
    assert.equal(persistedAfterCallback.results.length, 1);
    assert.ok(Number(persistedAfterCallback.results[0].consumed_at) > 0);
    assert.equal(JSON.stringify(persistedAfterCallback.results).includes(oauthAccessToken), false);

    const requestCountBeforeReplay = oauthRequests.length;
    const replayedCallback = await handleGithubOAuthCallback(new Request(callbackUrl), env);
    assert.equal(replayedCallback.status, 400);
    assert.equal(oauthRequests.length, requestCountBeforeReplay);

    const expandedScopeStart = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_start', return_url: RETURN_URL }),
      env,
      sys
    );
    const expandedScopeAuthorizeUrl = new URL((await expandedScopeStart.json()).authorize_url);
    const expandedScopeCallbackUrl = new URL(env.GITHUB_OAUTH_CALLBACK_URL);
    expandedScopeCallbackUrl.searchParams.set('code', 'expanded-scope-code');
    expandedScopeCallbackUrl.searchParams.set(
      'state',
      expandedScopeAuthorizeUrl.searchParams.get('state')
    );
    tokenScope = 'repo';
    const requestsBeforeExpandedScope = oauthRequests.length;
    const expandedScopeCallback = await handleGithubOAuthCallback(
      new Request(expandedScopeCallbackUrl),
      env
    );
    assert.equal(expandedScopeCallback.status, 302);
    assert.match(
      expandedScopeCallback.headers.get('Location'),
      /oauth_error=github_oauth_callback_failed/
    );
    assert.equal(oauthRequests.length, requestsBeforeExpandedScope + 1);
    tokenScope = '';

    const stringIdStart = await handleAdminAPI(
      adminRequest(
        { action: 'github_oauth_start', return_url: RETURN_URL },
        '',
        '203.0.113.124'
      ),
      env,
      sys
    );
    const stringIdAuthorizeUrl = new URL((await stringIdStart.json()).authorize_url);
    const stringIdCallbackUrl = new URL(env.GITHUB_OAUTH_CALLBACK_URL);
    stringIdCallbackUrl.searchParams.set('code', 'string-id-code');
    stringIdCallbackUrl.searchParams.set('state', stringIdAuthorizeUrl.searchParams.get('state'));
    githubUserId = '123456789';
    const stringIdCallback = await handleGithubOAuthCallback(
      new Request(stringIdCallbackUrl),
      env
    );
    assert.equal(stringIdCallback.status, 302);
    assert.match(
      stringIdCallback.headers.get('Location'),
      /oauth_error=github_oauth_callback_failed/
    );
    assert.equal(Number((await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM admin_oauth_identities
    `).first()).count), 0);
    assert.equal(Number((await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM admin_oauth_exchange_codes
    `).first()).count), 0);
    githubUserId = 123456789;

    const unauthorizedBind = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_bind_start', return_url: RETURN_URL }),
      env,
      sys
    );
    assert.equal(unauthorizedBind.status, 401);

    const passwordLogin = await handleAdminAPI(
      adminRequest({
        action: 'login',
        username: env.API_USER_NAME,
        password: env.API_SECRET
      }),
      env,
      sys
    );
    assert.equal(passwordLogin.status, 200);
    let adminToken = (await passwordLogin.json()).token;

    const revokedBindStart = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_bind_start', return_url: RETURN_URL }, adminToken),
      env,
      sys
    );
    const revokedBindAuthorizeUrl = new URL((await revokedBindStart.json()).authorize_url);
    const logoutBeforeCallback = await handleAdminAPI(
      adminRequest({ action: 'session_logout' }, adminToken),
      env,
      sys
    );
    assert.equal(logoutBeforeCallback.status, 200);
    const revokedBindCallbackUrl = new URL(env.GITHUB_OAUTH_CALLBACK_URL);
    revokedBindCallbackUrl.searchParams.set('code', 'revoked-session-bind-code');
    revokedBindCallbackUrl.searchParams.set(
      'state',
      revokedBindAuthorizeUrl.searchParams.get('state')
    );
    const requestsBeforeRevokedBind = oauthRequests.length;
    const revokedBindCallback = await handleGithubOAuthCallback(
      new Request(revokedBindCallbackUrl),
      env
    );
    assert.equal(revokedBindCallback.status, 302);
    assert.match(
      revokedBindCallback.headers.get('Location'),
      /oauth_error=github_oauth_session_expired/
    );
    assert.equal(oauthRequests.length, requestsBeforeRevokedBind);

    const replacementPasswordLogin = await handleAdminAPI(
      adminRequest({
        action: 'login',
        username: env.API_USER_NAME,
        password: env.API_SECRET
      }),
      env,
      sys
    );
    adminToken = (await replacementPasswordLogin.json()).token;

    const bindStart = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_bind_start', return_url: RETURN_URL }, adminToken),
      env,
      sys
    );
    assert.equal(bindStart.status, 200);
    assert.equal(bindStart.headers.get('Cache-Control'), 'no-store');
    const bindAuthorizeUrl = new URL((await bindStart.json()).authorize_url);
    const bindCallbackUrl = new URL(env.GITHUB_OAUTH_CALLBACK_URL);
    bindCallbackUrl.searchParams.set('code', 'temporary-github-bind-code');
    bindCallbackUrl.searchParams.set('state', bindAuthorizeUrl.searchParams.get('state'));

    const bindCallback = await handleGithubOAuthCallback(new Request(bindCallbackUrl), env);
    assert.equal(bindCallback.status, 302);
    assert.match(bindCallback.headers.get('Location'), /oauth_bound=1/);

    const settingsResponse = await handleAdminAPI(
      adminRequest({ action: 'get_settings' }, adminToken),
      env,
      sys
    );
    assert.equal(settingsResponse.status, 200);
    const settingsBody = await settingsResponse.json();
    assert.equal(settingsBody.settings.github_oauth_bound, true);
    assert.equal(settingsBody.settings.github_login, 'bound-admin');
    const serializedSettings = JSON.stringify(settingsBody);
    assert.equal(serializedSettings.includes('123456789'), false);
    assert.equal(serializedSettings.includes(env.GITHUB_OAUTH_CLIENT_SECRET), false);
    assert.equal(serializedSettings.includes(oauthAccessToken), false);

    const oauthLoginStart = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_start', return_url: RETURN_URL }),
      env,
      sys
    );
    assert.equal(oauthLoginStart.status, 200);
    const oauthLoginAuthorizeUrl = new URL((await oauthLoginStart.json()).authorize_url);
    const oauthLoginCallbackUrl = new URL(env.GITHUB_OAUTH_CALLBACK_URL);
    oauthLoginCallbackUrl.searchParams.set('code', 'temporary-github-login-code');
    oauthLoginCallbackUrl.searchParams.set(
      'state',
      oauthLoginAuthorizeUrl.searchParams.get('state')
    );
    const oauthLoginCallback = await handleGithubOAuthCallback(
      new Request(oauthLoginCallbackUrl),
      env
    );
    assert.equal(oauthLoginCallback.status, 302);
    const oauthLoginLocation = new URL(oauthLoginCallback.headers.get('Location'));
    const oauthLoginFragment = new URLSearchParams(
      oauthLoginLocation.hash.slice(oauthLoginLocation.hash.indexOf('?') + 1)
    );
    const oauthCode = oauthLoginFragment.get('oauth_code');
    assert.match(oauthCode, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(oauthLoginFragment.get('oauth_api'), 'https://oauth-worker.example');
    assert.equal(oauthLoginLocation.toString().includes(oauthAccessToken), false);
    assert.equal(oauthLoginLocation.toString().includes(env.GITHUB_OAUTH_CLIENT_SECRET), false);

    const exchangeResponses = await Promise.all([
      handleAdminAPI(
        adminRequest({ action: 'github_oauth_exchange', oauth_code: oauthCode }),
        env,
        sys
      ),
      handleAdminAPI(
        adminRequest({ action: 'github_oauth_exchange', oauth_code: oauthCode }),
        env,
        sys
      )
    ]);
    assert.deepEqual(exchangeResponses.map(response => response.status).sort(), [200, 400]);
    assert.equal(
      exchangeResponses.find(response => response.status === 400).headers.get('Cache-Control'),
      'no-store'
    );
    const exchangeResponse = exchangeResponses.find(response => response.status === 200);
    assert.equal(exchangeResponse.status, 200);
    assert.equal(exchangeResponse.headers.get('Cache-Control'), 'no-store');
    const exchangeBody = await exchangeResponse.json();
    assert.equal(typeof exchangeBody.token, 'string');

    const oauthSessionList = await handleAdminAPI(
      adminRequest({ action: 'session_list' }, exchangeBody.token),
      env,
      sys
    );
    assert.equal(oauthSessionList.status, 200);
    const oauthSessions = (await oauthSessionList.json()).sessions;
    assert.equal(oauthSessions.find(session => session.current)?.auth_method, 'github_oauth');
    assert.equal(
      oauthSessions.filter(session => session.auth_method.startsWith('github_oauth')).length,
      1
    );

    const replayedExchange = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_exchange', oauth_code: oauthCode }),
      env,
      sys
    );
    assert.equal(replayedExchange.status, 400);
    assert.equal(replayedExchange.headers.get('Cache-Control'), 'no-store');
    assert.equal((await replayedExchange.json()).error, 'github_oauth_exchange_invalid');

    const invalidExchangeCode = `SENSITIVE-${'X'.repeat(33)}`;
    assert.equal(invalidExchangeCode.length, 43);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const invalidExchange = await handleAdminAPI(
        adminRequest(
          { action: 'github_oauth_exchange', oauth_code: invalidExchangeCode },
          '',
          '203.0.113.125'
        ),
        env,
        sys
      );
      assert.equal(invalidExchange.status, 400);
      assert.equal(invalidExchange.headers.get('Cache-Control'), 'no-store');
    }

    const exchangeRows = await env.DB.prepare('SELECT * FROM admin_oauth_exchange_codes').all();
    const serializedExchanges = JSON.stringify(exchangeRows.results || []);
    assert.equal(serializedExchanges.includes(oauthCode), false);
    assert.equal(serializedExchanges.includes(exchangeBody.token), false);
    assert.equal(serializedExchanges.includes(oauthAccessToken), false);

    const totpSetupResponse = await handleAdminAPI(
      adminRequest({ action: 'totp_setup' }, adminToken),
      env,
      sys
    );
    assert.equal(totpSetupResponse.status, 200);
    const totpSetup = await totpSetupResponse.json();
    const totpConfirmResponse = await handleAdminAPI(
      adminRequest({
        action: 'totp_confirm',
        code: await generateTotpCode(totpSetup.secret)
      }, adminToken),
      env,
      sys
    );
    assert.equal(totpConfirmResponse.status, 200);
    const recoveryCodes = (await totpConfirmResponse.json()).recovery_codes;

    const bindWithoutSecondFactor = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_bind_start', return_url: RETURN_URL }, adminToken),
      env,
      sys
    );
    assert.equal(bindWithoutSecondFactor.status, 428);
    assert.equal((await bindWithoutSecondFactor.json()).code, 'totp_required');

    const totpOauthStart = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_start', return_url: RETURN_URL }),
      env,
      sys
    );
    const totpAuthorizeUrl = new URL((await totpOauthStart.json()).authorize_url);
    const totpCallbackUrl = new URL(env.GITHUB_OAUTH_CALLBACK_URL);
    totpCallbackUrl.searchParams.set('code', 'temporary-github-totp-login-code');
    totpCallbackUrl.searchParams.set('state', totpAuthorizeUrl.searchParams.get('state'));
    const totpCallback = await handleGithubOAuthCallback(new Request(totpCallbackUrl), env);
    const totpCallbackLocation = new URL(totpCallback.headers.get('Location'));
    const totpFragment = new URLSearchParams(
      totpCallbackLocation.hash.slice(totpCallbackLocation.hash.indexOf('?') + 1)
    );
    const totpOauthCode = totpFragment.get('oauth_code');

    const missingTotpExchange = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_exchange', oauth_code: totpOauthCode }),
      env,
      sys
    );
    assert.equal(missingTotpExchange.status, 401);
    assert.equal((await missingTotpExchange.json()).code, 'totp_required');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const invalidTotpExchange = await handleAdminAPI(
        adminRequest({
          action: 'github_oauth_exchange',
          oauth_code: totpOauthCode,
          recovery_code: `INVALID-OAUTH-RECOVERY-${attempt}`
        }, '', '203.0.113.121'),
        env,
        sys
      );
      assert.equal(invalidTotpExchange.status, 401);
    }
    const limitedTotpExchange = await handleAdminAPI(
      adminRequest({
        action: 'github_oauth_exchange',
        oauth_code: totpOauthCode,
        totp_code: await generateTotpCode(totpSetup.secret)
      }, '', '203.0.113.121'),
      env,
      sys
    );
    assert.equal(limitedTotpExchange.status, 429);

    const verifiedTotpExchange = await handleAdminAPI(
      adminRequest({
        action: 'github_oauth_exchange',
        oauth_code: totpOauthCode,
        totp_code: await generateTotpCode(totpSetup.secret)
      }),
      env,
      sys
    );
    assert.equal(verifiedTotpExchange.status, 200);
    const verifiedTotpToken = (await verifiedTotpExchange.json()).token;
    const totpSessionList = await handleAdminAPI(
      adminRequest({ action: 'session_list' }, verifiedTotpToken),
      env,
      sys
    );
    assert.equal(
      (await totpSessionList.json()).sessions.find(session => session.current)?.auth_method,
      'github_oauth_totp'
    );

    const recoveryOauthStart = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_start', return_url: RETURN_URL }),
      env,
      sys
    );
    const recoveryAuthorizeUrl = new URL((await recoveryOauthStart.json()).authorize_url);
    const recoveryCallbackUrl = new URL(env.GITHUB_OAUTH_CALLBACK_URL);
    recoveryCallbackUrl.searchParams.set('code', 'temporary-github-recovery-login-code');
    recoveryCallbackUrl.searchParams.set('state', recoveryAuthorizeUrl.searchParams.get('state'));
    const recoveryCallback = await handleGithubOAuthCallback(new Request(recoveryCallbackUrl), env);
    const recoveryLocation = new URL(recoveryCallback.headers.get('Location'));
    const recoveryFragment = new URLSearchParams(
      recoveryLocation.hash.slice(recoveryLocation.hash.indexOf('?') + 1)
    );
    const recoveryOauthCode = recoveryFragment.get('oauth_code');
    const recoveryExchange = await handleAdminAPI(
      adminRequest({
        action: 'github_oauth_exchange',
        oauth_code: recoveryOauthCode,
        recovery_code: recoveryCodes[0]
      }),
      env,
      sys
    );
    assert.equal(recoveryExchange.status, 200);
    const recoveryOauthToken = (await recoveryExchange.json()).token;
    const recoverySessionList = await handleAdminAPI(
      adminRequest({ action: 'session_list' }, recoveryOauthToken),
      env,
      sys
    );
    assert.equal(
      (await recoverySessionList.json()).sessions.find(session => session.current)?.auth_method,
      'github_oauth_recovery'
    );

    const statesBeforeRateLimit = Number((await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM admin_oauth_states
    `).first()).count);
    const rateLimitedStart = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_start', return_url: RETURN_URL }),
      env,
      sys
    );
    assert.equal(rateLimitedStart.status, 429);
    assert.equal(rateLimitedStart.headers.get('Cache-Control'), 'no-store');
    assert.match(rateLimitedStart.headers.get('Retry-After'), /^\d+$/);
    assert.equal((await rateLimitedStart.json()).code, 'github_oauth_start_rate_limited');
    assert.equal(Number((await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM admin_oauth_states
    `).first()).count), statesBeforeRateLimit);

    const independentIpStart = await handleAdminAPI(
      adminRequest(
        { action: 'github_oauth_start', return_url: RETURN_URL },
        '',
        '203.0.113.122'
      ),
      env,
      sys
    );
    assert.equal(independentIpStart.status, 200);

    const concurrentStarts = await Promise.all(Array.from({ length: 6 }, () => (
      handleAdminAPI(
        adminRequest(
          { action: 'github_oauth_start', return_url: RETURN_URL },
          '',
          '203.0.113.123'
        ),
        env,
        sys
      )
    )));
    assert.deepEqual(
      concurrentStarts.map(response => response.status).sort(),
      [200, 200, 200, 200, 200, 429]
    );
    const startLimitRows = await env.DB.prepare(`
      SELECT scope_hash, attempt_count
      FROM admin_oauth_start_limits
    `).all();
    assert.equal(JSON.stringify(startLimitRows.results).includes('203.0.113.'), false);

    const cleanupNow = Date.now();
    await env.DB.prepare(`
      INSERT INTO admin_oauth_start_limits (
        scope_hash,
        window_started_at,
        attempt_count,
        expires_at
      ) VALUES ('expired-limit', ?, 5, ?), ('live-limit', ?, 1, ?)
    `).bind(
      cleanupNow - 600_000,
      cleanupNow - 1,
      cleanupNow,
      cleanupNow + 600_000
    ).run();
    assert.equal(await cleanupGithubOAuthStartLimits(env.DB, cleanupNow), 1);
    const retainedStartLimits = await env.DB.prepare(`
      SELECT scope_hash
      FROM admin_oauth_start_limits
      WHERE scope_hash IN ('expired-limit', 'live-limit')
      ORDER BY scope_hash
    `).all();
    assert.deepEqual(
      retainedStartLimits.results.map(row => row.scope_hash),
      ['live-limit']
    );

    const unbindWithoutSecondFactor = await handleAdminAPI(
      adminRequest({ action: 'github_oauth_unbind' }, adminToken),
      env,
      sys
    );
    assert.equal(unbindWithoutSecondFactor.status, 428);
    assert.equal((await unbindWithoutSecondFactor.json()).code, 'totp_required');

    const invalidUnbindFactor = await handleAdminAPI(
      adminRequest({
        action: 'github_oauth_unbind',
        recovery_code: 'SENSITIVE-INVALID-UNBIND-RECOVERY'
      }, adminToken, '203.0.113.126'),
      env,
      sys
    );
    assert.equal(invalidUnbindFactor.status, 428);
    assert.equal((await invalidUnbindFactor.json()).code, 'invalid_second_factor');

    const unbindResponse = await handleAdminAPI(
      adminRequest({
        action: 'github_oauth_unbind',
        totp_code: await generateTotpCode(totpSetup.secret)
      }, adminToken),
      env,
      sys
    );
    assert.equal(unbindResponse.status, 200);
    const unbindBody = await unbindResponse.json();
    assert.equal(unbindBody.unbound, true);
    assert.equal(unbindBody.current_session_revoked, false);
    assert.ok(unbindBody.revoked_sessions >= 3);

    for (const revokedToken of [exchangeBody.token, verifiedTotpToken, recoveryOauthToken]) {
      const revokedSession = await handleAdminAPI(
        adminRequest({ action: 'session_list' }, revokedToken),
        env,
        sys
      );
      assert.equal(revokedSession.status, 401);
    }

    const passwordSessionAfterUnbind = await handleAdminAPI(
      adminRequest({ action: 'get_settings' }, adminToken),
      env,
      sys
    );
    assert.equal(passwordSessionAfterUnbind.status, 200);
    const settingsAfterUnbind = (await passwordSessionAfterUnbind.json()).settings;
    assert.equal(settingsAfterUnbind.github_oauth_bound, false);
    assert.equal(settingsAfterUnbind.github_login, '');

    const bindAuditResponse = await handleAdminAPI(
      adminRequest({ action: 'audit_list', event_type: 'admin.oauth.github.bind' }, adminToken),
      env,
      sys
    );
    assert.equal((await bindAuditResponse.json()).events[0].outcome, 'success');
    const unbindAuditResponse = await handleAdminAPI(
      adminRequest({ action: 'audit_list', event_type: 'admin.oauth.github.unbind' }, adminToken),
      env,
      sys
    );
    const unbindAuditBody = await unbindAuditResponse.json();
    assert.equal(unbindAuditBody.events[0].outcome, 'success');
    assert.equal(
      unbindAuditBody.events.find(event => event.detail?.reason === 'invalid_second_factor')
        ?.detail?.method,
      'unbind'
    );
    assert.equal(JSON.stringify(unbindAuditBody).includes(recoveryCodes[0]), false);

    const callbackAuditResponse = await handleAdminAPI(
      adminRequest(
        { action: 'audit_list', event_type: 'auth.oauth.github.callback' },
        adminToken
      ),
      env,
      sys
    );
    const callbackAuditBody = await callbackAuditResponse.json();
    const callbackReasons = new Set(
      callbackAuditBody.events.map(event => event.detail?.reason)
    );
    for (const reason of [
      'state_invalid',
      'identity_mismatch',
      'token_exchange_failed',
      'session_expired',
      'user_invalid'
    ]) {
      assert.equal(callbackReasons.has(reason), true, `missing callback audit reason: ${reason}`);
    }
    assert.ok(
      callbackAuditBody.events.find(event => event.detail?.reason === 'state_invalid')?.count >= 2
    );

    const oauthFailureAuditResponse = await handleAdminAPI(
      adminRequest(
        { action: 'audit_list', event_type: 'auth.oauth.github.failure' },
        adminToken
      ),
      env,
      sys
    );
    const oauthFailureAuditBody = await oauthFailureAuditResponse.json();
    const cappedExchangeFailures = oauthFailureAuditBody.events.find(event => (
      event.ip_address === '203.0.113.125' &&
      event.detail?.reason === 'exchange_invalid'
    ));
    assert.equal(cappedExchangeFailures?.count, 20);
    assert.equal(
      oauthFailureAuditBody.events.find(event => (
        event.ip_address === '203.0.113.121' &&
        event.detail?.reason === 'invalid_second_factor'
      ))?.count,
      5
    );
    assert.equal(
      oauthFailureAuditBody.events.some(event => (
        event.ip_address === '203.0.113.121' &&
        event.detail?.reason === 'second_factor_rate_limited'
      )),
      true
    );

    const serializedOAuthAudits = JSON.stringify([
      callbackAuditBody.events,
      oauthFailureAuditBody.events,
      unbindAuditBody.events
    ]);
    for (const event of [
      ...callbackAuditBody.events,
      ...oauthFailureAuditBody.events,
      ...unbindAuditBody.events
    ]) {
      assert.deepEqual(
        Object.keys(event.detail || {}).sort(),
        Object.keys(event.detail || {})
          .filter(key => ['method', 'provider', 'reason'].includes(key))
          .sort()
      );
    }
    for (const sensitiveValue of [
      authorizeUrl.searchParams.get('state'),
      'temporary-github-code',
      invalidExchangeCode,
      oauthAccessToken,
      env.GITHUB_OAUTH_CLIENT_SECRET,
      oauthCode,
      exchangeBody.token,
      'SENSITIVE-INVALID-UNBIND-RECOVERY'
    ]) {
      assert.equal(serializedOAuthAudits.includes(sensitiveValue), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await miniflare.dispose();
  }
});
