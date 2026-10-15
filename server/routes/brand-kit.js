const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { denyReadOnly } = require('../lib/tenancy');
const { auditFromReq } = require('../lib/audit');
const brandKit = require('../lib/brand-kit');
const slideFonts = require('../lib/slide-fonts');

/*
 * The workspace brand kit (lib/brand-kit.js). Always the CALLER'S ACTIVE workspace — there is no id
 * in the URL to point at somebody else's, which is the whole IDOR story for this router.
 *
 * Read: any member (a view-only member sees the kit their signs use). Write: editors and admins;
 * a workspace_viewer is refused by denyReadOnly, like every other write in the product.
 */

const canEdit = (req) => !(req.workspaceRole === 'workspace_viewer' && !req.actingAs);

function present(req, kit) {
  return {
    kit,
    /*
     * The logo's own file, for the editor to show. Not the library thumbnail: thumbnails are
     * flattened JPEGs, so a transparent logo would preview on a black box it does not have on a
     * sign. Resolved through the same workspace-scoped lookup the slide renderer uses.
     */
    logo_url: kit.logo_content_id ? require('./widgets').imageResolverFor({ workspace_id: req.workspaceId })(kit.logo_content_id) : null,
    can_edit: canEdit(req),
    // The families a kit may name — the bundled slide fonts, so a sign renders identically everywhere.
    fonts: slideFonts.catalogue().map((f) => ({ id: f.id, label: f.label, role: f.role, css: f.css, stack: f.stack, file: f.file, weights: f.weights })),
  };
}

router.get('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  res.json(present(req, brandKit.getKit(db, req.workspaceId)));
});

router.put('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  if (denyReadOnly(req, res)) return;
  const { kit, errors } = brandKit.normalizeKit(db, req.workspaceId, req.body);
  if (errors.length) return res.status(400).json({ error: 'Some brand kit values are not valid.', errors });
  const saved = brandKit.saveKit(db, req.workspaceId, kit, req.user && req.user.id);
  auditFromReq(req, 'brand_kit:update', {
    workspace_id: req.workspaceId,
    has_logo: !!saved.logo_content_id, colors: saved.colors.length, font: saved.font,
  });
  res.json(present(req, saved));
});

module.exports = router;
