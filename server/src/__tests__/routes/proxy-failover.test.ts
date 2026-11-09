import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

function completion(model: string, content: string) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      id: 'chatcmpl-failover',
      object: 'chat.completion',
      created: 123,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
  } as any;
}

function httpError(status: number, message: string) {
  return {
    ok: false,
    status,
    statusText: message,
    json: () => Promise.resolve({ error: { message } }),
    text: () => Promise.resolve(JSON.stringify({ error: { message } })),
  } as any;
}

/**
 * Mocks only outbound provider calls (any `/chat/completions` URL that is not
 * the local proxy itself). `handler` decides each provider's response; every
 * provider hostname hit is recorded in order.
 */
function mockProviders(handler: (host: string) => any) {
  const origFetch = global.fetch;
  const calls: string[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const { hostname } = new URL(urlStr);
    if (hostname !== '127.0.0.1' && urlStr.includes('/chat/completions')) {
      calls.push(hostname);
      return handler(hostname);
    }
    return origFetch(url, init);
  });
  return calls;
}

const chatBody = { messages: [{ role: 'user', content: 'Bonjour' }] };

describe('Proxy failover between providers', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    // Cooldowns live in a table when present; clear so tests stay independent.
    try { db.prepare('DELETE FROM cooldowns').run(); } catch { /* table may not exist */ }

    for (const [platform, key] of [['groq', 'gsk_failover_test'], ['cerebras', 'csk_failover_test']]) {
      const added = await request(app, 'POST', '/api/keys', { platform, key, label: `failover-${platform}` });
      expect(added.status).toBe(201);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to another provider when the first one is rate-limited (429)', async () => {
    // Whichever provider the router picks first is rate-limited on every model;
    // any other provider answers. Independent of the router's ranking order.
    const hostToPlatform: Record<string, string> = { 'api.groq.com': 'groq', 'api.cerebras.ai': 'cerebras' };
    let failingHost: string | undefined;
    const calls = mockProviders((host) => {
      failingHost ??= host;
      return host === failingHost
        ? httpError(429, 'Too Many Requests')
        : completion('fallback-model', 'Réponse de secours');
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', chatBody);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('Réponse de secours');
    const routedPlatform = headers.get('x-routed-via')?.split('/')[0];
    expect(routedPlatform).toBeDefined();
    expect(routedPlatform).not.toBe(hostToPlatform[failingHost!]);
    expect(Number(headers.get('x-fallback-attempts'))).toBeGreaterThanOrEqual(1);
    // Failed attempts on the first provider, then exactly one successful call elsewhere.
    expect(calls[0]).toBe(failingHost);
    expect(calls.filter((h) => h !== failingHost)).toHaveLength(1);
  });

  it('does not fall back on a non-retryable error (401) and returns 502', async () => {
    const calls = mockProviders(() => httpError(401, 'Invalid API key'));

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', chatBody);

    expect(status).toBe(502);
    expect(body.error.type).toBe('provider_error');
    expect(calls).toHaveLength(1);
  });

  it('returns 429 rate_limit_error when every provider is rate-limited', async () => {
    const calls = mockProviders(() => httpError(429, 'Too Many Requests'));

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', chatBody);

    expect(status).toBe(429);
    expect(body.error.type).toBe('rate_limit_error');
    expect(calls).toContain('api.groq.com');
    expect(calls).toContain('api.cerebras.ai');
  });
});
