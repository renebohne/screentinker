/*
 * 3.0: simple vs full menu.
 *
 * A new account sees about ten menu items (screens, content, playlists, schedule, templates, slides,
 * reports, members, settings, subscription) instead of twenty-five; the power-user surfaces — video
 * walls, layouts, approvals, widgets, kiosk, automation, data sources, audience... — are marked
 * `data-advanced` in index.html and hidden by `html.ui-simple`, which nav-prime.js sets from the
 * cached user before first paint so the full menu never flashes. Nothing is removed: every page
 * still opens from a link or bookmark, and the Simple | Advanced switch at the top of
 * the menu shows them all. Simple also hides power-user controls INSIDE pages (data-advanced-ui).
 *
 * The choice is per ACCOUNT (users.ui_mode, via /api/auth/me), so it follows the person to a new
 * browser. Accounts that existed before 3.0 were migrated to 'advanced' and see no change. A user
 * object without the field (an older server, a stale cache) is treated as advanced for the same
 * reason: never hide something from someone who did not ask.
 */
import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from './toast.js';
import { inManagerApp, openOutsideApp } from '../utils.js';

export function uiModeOf(user) {
  // The Manager app is the Simple view by definition; the account's setting governs the browser.
  if (inManagerApp()) return 'simple';
  return user && user.ui_mode === 'simple' ? 'simple' : 'advanced';
}

export function isSimpleMode() {
  return document.documentElement.classList.contains('ui-simple');
}

function setBodyMode(mode) {
  const simple = mode === 'simple';
  if (document.documentElement.classList.contains('ui-simple') === simple) return;
  document.documentElement.classList.toggle('ui-simple', simple);
  // nav-groups.js re-counts which groups still have a visible link.
  window.dispatchEvent(new CustomEvent('st:ui-mode', { detail: { mode } }));
}

let bound = false;

/** Apply the user's view to the shell and keep the switch in step. Safe to call on every /me. */
export function applyUiMode(user) {
  if (!user) return;
  const mode = uiModeOf(user);
  setBodyMode(mode);
  const sw = document.getElementById('uiModeSwitch');
  if (!sw) return;
  sw.hidden = false;
  paintSwitch(sw, mode);
  if (bound) return;
  bound = true;
  sw.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ui-mode]');
    if (btn) setUiMode(btn.dataset.uiMode);
  });
  // Arrow keys move between the two options, as a radiogroup should.
  sw.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const other = sw.querySelector('[aria-checked="false"]');
    if (other) { other.click(); other.focus(); }
  });
}

/**
 * Switch view for this account: the page answers at once (optimistic), the server catches up.
 * setBodyMode dispatches st:ui-mode, which app.js re-routes on — Simple's guide-style home and the
 * full dashboard are different views of #/.
 */
export async function setUiMode(next) {
  if (next !== 'simple' && next !== 'advanced') return;
  // In the Manager app, Advanced is the full dashboard in the phone's browser (#/switch-advanced
  // turns Advanced on for this account there, then lands on the dashboard).
  if (inManagerApp()) { if (next === 'advanced') openOutsideApp('/app#/switch-advanced'); return; }
  if (next === (isSimpleMode() ? 'simple' : 'advanced')) return;
  try {
    const cached = JSON.parse(localStorage.getItem('user') || '{}');
    localStorage.setItem('user', JSON.stringify({ ...cached, ui_mode: next }));
  } catch { /* cache is a convenience */ }
  setBodyMode(next);
  const sw = document.getElementById('uiModeSwitch');
  if (sw) paintSwitch(sw, next);
  showToast(t(next === 'advanced' ? 'nav.view_advanced_on' : 'nav.view_simple_on'), 'info');
  try { await api.updateMe({ ui_mode: next }); } catch { /* kept locally until the next /me */ }
}

function paintSwitch(sw, mode) {
  sw.querySelectorAll('[data-ui-mode]').forEach((b) => {
    const on = b.dataset.uiMode === mode;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
}
