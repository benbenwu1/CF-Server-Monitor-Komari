import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGithubOAuthReturnUrl,
  consumeGithubOAuthFragment,
  getGithubOAuthCallbackFeedback
} from '../src/frontend/utils/githubOAuth.js';

test('GitHub OAuth fragment maps the exact Worker and removes the exchange code before use', () => {
  const code = 'A'.repeat(43);
  const href = `https://pages.example/admin#admin?tab=sessions&oauth_code=${code}&oauth_api=https%3A%2F%2Fworker-b.example`;
  let replacedUrl = '';

  const result = consumeGithubOAuthFragment(
    href,
    ['https://worker-a.example', 'https://worker-b.example/'],
    value => { replacedUrl = value; }
  );

  assert.deepEqual(result, {
    code,
    apiIndex: 1,
    error: '',
    bound: false
  });
  assert.equal(replacedUrl, 'https://pages.example/admin#admin?tab=sessions');
  assert.equal(replacedUrl.includes(code), false);
  assert.equal(replacedUrl.includes('oauth_api'), false);
});

test('GitHub OAuth fragment rejects an unknown Worker and still removes sensitive values', () => {
  const code = 'B'.repeat(43);
  let replacedUrl = '';
  const result = consumeGithubOAuthFragment(
    `https://pages.example/admin#admin?oauth_code=${code}&oauth_api=https%3A%2F%2Fevil.example`,
    ['https://worker.example'],
    value => { replacedUrl = value; }
  );

  assert.equal(result.code, '');
  assert.equal(result.apiIndex, -1);
  assert.equal(result.error, 'github_oauth_api_mismatch');
  assert.equal(replacedUrl.includes(code), false);
  assert.equal(replacedUrl.includes('evil.example'), false);
});

test('GitHub OAuth return URL is a fixed admin completion route', () => {
  assert.equal(
    buildGithubOAuthReturnUrl('https://pages.example/somewhere?ignored=1'),
    'https://pages.example/admin#admin'
  );
});

test('GitHub OAuth binding result selects the Worker that initiated it', () => {
  const result = consumeGithubOAuthFragment(
    'https://pages.example/admin#admin?oauth_bound=1&oauth_api=https%3A%2F%2Fworker-b.example',
    ['https://worker-a.example', 'https://worker-b.example'],
    () => {}
  );

  assert.equal(result.bound, true);
  assert.equal(result.apiIndex, 1);
});

test('GitHub OAuth callback feedback keeps errors visible across login state', () => {
  const failedAndBound = {
    code: '',
    apiIndex: 0,
    error: 'github_oauth_callback_failed',
    bound: true
  };

  assert.deepEqual(
    getGithubOAuthCallbackFeedback(failedAndBound, false),
    {
      loginErrorKey: 'github_oauth_callback_failed',
      alertKey: ''
    }
  );
  assert.deepEqual(
    getGithubOAuthCallbackFeedback(failedAndBound, true),
    {
      loginErrorKey: '',
      alertKey: 'github_oauth_callback_failed'
    }
  );
  assert.deepEqual(
    getGithubOAuthCallbackFeedback({ error: '', bound: true }, true),
    {
      loginErrorKey: '',
      alertKey: 'githubOauthBindSuccess'
    }
  );
  assert.deepEqual(
    getGithubOAuthCallbackFeedback({ error: '', bound: true }, false),
    {
      loginErrorKey: '',
      alertKey: ''
    }
  );
});
