const OAUTH_FRAGMENT_KEYS = [
  'oauth_code',
  'oauth_api',
  'oauth_error',
  'oauth_bound'
]

const normalizeApiBase = value => String(value || '').trim().replace(/\/+$/, '')

function splitHash(hash) {
  const value = String(hash || '').replace(/^#/, '')
  const separatorIndex = value.indexOf('?')
  return {
    route: separatorIndex >= 0 ? value.slice(0, separatorIndex) : value,
    params: new URLSearchParams(separatorIndex >= 0 ? value.slice(separatorIndex + 1) : '')
  }
}

function buildCleanUrl(url, route, params) {
  const query = params.toString()
  url.hash = route || query ? `${route || 'admin'}${query ? `?${query}` : ''}` : ''
  return url.toString()
}

export function consumeGithubOAuthFragment(href, apiBases, replaceUrl = () => {}) {
  const url = new URL(String(href));
  const { route, params } = splitHash(url.hash);
  const hasOAuthResult = OAUTH_FRAGMENT_KEYS.some(key => params.has(key));
  const result = { code: '', apiIndex: -1, error: '', bound: false };
  if (!hasOAuthResult) return result;

  const code = String(params.get('oauth_code') || '').trim();
  const apiBase = normalizeApiBase(params.get('oauth_api'));
  const error = String(params.get('oauth_error') || '').trim();
  const bound = params.get('oauth_bound') === '1';
  const normalizedBases = (Array.isArray(apiBases) ? apiBases : []).map(normalizeApiBase);

  for (const key of OAUTH_FRAGMENT_KEYS) params.delete(key);
  replaceUrl(buildCleanUrl(url, route, params));

  if (error) {
    result.error = /^[a-z0-9_]{1,100}$/.test(error)
      ? error
      : 'github_oauth_callback_failed';
  }
  result.bound = bound;
  result.apiIndex = normalizedBases.indexOf(apiBase);
  if (apiBase && result.apiIndex < 0) {
    result.error = 'github_oauth_api_mismatch';
    result.bound = false;
  }

  if (code) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
      result.error = 'github_oauth_exchange_invalid';
    } else if (result.apiIndex < 0) {
      result.error = 'github_oauth_api_mismatch';
    } else {
      result.code = code;
    }
  }

  return result;
}

export function buildGithubOAuthReturnUrl(currentUrl) {
  const url = new URL(String(currentUrl));
  url.pathname = '/admin';
  url.search = '';
  url.hash = 'admin';
  return url.toString();
}

export function getGithubOAuthCallbackFeedback(fragment = {}, isLoggedIn = false) {
  const error = String(fragment?.error || '').trim();
  if (error) {
    return isLoggedIn
      ? { loginErrorKey: '', alertKey: error }
      : { loginErrorKey: error, alertKey: '' };
  }
  if (isLoggedIn && fragment?.bound === true) {
    return { loginErrorKey: '', alertKey: 'githubOauthBindSuccess' };
  }
  return { loginErrorKey: '', alertKey: '' };
}
