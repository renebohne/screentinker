'use strict';

/*
 * A workspace's brand kit: business name, logo, up to three colours and a headline font.
 *
 * It exists for Make a sign (lib/sign-templates.js): every built-in template is pre-filled with the
 * business name and themed with these colours, so a sign comes out on-brand without anybody
 * touching a colour picker. It is deliberately small — this is not white-label branding (that is the
 * ORGANIZATION's dashboard look, lib/branding.js); it is what the business puts on its own screens.
 *
 * ⚠️ PER WORKSPACE, AND EVERY READ IS SCOPED BY IT. Two workspaces in one organization are often two
 * different shops. The logo is a content row and is resolved only inside the kit's own workspace,
 * both here and in the slide renderer (routes/widgets.js imageResolverFor), so naming another
 * workspace's image id stores nothing and renders nothing.
 */

const slideFonts = require('./slide-fonts');

const MAX_NAME = 80;
const MAX_COLORS = 3;

function hex6(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s.slice(1).split('').map((c) => c + c).join('')).toUpperCase();
  return null;
}

const trimNulls = (a) => { const out = a.slice(); while (out.length && out[out.length - 1] == null) out.pop(); return out; };

const EMPTY = Object.freeze({ business_name: '', logo_content_id: null, colors: [], font: null, updated_at: null });

/** A logo id that names an image in THIS workspace, or null. */
function validLogo(db, workspaceId, id) {
  if (typeof id !== 'string' || !id || id.length > 64) return null;
  const row = db.prepare('SELECT id, mime_type FROM content WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  return row && /^image\//.test(row.mime_type || '') ? row.id : null;
}

/** The kit for a workspace, always in the full shape (EMPTY when none has been saved). */
function getKit(db, workspaceId) {
  if (!workspaceId) return { ...EMPTY };
  const row = db.prepare('SELECT * FROM brand_kits WHERE workspace_id = ?').get(workspaceId);
  if (!row) return { ...EMPTY };
  let colors = [];
  try { colors = JSON.parse(row.colors || '[]'); } catch { colors = []; }
  return {
    business_name: row.business_name || '',
    logo_content_id: validLogo(db, workspaceId, row.logo_content_id),
    colors: trimNulls((Array.isArray(colors) ? colors : []).slice(0, MAX_COLORS).map(hex6)),
    font: row.font && Object.prototype.hasOwnProperty.call(slideFonts.FAMILIES, row.font) ? row.font : null,
    updated_at: row.updated_at,
  };
}

/**
 * Validate an edit. Returns { kit, errors }; a field that is absent keeps its current value, so a
 * client can save only the colours without re-sending the logo.
 */
function normalizeKit(db, workspaceId, input, current = getKit(db, workspaceId)) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const errors = [];
  const kit = { ...current };

  if (has('business_name')) {
    const s = String(src.business_name == null ? '' : src.business_name)
      .replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    if (s.length > MAX_NAME) errors.push({ field: 'business_name', code: 'too_long' });
    kit.business_name = s.slice(0, MAX_NAME);
  }
  if (has('logo_content_id')) {
    if (src.logo_content_id == null || src.logo_content_id === '') kit.logo_content_id = null;
    else {
      const id = validLogo(db, workspaceId, src.logo_content_id);
      if (!id) errors.push({ field: 'logo_content_id', code: 'invalid' });
      kit.logo_content_id = id;
    }
  }
  if (has('colors')) {
    const list = Array.isArray(src.colors) ? src.colors : [];
    if (!Array.isArray(src.colors) || list.length > MAX_COLORS) errors.push({ field: 'colors', code: 'invalid' });
    /*
     * ⚠️ POSITIONAL: [background, accent, extra]. An unset colour is kept as null rather than
     * dropped, or clearing the background would quietly promote the accent into its place and
     * every sign would change colour scheme.
     */
    const out = list.slice(0, MAX_COLORS).map((c) => {
      if (c == null || c === '') return null;
      const h = hex6(c);
      if (!h) errors.push({ field: 'colors', code: 'invalid' });
      return h;
    });
    kit.colors = trimNulls(out);
  }
  if (has('font')) {
    if (src.font == null || src.font === '') kit.font = null;
    else if (Object.prototype.hasOwnProperty.call(slideFonts.FAMILIES, src.font)) kit.font = src.font;
    else errors.push({ field: 'font', code: 'invalid' });
  }
  return { kit, errors };
}

function saveKit(db, workspaceId, kit, userId) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO brand_kits (workspace_id, business_name, logo_content_id, colors, font, updated_by, updated_at)
              VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(workspace_id) DO UPDATE SET business_name = excluded.business_name,
                logo_content_id = excluded.logo_content_id, colors = excluded.colors, font = excluded.font,
                updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(workspaceId, kit.business_name || '', kit.logo_content_id || null, JSON.stringify(kit.colors || []),
      kit.font || null, userId || null, now);
  return getKit(db, workspaceId);
}

module.exports = { getKit, normalizeKit, saveKit, MAX_COLORS, MAX_NAME };
