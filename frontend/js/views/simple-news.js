/*
 * 3.0 Simple view task: "Show news headlines" (#/simple/news).
 *
 *   1. Which news? — paste a site or a feed, Find (components/news-feed-picker.js)
 *   2. How should it look? — headlines with pictures, or a scrolling ticker
 *   3. Which screens? — add to what they show, or replace it
 *   4. Done
 *
 * It makes an ordinary news widget (type 'rss', the same one Advanced view's Widgets page edits) and
 * puts it on screens through simple-home.js showOnScreen — the path every Simple task uses — so the
 * release gate (review) applies. The server reads the feed (lib/news-feed); screens never contact
 * the news site.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { shell, guideFrame, showOnScreen } from './simple-home.js';
import { mountFeedPicker } from '../components/news-feed-picker.js';

const DWELL_SEC = 30;

function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export async function renderNews(container) {
  let devices = [];
  let playlists = [];
  try { [devices, playlists] = await Promise.all([api.getDevices(), api.getPlaylists()]); } catch { /* shown as no screens */ }
  const total = 4;
  let choice = { feed_url: '', feed_mode: 'feed' };
  let layout = 'headlines';
  const paint = (inner) => shell(container, inner);
  const wireBack = (fn) => container.querySelector('[data-guide-back]')?.addEventListener('click', fn);

  // ------------------------------------------------------------------ 1. which news
  function sourceStep() {
    paint(guideFrame({ step: 0, total, icon: '&#128240;', title: t('news.simple.source_title'), back: false,
      next: true, nextLabel: t('onboarding.next'),
      body: `<p class="simple-lead">${esc(t('news.simple.source_lead'))}</p><div data-picker></div><p class="simple-status" data-status role="status"></p>` }));
    const next = container.querySelector('[data-guide-next]');
    const sync = (c) => { choice = c; next.disabled = !c.feed_url; };
    mountFeedPicker(container.querySelector('[data-picker]'), { url: choice.feed_url, mode: choice.feed_mode, simple: true, onChange: sync });
    sync(choice);
    next.addEventListener('click', () => { if (choice.feed_url) lookStep(); });
  }

  // ------------------------------------------------------------------ 2. how it looks
  function lookStep() {
    paint(guideFrame({ step: 1, total, icon: '&#127912;', title: t('news.simple.look_title'),
      next: true, nextLabel: t('onboarding.next'),
      body: `
        <div class="simple-choice" role="radiogroup" aria-label="${esc(t('news.field.layout'))}">
          <label><input type="radio" name="newsLook" value="headlines" ${layout === 'headlines' ? 'checked' : ''}> <span><strong>${esc(t('news.layout.headlines'))}</strong><small>${esc(t('news.simple.headlines_desc'))}</small></span></label>
          <label><input type="radio" name="newsLook" value="ticker" ${layout === 'ticker' ? 'checked' : ''}> <span><strong>${esc(t('news.layout.ticker'))}</strong><small>${esc(t('news.simple.ticker_desc'))}</small></span></label>
        </div>` }));
    wireBack(sourceStep);
    container.querySelectorAll('input[name="newsLook"]').forEach((r) => r.addEventListener('change', () => { layout = r.value; }));
    container.querySelector('[data-guide-next]').addEventListener('click', screensStep);
  }

  // ------------------------------------------------------------------ 3. which screens
  function screensStep() {
    let how = 'add';
    paint(guideFrame({ step: 2, total, icon: '&#128250;', title: t('news.simple.where_title'),
      next: true, nextLabel: t('news.simple.show_btn'),
      body: devices.length ? `
        <div class="simple-checks">${devices.map((d) => `
          <label><input type="checkbox" value="${esc(d.id)}" checked> <span>${esc(d.name)}</span>
          <small class="simple-screen-status ${d.status === 'online' ? 'on' : 'off'}">${esc(d.status === 'online' ? t('simple.status.online') : t('simple.status.offline'))}</small></label>`).join('')}</div>
        <div class="simple-choice" role="radiogroup" aria-label="${esc(t('simple.change.how_label'))}">
          <label><input type="radio" name="newsHow" value="add" checked> <span><strong>${esc(t('simple.change.add'))}</strong><small>${esc(t('news.simple.how_add_desc'))}</small></span></label>
          <label><input type="radio" name="newsHow" value="replace"> <span><strong>${esc(t('simple.change.replace'))}</strong><small>${esc(t('news.simple.how_replace_desc'))}</small></span></label>
        </div>
        <p class="simple-status" data-status role="status"></p>`
        : `<p class="simple-lead">${esc(t('news.simple.no_screens'))}</p><p class="simple-status" data-status role="status"></p>` }));
    wireBack(lookStep);
    container.querySelectorAll('input[name="newsHow"]').forEach((r) => r.addEventListener('change', () => { how = r.value; }));
    container.querySelector('[data-guide-next]').addEventListener('click', () => {
      const ids = [...container.querySelectorAll('.simple-checks input:checked')].map((i) => i.value);
      make(ids, how, container.querySelector('[data-status]'));
    });
  }

  async function make(deviceIds, how, status) {
    const controls = [...container.querySelectorAll('button, input')];
    controls.forEach((b) => { b.disabled = true; });
    status.textContent = t('simple.working');
    let widget;
    try {
      widget = await api.createWidget({
        widget_type: 'rss',
        name: t('news.simple.widget_name', { name: hostLabel(choice.feed_url) || choice.feed_url }),
        config: {
          ...choice, layout, max_items: 10, interval_sec: 10, scroll_speed: 30, show_images: true,
          font_size: layout === 'headlines' ? 32 : 28, color: '#FFFFFF', background: '#000000',
        },
      });
    } catch (err) {
      controls.forEach((b) => { b.disabled = false; });
      status.textContent = (err && err.message) || t('news.simple.err_save');
      return;
    }
    let shown = 0;
    let review = false;
    try {
      const seen = new Set();
      for (const id of deviceIds) {
        const d = devices.find((x) => x.id === id);
        if (!d) continue;
        // Screens that share one list are updated once, as Make a sign does.
        if (how === 'add' && d.playlist_id && seen.has(d.playlist_id)) { shown++; continue; }
        if (d.playlist_id) seen.add(d.playlist_id);
        const r = await showOnScreen(d, [{ widget_id: widget.id, duration_sec: DWELL_SEC }], how,
          { devices, playlists, note: `News headlines: ${widget.name}` });
        review = review || !!r.review;
        shown++;
      }
    } catch (err) {
      controls.forEach((b) => { b.disabled = false; });
      const reason = (err && err.message) || '';
      status.textContent = t('news.simple.err_assign', { reason });
      return;
    }
    doneStep(shown, review);
  }

  // ------------------------------------------------------------------ 4. done
  function doneStep(shown, review) {
    const lead = !shown ? t('news.simple.done_saved') : review ? tn('simple.upload.review_on', shown) : tn('news.simple.done_live', shown);
    paint(guideFrame({ step: 3, total, icon: !shown ? '&#9989;' : review ? '&#9203;' : '&#127881;', back: false,
      title: t(!shown ? 'news.simple.done_saved_title' : review ? 'simple.done.review_title' : 'onboarding.step.done.title'),
      body: `<p class="simple-lead">${esc(lead)}</p>
        ${shown ? `<p class="simple-muted">${esc(t(review ? 'simple.done.review_hint' : 'simple.done.seconds'))}</p>` : ''}
        <p class="simple-muted">${esc(t('news.simple.edit_later'))}</p>
        <div class="simple-done-actions">
          <a class="btn btn-primary" href="#/">${esc(t('simple.done.home'))}</a>
          ${!devices.length ? `<a class="btn btn-secondary" href="#/add-screen">${esc(t('simple.task.add'))}</a>` : ''}
        </div>` }));
    if (shown && !review) api.trackEvent('first_publish', { from: 'simple_news' });
  }

  sourceStep();
}
