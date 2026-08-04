import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { mimeFor } from '../services/mime.js';
import { sendFileWithRange } from '../services/httpfile.js';
import * as plugins from '../services/plugins.js';

export const pluginsRouter = Router();
pluginsRouter.use(requireAuth);

// Catalog discovery has its own static mount (`/api/community-plugins`) so a
// reverse proxy cannot accidentally turn a catalog request into the installed
// plugin list by dropping `?view=catalog`.
export const communityPluginsRouter = Router();
communityPluginsRouter.use(requireAuth);
communityPluginsRouter.get('/', asyncHandler(async (_req, res) => {
  const catalog = await plugins.listCommunityPlugins();
  res.json({ plugins: catalog, total: catalog.length, source: 'obsidian-community' });
}));
communityPluginsRouter.get('/:id/readme', asyncHandler(async (req, res) => {
  res.json({ readme: await plugins.getCommunityPluginReadme(req.params.id) });
}));

pluginsRouter.get('/', asyncHandler(async (req, res) => {
  // Keep catalog discovery on the same endpoint that lists installed plugins.
  // Some reverse proxies only forward the exact `/api/plugins/` location. Use
  // a request header for Browse so a proxy dropping the query string cannot
  // silently turn the catalog into the installed-plugin list.
  if (req.get('X-WebObsidian-Plugin-View') === 'catalog' || req.query.view === 'catalog') {
    const catalog = await plugins.listCommunityPlugins();
    res.json({ plugins: catalog, total: catalog.length, source: 'obsidian-community' });
    return;
  }
  res.json({ plugins: await plugins.listInstalled() });
}));

pluginsRouter.get(
  '/catalog',
  asyncHandler(async (_req, res) => {
    const catalog = await plugins.listCommunityPlugins();
    res.json({ plugins: catalog, total: catalog.length, source: 'obsidian-community' });
  }),
);

// Alias README through the established /api/plugins router. Deployments that
// whitelist this API prefix can use Browse without adding a proxy location.
pluginsRouter.get('/:id/readme', asyncHandler(async (req, res) => {
  res.json({ readme: await plugins.getCommunityPluginReadme(req.params.id) });
}));

pluginsRouter.post(
  '/install',
  asyncHandler(async (req, res) => {
    const repo = String(req.body?.repo ?? '');
    if (!repo) {
      res.status(400).json({ error: 'repo required (owner/name)' });
      return;
    }
    res.json({ plugin: await plugins.installFromGithub(repo) });
  }),
);

pluginsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, ...await plugins.uninstall(req.params.id) });
  }),
);

pluginsRouter.patch(
  '/:id/enabled',
  asyncHandler(async (req, res) => {
    const result = await plugins.setEnabled(req.params.id, Boolean(req.body?.enabled));
    res.json({ ok: true, ...result });
  }),
);

pluginsRouter.get(
  '/:id/data',
  asyncHandler(async (req, res) => {
    res.json({ data: await plugins.readPluginData(req.params.id) });
  }),
);

pluginsRouter.put(
  '/:id/data',
  asyncHandler(async (req, res) => {
    await plugins.writePluginData(req.params.id, req.body?.data);
    res.json({ ok: true });
  }),
);

// CSP-safe CommonJS-to-ESM wrapper. The loader stays same-origin and never uses
// eval itself; individual trusted plugin bundles may request dynamic-code CSP.
pluginsRouter.get(
  '/:id/module.js',
  asyncHandler(async (req, res) => {
    res
      .setHeader('Content-Type', 'application/javascript; charset=utf-8')
      .setHeader('Cache-Control', 'no-cache')
      .send(await plugins.getPluginModule(req.params.id));
  }),
);

// Serve top-level plugin assets. Nested assets use the wildcard route below.
pluginsRouter.get(
  '/:id/:asset',
  asyncHandler(async (req, res) => {
    const asset = req.params.asset;
    const file = await plugins.getPluginFilePath(req.params.id, asset);
    await sendFileWithRange(req, res, file, mimeFor(asset));
  }),
);


// CSS and plugin UIs commonly reference fonts/images relative to styles.css.
// Serve nested resources after every API route above, with path + symlink guards
// enforced by the service.
pluginsRouter.get(
  '/:id/*',
  asyncHandler(async (req, res) => {
    const relative = String(req.params[0] ?? '');
    const file = await plugins.getPluginFilePath(req.params.id, relative);
    await sendFileWithRange(req, res, file, mimeFor(relative));
  }),
);
