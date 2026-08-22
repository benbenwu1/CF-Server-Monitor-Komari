import assert from 'node:assert/strict';
import test from 'node:test';

import { sendNotification } from '../src/services/notification.js';

test('sendNotification returns a structured retry result without exposing credentials', async () => {
  const realFetch = globalThis.fetch;
  const botToken = 'private-telegram-bot-token';
  const chatId = 'private-telegram-chat-id';
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response('', { status: requests.length === 1 ? 503 : 200 });
  };

  try {
    const result = await sendNotification({
      notification_provider: 'telegram',
      tg_bot_token: botToken,
      tg_chat_id: chatId
    }, 'test message');

    assert.deepEqual(result, {
      success: true,
      provider: 'telegram',
      attempts: 2,
      status_code: 200,
      error: null
    });
    assert.equal(requests.length, 2);

    const serializedResult = JSON.stringify(result);
    assert.equal(serializedResult.includes(botToken), false);
    assert.equal(serializedResult.includes(chatId), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('legacy notification credential formats still auto-detect all supported providers', async () => {
  const realFetch = globalThis.fetch;
  const cases = [
    ['onebot', { tg_bot_token: 'onebot:https://onebot.example/send_private_msg?access_token=private', tg_chat_id: '10001' }],
    ['feishu', { tg_bot_token: 'https://open.feishu.cn/open-apis/bot/v2/hook/private' }],
    ['dingtalk', { tg_bot_token: 'https://oapi.dingtalk.com/robot/send?access_token=private' }],
    ['bark', { tg_bot_token: 'bark:https://api.day.app/private' }],
    ['wecom', { tg_bot_token: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=private' }],
    ['serverchan', { tg_bot_token: 'server:https://sctapi.ftqq.com/private.send' }],
    ['wxpusher', { tg_bot_token: 'https://wxpusher.zjiecode.com/api/send/message/SPT_private' }],
    ['gotify', { tg_bot_token: 'https://gotify.example/message?token=private' }],
    ['telegram', { tg_bot_token: 'private-telegram-token', tg_chat_id: 'private-chat-id' }]
  ];

  globalThis.fetch = async () => new Response('', { status: 200 });

  try {
    for (const [provider, settings] of cases) {
      const result = await sendNotification(settings, 'compatibility test');
      assert.equal(result.success, true);
      assert.equal(result.provider, provider);
      assert.equal(result.attempts, 1);
      assert.equal(result.error, null);
      assert.equal(JSON.stringify(result).includes('private'), false);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Feishu app mode obtains a tenant token and sends a direct text message', async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/tenant_access_token/internal')) {
      return new Response(JSON.stringify({
        code: 0,
        tenant_access_token: 'private-tenant-token',
        expire: 7200
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ code: 0, msg: 'success' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const result = await sendNotification(
      { notification_provider: 'feishu_app' },
      'private app message',
      {
        env: {
          FEISHU_APP_ID: 'cli_test',
          FEISHU_APP_SECRET: 'private-app-secret',
          FEISHU_RECEIVE_ID: 'on_private_union_id',
          FEISHU_RECEIVE_ID_TYPE: 'union_id'
        }
      }
    );
    assert.equal(result.success, true);
    assert.equal(result.provider, 'feishu_app');
    assert.equal(requests.length, 2);
    assert.match(requests[1].url, /receive_id_type=union_id/);
    const messageBody = JSON.parse(requests[1].options.body);
    assert.equal(messageBody.receive_id, 'on_private_union_id');
    assert.equal(messageBody.msg_type, 'text');
    const content = JSON.parse(messageBody.content);
    assert.match(content.text, /Cloudflare Server Monitor/);
    assert.match(content.text, /private app message/);
    assert.equal(JSON.stringify(result).includes('private'), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
