import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { createBadRequestResponse, createNotFoundResponse, createSuccessResponse } from '../utils/errors.js';
import {
  getVisiblePingTaskForServer,
  listPingTaskHistory,
  listPingTaskHistoryForServer,
  listVisiblePingTasks,
  PingTaskError
} from '../services/pingTasks.js';

export async function handlePingTaskList(request, env, settings) {
  const isLoggedIn = await checkAuth(request, env, settings);
  if (settings.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }
  const tasks = await listVisiblePingTasks(env.DB, isLoggedIn);
  return createSuccessResponse({ tasks }, { 'Cache-Control': 'private, max-age=30' });
}

export async function handlePingTaskHistory(request, env, settings) {
  const isLoggedIn = await checkAuth(request, env, settings);
  if (settings.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }

  const url = new URL(request.url);
  const taskId = url.searchParams.get('task_id');
  const serverId = url.searchParams.get('server_id');
  const hours = Number(url.searchParams.get('hours') || 24);
  try {
    if (hours > 24 && !isLoggedIn) {
      return simpleAuthResponse();
    }
    if (!taskId) {
      const series = await listPingTaskHistoryForServer(env.DB, {
        serverId,
        hours,
        includeHiddenServer: isLoggedIn
      });
      return createSuccessResponse({ series }, { 'Cache-Control': 'private, max-age=30' });
    }
    const task = await getVisiblePingTaskForServer(env.DB, taskId, serverId, isLoggedIn);
    if (!task) return createNotFoundResponse('pingTaskNotFound');
    const results = await listPingTaskHistory(env.DB, { taskId, serverId, hours });
    return createSuccessResponse({ task, results }, { 'Cache-Control': 'private, max-age=30' });
  } catch (error) {
    if (error instanceof PingTaskError) {
      return createBadRequestResponse(error.message);
    }
    throw error;
  }
}
