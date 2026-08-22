import { initDatabase, weeklyCleanup, getMetricsHistory, clearHistory } from './database/schema.js';
import { checkOfflineNodes, checkExpiringServers, checkResourceAlerts, sendNotification } from './services/notification.js';
import {
  cleanupNotificationJobs,
  finalizeExpiredNotificationJobs,
  processNotificationQueueBatch,
  recoverStagedNotificationJobs
} from './services/notificationQueue.js';
import { cleanupAuditEvents } from './services/audit.js';
import { cleanupNotificationDeliveries } from './services/notificationDelivery.js';
import { cleanupAdminSessions } from './services/adminSession.js';
import { updateDatabase } from './database/updateDatabase.js';
import { handleAdminAPI } from './handlers/admin.js';
import { handleGithubOAuthCallback } from './handlers/githubOAuth.js';
import { handlePingTaskHistory, handlePingTaskList } from './handlers/pingTasks.js';
import { serveFrontend } from './handlers/frontend.js';
import { handleUpdate, handleWebSocketUpgrade, handleUpdateWebSocketUpgrade } from './handlers/update.js';
import { handleServerAPI, handleServersAPI } from './handlers/dashboard.js';
import { handleTheme } from './handlers/theme.js';
import { loadSettings, loadSiteSettings, loadAppearanceOptions, normalizeLongHistoryPoints, setDebug, debug, getCurrentVersion } from './utils/settings.js';
import { checkAuth, simpleAuthResponse } from './middleware/auth.js';
import { getServerDetail, getMetricsHistoryCache, setMetricsHistoryCache, getCacheDuration } from './utils/cache.js';
import { AppError, createSuccessResponse, createUnauthorizedResponse, createBadRequestResponse, createNotFoundResponse, createErrorResponse } from './utils/errors.js';
import { verifyTurnstileToken } from './utils/common.js';
import { getCorsAllowedOrigins, createOptionsResponse, applyCors } from './utils/cors.js';
import { getRemoteVersion } from './utils/version.js';
import { cleanupGithubOAuthStartLimits, isGithubOAuthAvailable } from './services/githubOAuth.js';
import { cleanupPingTaskResults } from './services/pingTasks.js';
import { cleanupTrafficReportRuns, runScheduledTrafficReport } from './services/trafficReport.js';
import { runKomariMonitor } from './services/komariMonitor.js';
import { recordRequestTelemetry } from './services/analytics.js';
// Durable Objects: 实时指标广播
// 显式 import + extends，确保 wrangler 静态分析器能在入口文件直接识别此 DO 类
import { MetricsBroadcaster as _MetricsBroadcaster }
  from './durable/MetricsBroadcaster.js';

export class MetricsBroadcaster extends _MetricsBroadcaster {}

function cleanThemeAssetResponse(response) {
  const headers = new Headers(response.headers);
  headers.delete('X-CFSM-Theme-Asset');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function getEncryptionKey(env, sys) {
  let secret = (sys && sys.jwt_secret) || env.TURNSTILE_SECRET_KEY || env.API_SECRET || 'default_secret_key_for_turnstile_encryption';
  secret += '_turnstile';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(hash).slice(0, 32),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  return keyMaterial;
}

async function encryptTurnstileData(data, env, sys) {
  const key = await getEncryptionKey(env, sys);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encodedData = encoder.encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encodedData
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptTurnstileData(encoded, env, sys) {
  try {
    const key = await getEncryptionKey(env, sys);
    const decoded = new Uint8Array(atob(encoded).split('').map(c => c.charCodeAt(0)));
    const iv = decoded.slice(0, 12);
    const ciphertext = decoded.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      ciphertext
    );
    const encoder = new TextDecoder();
    return JSON.parse(encoder.decode(decrypted));
  } catch (e) {
    debug('Cookie decryption error:', e);
    return null;
  }
}

async function isTurnstileVerified(request, env, sys) {
  const verifiedHeader = request.headers.get('X-Turnstile-Verified');
  
  if (!verifiedHeader) return false;
  
  try {
    const decrypted = await decryptTurnstileData(verifiedHeader, env, sys);
    return decrypted && decrypted.expires && Date.now() < decrypted.expires * 1000;
  } catch {
    return false;
  }
}

async function fetchHistoryData(env, request, id, hours, columns, sys = null) {
  if (!id) return createBadRequestResponse('Missing ID');

  const ALLOWED_HOURS = [0.167, 0.5, 1, 6, 12, 24, 48, 96, 168];
  if (!ALLOWED_HOURS.includes(hours)) {
    return createBadRequestResponse('Invalid hours parameter');
  }
  
  if (!sys) {
    sys = await loadSiteSettings(env.DB);
  }
  const isLoggedIn = await checkAuth(request, env, sys);
  
  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }
  
  if (hours > 24 && !isLoggedIn) {
    return createUnauthorizedResponse();
  }
  
  const server = await getServerDetail(env.DB, id, isLoggedIn);
  if (!server) return createNotFoundResponse();
  
  // 最多查询7天数据
  const clampedHours = Math.min(hours, 168);
  const cacheDuration = getCacheDuration(clampedHours);
  const longHistoryPoints = clampedHours > 1
    ? Number(normalizeLongHistoryPoints(sys.long_history_points))
    : null;

  const cached = getMetricsHistoryCache(id, clampedHours, columns, longHistoryPoints);
  if (cached && Date.now() - cached.timestamp < cacheDuration) {
    return createSuccessResponse(cached.data, { 'X-Cache': 'HIT' });
  }
  
  let data;
  try {
    data = await getMetricsHistory(
      env.DB,
      id,
      clampedHours,
      columns,
      server,
      longHistoryPoints
    );
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    if (/no such column/i.test(message)) {
      debug('[History] 数据库字段缺失，可能尚未升级数据库:', message);
      return new Response(JSON.stringify({
        message: 'databaseUpgradeRequired'
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    throw e;
  }
  
  setMetricsHistoryCache(id, clampedHours, columns, data, longHistoryPoints);
  
  return createSuccessResponse(data, { 'X-Cache': 'MISS' });
}

export default {
  async fetch(request, env, ctx) {
    setDebug(env.DEBUG);

    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const telemetryStartedAt = Date.now();
    const finishResponse = (response, outcome = '') => {
      recordRequestTelemetry(env, request, response?.status || 0, Date.now() - telemetryStartedAt, outcome);
      return response;
    };

    try {

    const corsAllowedOrigins = getCorsAllowedOrigins(env);
    
    if (!env.API_SECRET || env.API_SECRET.length === 0) {
      const response = createBadRequestResponse('API_SECRET is required');
      return finishResponse(applyCors(response, request, corsAllowedOrigins));
    }
    
    if (method === 'OPTIONS') {
      return finishResponse(createOptionsResponse(request, corsAllowedOrigins));
    }

    if (method === 'GET' && path === '/admin/') {
      const target = new URL(request.url);
      const search = target.search;
      target.pathname = '/admin';
      target.search = '';
      target.hash = `admin${search}`;
      return finishResponse(Response.redirect(target.toString(), 302));
    }

    if (method === 'GET' && path.startsWith('/assets/')) {
      try {
        const themeAssetResponse = await serveFrontend(request, env, await loadSettings(env.DB));
        if (themeAssetResponse.headers.get('X-CFSM-Theme-Asset') === '1') {
          return finishResponse(applyCors(cleanThemeAssetResponse(themeAssetResponse), request, corsAllowedOrigins));
        }
      } catch (e) {
      }
    }

    const bypassTurnstilePaths = [
      '/admin/api',
      '/api/ws',
    ];

    const isApiRequest = path.startsWith('/api/') || path.startsWith('/admin/api');
    if (path === '/api/config' || path === '/clearHistory') {
      await initDatabase(env.DB);
    }

    // /api/config 在不带 X-Turnstile-Token 且不带 X-Turnstile-Verified 时仍然 bypass（用于初始化判断是否需要验证），
    // 带 token 或 verified header 时则走完整验证流程，以便复用 verified 字段返回验证结果
    const isTurnstileBypassed = (reqPath) => {
      if (bypassTurnstilePaths.includes(reqPath)) return true;
      if (reqPath === '/api/config' && !request.headers.get('X-Turnstile-Token') && !request.headers.get('X-Turnstile-Verified')) return true;
      return false;
    };

    let setTurnstileVerified = false;
    let sys = null;

    if (isApiRequest && !isTurnstileBypassed(path)) {
      sys = await loadSiteSettings(env.DB);
      const turnstileEnabled = sys.turnstile_enabled === 'true';
      const turnstileSecretKey = sys.turnstile_secret_key || '';
      
      // 全局 Turnstile 验证：仅 turnstile_enabled 开启时拦截所有 API 请求
      // turnstile_login_enabled 仅在登录时验证，不在此处拦截
      if (turnstileEnabled) {
        const hasValidCookie = await isTurnstileVerified(request, env, sys);
        
        if (!hasValidCookie) {
          const turnstileToken = request.headers.get('X-Turnstile-Token');
          const isVerified = await verifyTurnstileToken(turnstileToken, turnstileSecretKey);
          
          if (!isVerified) {
            const response = createErrorResponse(new AppError('Turnstile verification failed', 403));
            return finishResponse(applyCors(response, request, corsAllowedOrigins));
          }
          
          setTurnstileVerified = true;
        }
      }
    }

    async function ensureSiteSettings() {
      if (!sys) {
        sys = await loadSiteSettings(env.DB);
      }
      return sys;
    }

    async function ensureFullSettings() {
      sys = await loadSettings(env.DB);
      return sys;
    }

    const routes = [
      { method: 'POST', path: '/update', handler: () => handleUpdate(request, env, ctx) },
      { method: 'GET', path: '/update', handler: () => handleUpdateWebSocketUpgrade(request, env) },
      { method: 'GET', path: '/__do/health', handler: async () => {
        if (!env.METRICS_BROADCASTER) {
          return createSuccessResponse({ ok: false, reason: 'DO not bound' });
        }
        try {
          const id = env.METRICS_BROADCASTER.idFromName('global');
          const stub = env.METRICS_BROADCASTER.get(id);
          return await stub.fetch('http://internal/health');
        } catch (e) {
          return createSuccessResponse({ ok: false, reason: e.message });
        }
      }},
      { method: 'GET', path: '/api/config', handler: async () => {
        await ensureSiteSettings();
        const appearanceOptions = await loadAppearanceOptions(env.DB);
        const turnstileEnabled = sys.turnstile_enabled === 'true';
        const turnstileLoginEnabled = sys.turnstile_login_enabled === 'true';
        let verified = false;
        let turnstileVerified = null;

        if (turnstileEnabled) {
          verified = await isTurnstileVerified(request, env, sys);
          if (setTurnstileVerified) {
            verified = true;
            const expires = Math.floor(Date.now() / 1000) + 3600;
            const cookieData = { expires, verified: true, timestamp: Date.now() };
            turnstileVerified = await encryptTurnstileData(cookieData, env, sys);
          }
        }

        const isLoggedIn = await checkAuth(request, env, sys);
        const remoteVersion = isLoggedIn ? await getRemoteVersion() : null;

        return createSuccessResponse({
          version: getCurrentVersion(),
          ...(isLoggedIn ? {
            last_workers_version: remoteVersion?.workers || null,
            last_agent_version: remoteVersion?.agent || null
          } : {}),
          is_public: sys.is_public === 'true',
          authorization: isLoggedIn,
          turnstile_enabled: turnstileEnabled,
          turnstile_login_enabled: turnstileEnabled || turnstileLoginEnabled,
          turnstile_site_key: sys.turnstile_site_key || '',
          github_oauth_available: isGithubOAuthAvailable(env),
          site_title: appearanceOptions.site_title || '',
          display_mode: appearanceOptions.display_mode || 'bar',
          theme_options: appearanceOptions.theme_options || {},
          verified: verified,
          turnstile_verified: turnstileVerified,
          long_history_points: Number(normalizeLongHistoryPoints(sys.long_history_points))
        });
      }},
      { method: 'GET', path: '/theme', handler: async () => {
        const themeResult = await handleTheme()
        if (!themeResult.ok) {
          return new Response(JSON.stringify({
            error: themeResult.error || 'themeStoreProxyFailed',
            code: 502,
            fallback: 'client'
          }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
          })
        }

        return createSuccessResponse(themeResult.themeStore, {
          'X-CFSM-Theme-Source': themeResult.cached ? 'cache' : 'raw'
        })
      }},
      { method: 'GET', path: '/api/server', handler: async () => {
        await ensureSiteSettings();
        return handleServerAPI(request, env, sys);
      }},
      { method: 'GET', path: '/api/servers', handler: async () => {
        await ensureFullSettings();
        return handleServersAPI(request, env, sys);
      }},
      { method: 'GET', path: '/api/ws', handler: async () => handleWebSocketUpgrade(request, env) },
      { method: 'GET', path: '/api/ping-tasks', handler: async () => {
        await initDatabase(env.DB);
        await ensureSiteSettings();
        return handlePingTaskList(request, env, sys);
      }},
      { method: 'GET', path: '/api/ping-history', handler: async () => {
        await initDatabase(env.DB);
        await ensureSiteSettings();
        return handlePingTaskHistory(request, env, sys);
      }},
      { method: 'GET', path: '/admin/oauth/github/callback', handler: async () => {
        await initDatabase(env.DB);
        return handleGithubOAuthCallback(request, env);
      }},

      { method: 'GET', path: '/api/history/all', handler: async () => {
        await ensureSiteSettings();
        const id = url.searchParams.get('id');
        const hours = parseFloat(url.searchParams.get('hours') || '24');
        const allColumns = 'cpu, gpu_info, ram_total, ram_used, disk_total, disk_used, disk_read_bps, disk_write_bps, disk_read_iops, disk_write_iops, disk_await_ms, disk_util, processes, net_in_speed, net_out_speed, tcp_conn, udp_conn, ping_ct, ping_cu, ping_cm, ping_bd, loss_ct, loss_cu, loss_cm, loss_bd, swap_total, swap_used, load_avg, region, kernel_version';
        // 后续版本可以删掉region 字段，用于升级数据库提示
        return fetchHistoryData(env, request, id, hours, allColumns, sys);
      }},
      { method: 'POST', path: '/admin/api', handler: async () => {
        await initDatabase(env.DB);
        await ensureSiteSettings();
        return handleAdminAPI(request, env, sys, ensureFullSettings, ctx);
      }},
      { method: 'POST', path: '/updateDatabase', handler: async () => {
        await ensureSiteSettings();
        if (!await checkAuth(request, env, sys)) {
          return simpleAuthResponse();
        }
        const result = await updateDatabase(env.DB);
        return createSuccessResponse(result);
      }},
      { method: 'POST', path: '/clearHistory', handler: async () => {
        await ensureSiteSettings();
        if (!await checkAuth(request, env, sys)) {
          return simpleAuthResponse();
        }
        const result = await clearHistory(env.DB);
        return createSuccessResponse(result);
      }}
    ];

    for (const route of routes) {
      if (route.method === method && route.path === path) {
        const response = await route.handler();

        // WebSocket 升级响应直接原样返回，不能修改 response 对象
        if (response.status === 101) {
          return finishResponse(response);
        }

        if (setTurnstileVerified) {
          const expires = Math.floor(Date.now() / 1000) + 3600;
          const cookieData = { expires, verified: true, timestamp: Date.now() };
          const encryptedData = await encryptTurnstileData(cookieData, env, sys);

          const finalHeaders = new Headers(response.headers);
          finalHeaders.set('Access-Control-Allow-Origin', request.headers.get('Origin') || '');
          finalHeaders.set('Access-Control-Allow-Credentials', 'true');
          finalHeaders.set('Vary', 'Origin');

          return finishResponse(new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: finalHeaders
          }));
        }

        return finishResponse(applyCors(response, request, corsAllowedOrigins));
      }
    }

    const fullSettings = await loadSettings(env.DB);
    const frontendResponse = await serveFrontend(request, env, fullSettings);
    return finishResponse(applyCors(frontendResponse, request, corsAllowedOrigins));
    } catch (error) {
      recordRequestTelemetry(env, request, 500, Date.now() - telemetryStartedAt, 'exception');
      throw error;
    }
  },

  async scheduled(event, env, ctx) {
    await initDatabase(env.DB);
    const finalizedNotificationJobs = await finalizeExpiredNotificationJobs(env);
    if (finalizedNotificationJobs > 0) {
      debug(`[Cron] 已终结耗尽重试预算的通知任务: jobs=${finalizedNotificationJobs}`);
    }
    const recoveredNotificationJobs = await recoverStagedNotificationJobs(env);
    if (recoveredNotificationJobs > 0) {
      debug(`[Cron] 已恢复通知 Queue 任务: jobs=${recoveredNotificationJobs}`);
    }
    const cron = event.cron;
    debug(`[Cron] 定时任务触发: ${cron}`);

    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    
    if (cron === '*/1 * * * *') {
      if (day === 0 && hour === 0 && minute < 5) {
        debug('[Cron] 每周日0:00-0:05表轮换期间，跳过离线节点检测');
      } else {
        debug('[Cron] 开始执行离线节点检测');
        await checkOfflineNodes(env);
        debug('[Cron] 离线节点检测完成');
        debug('[Cron] 开始执行资源负载告警检测');
        await checkResourceAlerts(env);
        debug('[Cron] 资源负载告警检测完成');
        try {
          const komariMonitor = await runKomariMonitor(env, now, sendNotification);
          if (komariMonitor.notifications > 0) {
            debug(`[Cron] Komari 只读监控通知已投递: nodes=${komariMonitor.node_count}`);
          }
        } catch (error) {
          console.error(JSON.stringify({
            event: 'komari_monitor.failed',
            error: error?.name || 'Error'
          }));
        }
      }
    } else if (cron === '0 * * * *') {
      const oauthStartLimitsDeleted = await cleanupGithubOAuthStartLimits(env.DB);
      debug(`[Cron] GitHub OAuth 发起限流记录清理完成: limits=${oauthStartLimitsDeleted}`);

      try {
        const trafficReport = await runScheduledTrafficReport(env, now, sendNotification);
        if (trafficReport.sent) {
          debug(`[Cron] 周期流量快照已发送: period=${trafficReport.period_key}`);
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: 'traffic_report.scheduled_failed',
          error: error?.name || 'Error'
        }));
      }

      if (hour === 0) {
        const [auditDeleted, deliveryDeleted, notificationJobsDeleted, trafficReportRunsDeleted, sessionDeleted, pingResultsDeleted] = await Promise.all([
          cleanupAuditEvents(env.DB),
          cleanupNotificationDeliveries(env.DB),
          cleanupNotificationJobs(env.DB),
          cleanupTrafficReportRuns(env.DB),
          cleanupAdminSessions(env.DB),
          cleanupPingTaskResults(env.DB)
        ]);
        debug(`[Cron] 控制面记录清理完成: audit=${auditDeleted}, deliveries=${deliveryDeleted}, notification_jobs=${notificationJobsDeleted}, traffic_report_runs=${trafficReportRunsDeleted}, sessions=${sessionDeleted}, ping_results=${pingResultsDeleted}`);
      }

      if (day === 0 && hour === 0) {
        debug('[Cron] 开始执行每周数据清理任务（表轮换）');
        await weeklyCleanup(env.DB);
        debug('[Cron] 每周数据清理任务完成');
      }
      
      if (hour === 12) {
        debug('[Cron] 开始执行服务器到期检测');
        await checkExpiringServers(env);
        debug('[Cron] 服务器到期检测完成');
      }
    }else if(env.DEBUG == 1){
      if (cron === '0 0 * * 0') {
        debug('[Cron DEBUG] 开始执行每周数据清理任务（表轮换）');
        await weeklyCleanup(env.DB);
        debug('[Cron DEBUG] 每周数据清理任务完成');
      } else if (cron === '0 12 * * *') {
        debug('[Cron DEBUG] 开始执行服务器到期检测');
        await checkExpiringServers(env);
        debug('[Cron DEBUG] 服务器到期检测完成');
      }
    }
  },

  async queue(batch, env, ctx) {
    await initDatabase(env.DB);
    await processNotificationQueueBatch(batch, env, sendNotification);
  }
};
