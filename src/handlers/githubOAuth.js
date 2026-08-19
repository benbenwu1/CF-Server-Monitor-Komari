import {
  bindGithubOAuthIdentity,
  buildGithubOAuthReturnUrl,
  consumeGithubOAuthState,
  createGithubOAuthExchangeCode,
  fetchGithubOAuthUser,
  getGithubOAuthBinding,
  isGithubOAuthCallbackRequest,
  isGithubOAuthAvailable
} from '../services/githubOAuth.js';
import { validateAdminSession } from '../services/adminSession.js';
import { recordAuditEvent } from '../services/audit.js';

const OAUTH_FAILURE_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const OAUTH_FAILURE_AUDIT_WRITE_LIMIT = 20;
const CALLBACK_AUDIT_REASONS = new Set([
  'authorization_denied',
  'binding_conflict',
  'callback_failed',
  'callback_mismatch',
  'code_invalid',
  'identity_mismatch',
  'session_expired',
  'state_invalid',
  'token_exchange_failed',
  'unavailable',
  'user_fetch_failed',
  'user_invalid'
]);
const CALLBACK_AUDIT_METHODS = new Set(['bind', 'login']);

function jsonError(code, status = 400) {
  return new Response(JSON.stringify({ error: code, code }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    }
  });
}

function redirectResult(returnUrl, requestUrl, result) {
  const location = buildGithubOAuthReturnUrl(returnUrl, {
    ...result,
    oauth_api: new URL(requestUrl).origin
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

async function recordGithubOAuthAudit(db, request, eventType, outcome, detail = {}) {
  const occurredAt = Date.now();
  const reason = CALLBACK_AUDIT_REASONS.has(detail.reason) ? detail.reason : null;
  const method = CALLBACK_AUDIT_METHODS.has(detail.method) ? detail.method : null;
  const ipAddress = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    await recordAuditEvent(db, {
      eventType,
      outcome,
      actor: eventType.startsWith('admin.') ? 'admin' : 'anonymous',
      targetType: 'admin_oauth_identity',
      targetId: 'github',
      ipAddress: request.headers.get('CF-Connecting-IP'),
      userAgent: request.headers.get('User-Agent'),
      detail: {
        provider: 'github',
        ...(reason ? { reason } : {}),
        ...(method ? { method } : {})
      },
      dedupeKey: outcome === 'failure' && reason
        ? `${eventType}:${reason}:${ipAddress}:${Math.floor(occurredAt / OAUTH_FAILURE_DEDUPE_WINDOW_MS)}`
        : null,
      maxCount: outcome === 'failure' ? OAUTH_FAILURE_AUDIT_WRITE_LIMIT : undefined,
      occurredAt
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'audit.persist_failed',
      event_type: eventType,
      error: error?.name || 'Error'
    }));
  }
}

function getGithubOAuthCallbackFailureReason(error) {
  switch (error?.message) {
    case 'github_oauth_code_invalid':
      return 'code_invalid';
    case 'github_oauth_token_exchange_failed':
      return 'token_exchange_failed';
    case 'github_oauth_user_fetch_failed':
      return 'user_fetch_failed';
    case 'github_oauth_user_invalid':
      return 'user_invalid';
    default:
      return 'callback_failed';
  }
}

export async function handleGithubOAuthCallback(request, env) {
  if (!isGithubOAuthAvailable(env)) {
    await recordGithubOAuthAudit(
      env.DB,
      request,
      'auth.oauth.github.callback',
      'failure',
      { reason: 'unavailable', method: 'login' }
    );
    return jsonError('github_oauth_unavailable');
  }

  const url = new URL(request.url);
  if (!isGithubOAuthCallbackRequest(env, url)) {
    await recordGithubOAuthAudit(
      env.DB,
      request,
      'auth.oauth.github.callback',
      'failure',
      { reason: 'callback_mismatch', method: 'login' }
    );
    return jsonError('github_oauth_callback_mismatch');
  }
  const pendingState = await consumeGithubOAuthState(env.DB, url.searchParams.get('state'));
  if (!pendingState) {
    await recordGithubOAuthAudit(
      env.DB,
      request,
      'auth.oauth.github.callback',
      'failure',
      { reason: 'state_invalid', method: 'login' }
    );
    return jsonError('github_oauth_state_invalid');
  }

  if (url.searchParams.get('error')) {
    await recordGithubOAuthAudit(
      env.DB,
      request,
      'auth.oauth.github.callback',
      'failure',
      { reason: 'authorization_denied', method: pendingState.purpose }
    );
    return redirectResult(pendingState.return_url, request.url, {
      oauth_error: 'github_oauth_denied'
    });
  }

  if (pendingState.purpose === 'bind') {
    const session = await validateAdminSession(
      env.DB,
      pendingState.session_id,
      request
    );
    if (!session) {
      await recordGithubOAuthAudit(
        env.DB,
        request,
        'auth.oauth.github.callback',
        'failure',
        { reason: 'session_expired', method: 'bind' }
      );
      await recordGithubOAuthAudit(
        env.DB,
        request,
        'admin.oauth.github.bind',
        'failure',
        { reason: 'session_expired', method: 'bind' }
      );
      return redirectResult(pendingState.return_url, request.url, {
        oauth_error: 'github_oauth_session_expired'
      });
    }
  }

  try {
    const githubUser = await fetchGithubOAuthUser(
      env,
      pendingState,
      url.searchParams.get('code')
    );
    if (pendingState.purpose === 'bind') {
      const result = await bindGithubOAuthIdentity(env.DB, githubUser);
      if (!result.bound) {
        await recordGithubOAuthAudit(
          env.DB,
          request,
          'admin.oauth.github.bind',
          'failure',
          { reason: 'binding_conflict', method: 'bind' }
        );
        return redirectResult(pendingState.return_url, request.url, {
          oauth_error: result.reason
        });
      }
      await recordGithubOAuthAudit(
        env.DB,
        request,
        'admin.oauth.github.bind',
        'success',
        { method: 'bind' }
      );
      return redirectResult(pendingState.return_url, request.url, {
        oauth_bound: '1'
      });
    }
    const binding = await getGithubOAuthBinding(env.DB);
    if (!binding || String(binding.provider_user_id) !== githubUser.providerUserId) {
      await recordGithubOAuthAudit(
        env.DB,
        request,
        'auth.oauth.github.callback',
        'failure',
        { reason: 'identity_mismatch', method: 'login' }
      );
      return redirectResult(pendingState.return_url, request.url, {
        oauth_error: 'github_oauth_not_bound'
      });
    }
    const exchangeCode = await createGithubOAuthExchangeCode(
      env.DB,
      githubUser.providerUserId
    );
    return redirectResult(pendingState.return_url, request.url, {
      oauth_code: exchangeCode
    });
  } catch (error) {
    await recordGithubOAuthAudit(
      env.DB,
      request,
      pendingState.purpose === 'bind'
        ? 'admin.oauth.github.bind'
        : 'auth.oauth.github.callback',
      'failure',
      {
        reason: getGithubOAuthCallbackFailureReason(error),
        method: pendingState.purpose
      }
    );
    return redirectResult(pendingState.return_url, request.url, {
      oauth_error: 'github_oauth_callback_failed'
    });
  }
}
