// @vitest-environment happy-dom

/**
 * Uninstall must be exactly one server call. The earlier implementation
 * disabled the plugin first and only then sent DELETE, so any failure of the
 * DELETE (a server without the route, a proxy stripping the verb, a network
 * blip) left the plugin disabled but still installed — reported as
 * "Uninstall only disables the plugin".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializePluginRuntime, getPluginRuntimeSnapshot, uninstallPlugin } from './plugins';

interface Call { method: string; url: string }

function mockServer(deleteResponse: () => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (method === 'DELETE') return Promise.resolve(deleteResponse());
    return Promise.resolve(Response.json({ ok: true, reloadRequired: false, plugins: [] }));
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('uninstallPlugin', () => {
  it('sends DELETE only — never a disable request first', async () => {
    initializePluginRuntime();
    const calls = mockServer(() => Response.json({ ok: true, reloadRequired: false }));

    await uninstallPlugin('notebook-navigator');

    expect(calls).toEqual([
      { method: 'DELETE', url: '/api/plugins/notebook-navigator' },
    ]);
    // Specifically: no PATCH .../enabled, which is what used to strand the
    // plugin in the disabled-but-installed state.
    expect(calls.some((call) => call.url.endsWith('/enabled'))).toBe(false);
  });

  it('drops the plugin from the runtime snapshot', async () => {
    initializePluginRuntime();
    mockServer(() => Response.json({ ok: true, reloadRequired: false }));

    await uninstallPlugin('notebook-navigator');

    expect(getPluginRuntimeSnapshot().plugins['notebook-navigator']).toBeUndefined();
  });

  it('propagates a failed uninstall instead of reporting success', async () => {
    initializePluginRuntime();
    // Exactly what a server built before the DELETE route existed returns:
    // Express' HTML 404, which carries no JSON `error` field.
    const calls = mockServer(() => new Response('<!DOCTYPE html><pre>Cannot DELETE</pre>', {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));

    await expect(uninstallPlugin('notebook-navigator')).rejects.toThrow(/Not Found/);
    // The plugin must not have been disabled as a side effect of failing.
    expect(calls.some((call) => call.url.endsWith('/enabled'))).toBe(false);
  });
});
