/*
 * "What will this screen show at…?" — the device page's Preview at… tab (docs/preview-at-time.md).
 *
 * Pick a moment (in the SCREEN's own time zone, which is the clock its schedules run on) and see:
 *   - the content, in the real player in device-free preview mode, sized to the screen's
 *     orientation — the same renderer the existing Preview uses (#104), fed the payload the server
 *     resolves for that instant (GET /api/devices/:id/simulate/payload);
 *   - why: which schedule, group, wall or head office decision won, and what was left out and why
 *     (GET /api/devices/:id/simulate);
 *   - a strip of the day or week (GET /api/devices/:id/timeline) whose segments jump the picker.
 *
 * Read-only. Every server string reaches the page through esc() or textContent.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { frameDeviceOutput, displayAspectRatio } from '../lib/device-frame.js';

// Categorical slots in fixed order (validated dark-surface palette); a playlist keeps its slot for
// as long as the panel is open, so a range change never repaints one playlist as another.
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const WEATHER = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm'];

const pad = (n) => String(n).padStart(2, '0');

/** The UTC offset (ms) of zone `tz` at instant `ms`; tz falsy = this browser's zone. */
function zoneOffset(ms, tz) {
  if (!tz) return -new Date(ms).getTimezoneOffset() * 60000;
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))) p[part.type] = part.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

/** "YYYY-MM-DDTHH:MM" wall time in `tz` -> UTC ms. Two passes settle a DST edge. */
function wallToUtc(stamp, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(stamp || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let ms = guess - zoneOffset(guess, tz);
  const off2 = zoneOffset(ms, tz);
  if (guess - off2 !== ms) ms = guess - off2;
  return ms;
}

function utcToWall(ms, tz) {
  const d = new Date(ms + zoneOffset(ms, tz));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "Mon 14 Oct, 09:00" for a wall stamp, in the viewer's language. */
function wallLabel(stamp, withDate = true) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(stamp || '');
  if (!m) return stamp || '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const opts = withDate ? { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }
    : { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' };
  return d.toLocaleString(undefined, opts);
}

function sourceText(src) {
  return t(`forecast.source.${src || 'none'}`);
}

/** One explanation line per fallback step, in plain words. */
function fallbackLine(s) {
  const vars = { playlist: s.playlist || '—', group: s.group || '—', wall: s.wall || '—', priority: s.priority ?? 0 };
  return t(`forecast.fallback.${s.code}`, vars);
}

function scheduleLine(s, tzLabel) {
  const vars = { title: s.title || t('forecast.untitled'), playlist: s.playlist || '—', priority: s.priority, scope: t(`forecast.scope.${s.scope}`), tz: tzLabel };
  return t(`forecast.schedule.${s.state}`, vars);
}

/**
 * Mount the panel into `host`. Returns a cleanup function.
 * @param {HTMLElement} host
 * @param {{id:string, name:string, orientation?:string}} device
 */
export function mountPreviewAtTime(host, device) {
  let tz = null;            // the screen's zone, learned from the first answer
  let atMs = Date.now();
  let range = 'day';        // 'day' | 'week'
  let weather = '';
  let seq = 0;              // drops answers to questions that are no longer the latest
  const colors = new Map();
  const colorOf = (key) => {
    if (!key) return null;
    if (!colors.has(key)) colors.set(key, colors.size < SERIES.length ? SERIES[colors.size] : 'var(--text-muted)');
    return colors.get(key);
  };

  host.innerHTML = `
    <div class="pat">
      <p class="pat-intro">${esc(t('forecast.intro'))}</p>
      <div class="pat-controls">
        <label class="pat-field"><span>${esc(t('forecast.when'))}</span>
          <input type="datetime-local" class="input" id="patWhen" step="60"></label>
        <span class="pat-tz" id="patTz"></span>
        <div class="pat-quick">
          <button type="button" class="btn btn-secondary btn-sm" data-quick="now">${esc(t('forecast.quick.now'))}</button>
          <button type="button" class="btn btn-secondary btn-sm" data-quick="tomorrow9">${esc(t('forecast.quick.tomorrow9'))}</button>
          <button type="button" class="btn btn-secondary btn-sm" data-quick="monday9">${esc(t('forecast.quick.monday9'))}</button>
        </div>
        <label class="pat-field"><span>${esc(t('forecast.weather'))}</span>
          <select class="input" id="patWeather">
            <option value="">${esc(t('forecast.weather.current'))}</option>
            ${WEATHER.map((w) => `<option value="${w}">${esc(t(`forecast.weather.${w}`))}</option>`).join('')}
          </select></label>
      </div>
      <div class="pat-strip-head">
        <strong id="patRangeLabel"></strong>
        <div class="pat-range" role="radiogroup" aria-label="${esc(t('forecast.range'))}">
          <button type="button" class="btn btn-sm btn-primary" data-range="day" role="radio" aria-checked="true">${esc(t('forecast.range.day'))}</button>
          <button type="button" class="btn btn-sm btn-secondary" data-range="week" role="radio" aria-checked="false">${esc(t('forecast.range.week'))}</button>
        </div>
      </div>
      <div class="pat-strip" id="patStrip" role="list" aria-label="${esc(t('forecast.timeline'))}"></div>
      <div class="pat-axis" id="patAxis" aria-hidden="true"></div>
      <div class="pat-legend" id="patLegend"></div>
      <div class="pat-body">
        <div class="pat-frame-col">
          <div class="pat-stage-wrap">
            <div class="pat-stage" id="patStage" style="aspect-ratio:${displayAspectRatio(device.orientation)}">
              <iframe id="patFrame" title="${esc(t('forecast.frame_title'))}" style="border:0;background:#000"></iframe>
            </div>
            <div class="pat-overlay" id="patOverlay" hidden></div>
          </div>
          <p class="pat-frame-note">${esc(t('forecast.frame_note'))}</p>
        </div>
        <div class="pat-explain" id="patExplain" aria-live="polite"><p class="pat-muted">${esc(t('common.loading'))}</p></div>
      </div>
    </div>`;

  const $ = (sel) => host.querySelector(sel);
  const when = $('#patWhen');
  const frame = $('#patFrame');
  const stage = $('#patStage');
  frameDeviceOutput(stage, frame, device.orientation);

  function setWhen(ms) {
    atMs = ms;
    when.value = utcToWall(ms, tz);
  }

  async function refresh({ timelineToo = true } = {}) {
    const my = ++seq;
    const iso = new Date(atMs).toISOString();
    when.dataset.atIso = iso;   // the device page's group comparison reads the same moment
    const extra = weather ? { weather } : {};
    let sim;
    try {
      sim = await api.simulateDevice(device.id, iso, extra);
    } catch (err) {
      if (my === seq) $('#patExplain').innerHTML = `<p class="pat-warn">${esc(err.message)}</p>`;
      return;
    }
    if (my !== seq) return;
    const firstAnswer = tz === null;
    tz = sim.timezone || null;
    $('#patTz').textContent = sim.timezone ? t('forecast.tz', { tz: sim.timezone }) : t('forecast.tz_unknown');
    if (firstAnswer || document.activeElement !== when) when.value = utcToWall(atMs, tz);
    renderFrame(iso, sim);
    renderExplain(sim);
    if (timelineToo) loadTimeline();
    else markStrip();
  }

  function renderFrame(iso, sim) {
    const q = new URLSearchParams({ preview: '1', device: device.id, at: iso, t: String(Date.now()) });
    if (weather) q.set('weather', weather);
    frame.src = `/player?${q}`;
    const overlay = $('#patOverlay');
    let msg = '';
    if (sim.power && sim.power.off) msg = t('forecast.overlay.off');
    else if (!sim.playing && !sim.default_content) msg = t('forecast.overlay.nothing');
    overlay.hidden = !msg;
    overlay.textContent = msg;
  }

  function renderExplain(sim) {
    const tzLabel = sim.schedule_timezone || sim.timezone || t('forecast.server_clock');
    const lines = [];
    // Headline: what is on, in one sentence.
    const head = sim.power && sim.power.off ? t('forecast.head.off')
      : sim.resolved.playlist_id ? t('forecast.head.playing', { playlist: sim.resolved.playlist_name || '—', source: sourceText(sim.resolved.source) })
        : t('forecast.head.nothing');
    // Why: the schedules, then the fallback chain.
    for (const s of sim.schedules) lines.push(`<li class="pat-why pat-${esc(s.state)}">${esc(scheduleLine(s, tzLabel))}</li>`);
    if (!sim.schedules.length) lines.push(`<li class="pat-why">${esc(t('forecast.no_schedules'))}</li>`);
    for (const s of sim.fallback) lines.push(`<li class="pat-why">${esc(fallbackLine(s))}</li>`);

    const items = sim.items.map((it) => {
      const label = it.label || t('forecast.unnamed');
      const reason = it.reason ? t(`forecast.item.${it.reason}`, { at: it.expired_at ? new Date(it.expired_at).toLocaleString() : '', from: it.play_from || '', until: it.play_until || '' }) : t('forecast.item.plays');
      const warn = it.may_not_play ? `<span class="pat-badge pat-badge-warn" title="${esc(t('forecast.may_not_play_tip', { cap: it.may_not_play }))}">${esc(t('forecast.may_not_play'))}</span>` : '';
      return `<li class="${it.plays ? 'pat-on' : 'pat-off'}"><span class="pat-mark" aria-hidden="true">${it.plays ? '&#10003;' : '&#10005;'}</span><span class="pat-item-name">${esc(label)}</span> <span class="pat-muted">${esc(reason)}</span> ${warn}</li>`;
    }).join('');
    const skipped = sim.skipped.map((s) => {
      const why = s.reason === 'unsupported' ? t('forecast.skip.unsupported', { cap: s.capability || '' }) : t(`forecast.skip.${s.reason}`);
      return `<li class="pat-off"><span class="pat-mark" aria-hidden="true">&#10005;</span><span class="pat-item-name">${esc(s.label || t('forecast.unnamed'))}</span> <span class="pat-muted">${esc(why)}</span> <span class="pat-badge pat-badge-warn">${esc(t('forecast.not_on_player'))}</span></li>`;
    }).join('');

    const notes = [];
    if (sim.offline) notes.push(t('forecast.note.offline'));
    if (sim.timezone_assumed) notes.push(t('forecast.note.tz_assumed'));
    if (sim.power && sim.power.ignored) notes.push(t('forecast.note.power_ignored'));
    if (sim.default_content) notes.push(t('forecast.note.default_content', { name: sim.default_content.label || '' }));
    for (const k of sim.live_now || []) notes.push(t(`forecast.note.live_${k}`));
    if (sim.resolver_check === 'mismatch') notes.push(t('forecast.note.mismatch'));
    if (sim.weather && sim.weather.group) notes.push(t(sim.weather.assumed ? 'forecast.note.weather_assumed' : 'forecast.note.weather_current', { weather: t(`forecast.weather.${sim.weather.group}`) }));

    // 3.0 campaigns: the steps this screen switches between, or why it plays the simple version.
    const steps = sim.campaign && !sim.campaign.fallback ? sim.campaign.steps.map((s) => {
      const what = s.type === 'layout' ? t('campaign.step_layout', { name: s.label || '', zones: s.zones, items: s.items }) : (s.label || t('forecast.unnamed'));
      const reason = s.reason ? t(`forecast.item.${s.reason}`, { at: '', from: '', until: '' }) : t('forecast.item.plays');
      return `<li class="${s.plays ? 'pat-on' : 'pat-off'}"><span class="pat-mark" aria-hidden="true">${s.plays ? '&#10003;' : '&#10005;'}</span><span class="pat-item-name">${esc(what)}</span> <span class="pat-muted">${esc(reason)}${s.duration_sec ? ' · ' + esc(t('campaign.step_secs', { n: s.duration_sec })) : ''}</span></li>`;
    }).join('') : '';
    if (sim.campaign && sim.campaign.fallback) notes.push(t('campaign.forecast_fallback'));
    const triggers = (sim.triggers || []).map((tr) => `<li>${esc(tr.name || t('forecast.unnamed'))}${tr.kind === 'emergency' ? ` <span class="pat-badge">${esc(t('forecast.trigger_emergency'))}</span>` : ''}</li>`).join('');

    $('#patExplain').innerHTML = `
      <div class="pat-headline">
        <div class="pat-at">${esc(wallLabel(sim.local.items))}</div>
        <div>${esc(head)}</div>
        <div class="pat-muted">${esc(tn('forecast.playing_count', sim.playing, { total: sim.items.length }))}</div>
      </div>
      <h4>${esc(t('forecast.why'))}</h4><ul class="pat-list">${lines.join('')}</ul>
      ${steps ? `<h4>${esc(t('campaign.forecast_steps'))}</h4><ul class="pat-list pat-items">${steps}</ul>` : ''}
      <h4>${esc(steps ? t('campaign.forecast_fallback_items') : t('forecast.items'))}</h4>
      <ul class="pat-list pat-items">${items || `<li class="pat-muted">${esc(t('forecast.no_items'))}</li>`}${skipped}</ul>
      ${triggers ? `<h4>${esc(t('forecast.triggers'))}</h4><p class="pat-muted">${esc(t('forecast.triggers_note'))}</p><ul class="pat-list">${triggers}</ul>` : ''}
      ${notes.length ? `<ul class="pat-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
  }

  let segments = [];
  let tlFrom = 0, tlTo = 0;
  async function loadTimeline() {
    const my = seq;
    // The strip starts at the screen's local midnight of the chosen day.
    const day = utcToWall(atMs, tz).slice(0, 10) + 'T00:00';
    const fromMs = wallToUtc(day, tz);
    const toMs = fromMs + (range === 'week' ? 7 : 1) * 24 * 3600 * 1000;
    let tl;
    try {
      tl = await api.deviceTimeline(device.id, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), weather ? { weather } : {});
    } catch (err) {
      $('#patStrip').textContent = err.message;
      return;
    }
    if (my !== seq) return;
    segments = tl.segments || [];
    tlFrom = Date.parse(tl.from); tlTo = Date.parse(tl.to);
    $('#patRangeLabel').textContent = range === 'week'
      ? t('forecast.range_week_of', { day: wallLabel(day).replace(/,?\s*\d{1,2}:\d{2}.*$/, '') })
      : wallLabel(day).replace(/,?\s*\d{1,2}:\d{2}.*$/, '');
    drawStrip();
  }

  function drawStrip() {
    const span = tlTo - tlFrom || 1;
    const strip = $('#patStrip');
    strip.innerHTML = segments.map((s, i) => {
      const a = (Date.parse(s.from) - tlFrom) / span * 100;
      const w = (Date.parse(s.to) - Date.parse(s.from)) / span * 100;
      const off = s.power === 'off';
      const empty = !off && (!s.playlist_id || !s.playing) && !s.default_content;
      const color = off || empty ? null : colorOf(s.playlist_id);
      const name = off ? t('forecast.seg.off') : empty ? t('forecast.seg.nothing') : (s.playlist_name || '—');
      const tip = `${wallLabel(s.local)} — ${name}${s.schedule_title ? ` (${s.schedule_title})` : ''}${!off && !empty ? ` · ${tn('forecast.playing_count', s.playing, { total: s.total })}` : ''}`;
      const cls = off ? 'pat-seg pat-seg-off' : empty ? 'pat-seg pat-seg-empty' : 'pat-seg';
      return `<button type="button" role="listitem" class="${cls}" data-seg="${i}" style="left:${a.toFixed(3)}%;width:${Math.max(w, 0.15).toFixed(3)}%;${color ? `background:${color}` : ''}" title="${esc(tip)}" aria-label="${esc(tip)}">${w > 9 ? `<span>${esc(name)}</span>` : ''}</button>`;
    }).join('') + '<span class="pat-now" id="patMarker" aria-hidden="true"></span>';
    strip.querySelectorAll('[data-seg]').forEach((b) => b.addEventListener('click', () => {
      const s = segments[Number(b.dataset.seg)];
      if (!s) return;
      setWhen(Date.parse(s.from));
      refresh({ timelineToo: false });
    }));
    // Axis: hours for a day, days for a week, in the screen's wall clock.
    const ticks = [];
    const step = range === 'week' ? 24 : 6;
    for (let h = 0; h <= (range === 'week' ? 168 : 24); h += step) {
      const ms = tlFrom + h * 3600 * 1000;
      if (ms > tlTo) break;
      const lbl = range === 'week' ? wallLabel(utcToWall(ms, tz)).replace(/,?\s*\d{1,2}:\d{2}.*$/, '') : wallLabel(utcToWall(ms, tz), false);
      ticks.push(`<span style="left:${((ms - tlFrom) / span * 100).toFixed(3)}%">${esc(lbl)}</span>`);
    }
    $('#patAxis').innerHTML = ticks.join('');
    // Legend: every playlist in view plus the two non-content states, so identity is never colour alone.
    const seen = new Map();
    for (const s of segments) if (s.power !== 'off' && s.playlist_id && s.playing) seen.set(s.playlist_id, s.playlist_name || '—');
    $('#patLegend').innerHTML = [...seen].map(([id, name]) => `<span><i style="background:${colorOf(id)}"></i>${esc(name)}</span>`).join('')
      + `<span><i class="pat-sw-off"></i>${esc(t('forecast.seg.off'))}</span><span><i class="pat-sw-empty"></i>${esc(t('forecast.seg.nothing'))}</span>`;
    markStrip();
  }

  function markStrip() {
    const m = host.querySelector('#patMarker');
    if (!m) return;
    const inRange = atMs >= tlFrom && atMs < tlTo;
    m.hidden = !inRange;
    if (inRange) m.style.left = `${((atMs - tlFrom) / ((tlTo - tlFrom) || 1) * 100).toFixed(3)}%`;
  }

  when.addEventListener('change', () => {
    const ms = wallToUtc(when.value, tz);
    if (ms === null) return;
    const sameDay = utcToWall(ms, tz).slice(0, 10) === utcToWall(atMs, tz).slice(0, 10);
    atMs = ms;
    refresh({ timelineToo: !sameDay || !segments.length });
  });
  host.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.quick;
    if (k === 'now') { setWhen(Date.now()); return refresh(); }
    const today = utcToWall(Date.now(), tz).slice(0, 10);
    const base = Date.parse(today + 'T00:00:00Z');
    let add = 1;
    if (k === 'monday9') { const dow = new Date(base).getUTCDay(); add = ((8 - dow) % 7) || 7; }
    const d = new Date(base + add * 86400000).toISOString().slice(0, 10);
    setWhen(wallToUtc(`${d}T09:00`, tz));
    refresh();
  }));
  $('#patWeather').addEventListener('change', (e) => { weather = e.target.value; refresh(); });
  host.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
    range = b.dataset.range;
    host.querySelectorAll('[data-range]').forEach((x) => {
      const on = x.dataset.range === range;
      x.className = `btn btn-sm ${on ? 'btn-primary' : 'btn-secondary'}`;
      x.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    loadTimeline();
  }));

  refresh();
  return () => { seq++; host.innerHTML = ''; };
}

/*
 * Group / fleet variant: one row per screen in a group at one moment. Used from the device page
 * ("the rest of this screen's group") — cheap, because the server answers the whole group at once.
 */
export async function renderGroupAt(host, groupId, atIso) {
  host.innerHTML = `<p class="pat-muted">${esc(t('common.loading'))}</p>`;
  let r;
  try { r = await api.simulateGroup(groupId, atIso); } catch (err) { host.innerHTML = `<p class="pat-warn">${esc(err.message)}</p>`; return; }
  const rows = r.devices.map((d) => {
    if (d.error) return `<tr><td>${esc(d.id)}</td><td colspan="3" class="pat-muted">${esc(t('forecast.group.error'))}</td></tr>`;
    const what = d.power === 'off' ? t('forecast.seg.off')
      : (!d.playlist_id || !d.playing) && !d.default_content ? t('forecast.seg.nothing') : (d.playlist_name || '—');
    return `<tr><td><a href="#/device/${encodeURIComponent(d.id)}">${esc(d.name || d.id)}</a></td><td>${esc(wallLabel(d.local))}</td><td>${esc(what)}</td><td class="pat-muted">${esc(d.schedule_title ? t('forecast.group.by_schedule', { title: d.schedule_title }) : sourceText(d.source))}</td></tr>`;
  }).join('');
  host.innerHTML = `
    <table class="pat-table"><thead><tr><th>${esc(t('forecast.group.screen'))}</th><th>${esc(t('forecast.group.local'))}</th><th>${esc(t('forecast.group.shows'))}</th><th>${esc(t('forecast.group.why'))}</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="pat-muted">${esc(t('forecast.group.empty'))}</td></tr>`}</tbody></table>
    ${r.truncated ? `<p class="pat-muted">${esc(t('forecast.group.truncated'))}</p>` : ''}`;
}

/*
 * The Simple view's "What's coming up": the next few changes in the next day and a half, in
 * everyday words. Returns plain {when, text} rows; the caller renders them with textContent.
 */
export async function upcomingChanges(deviceId, max = 4) {
  const now = Date.now();
  const tl = await api.deviceTimeline(deviceId, new Date(now).toISOString(), new Date(now + 36 * 3600 * 1000).toISOString());
  const describe = (s) => {
    if (s.power === 'off') return { kind: 'off', text: t('simple.coming.off') };
    if ((!s.playlist_id || !s.playing) && !s.default_content) return { kind: 'nothing', text: t('simple.coming.nothing') };
    if (!s.playlist_id || !s.playing) return { kind: 'default', text: t('simple.coming.default') };
    return { kind: s.playlist_id, text: t('simple.coming.shows', { name: s.playlist_name || '—' }) };
  };
  const out = [];
  const first = tl.segments.length ? describe(tl.segments[0]) : null;
  let prev = first;
  const todayKey = tl.segments.length ? tl.segments[0].local.slice(0, 10) : '';
  const tomorrowKey = todayKey ? new Date(Date.parse(todayKey + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) : '';
  for (const s of tl.segments.slice(1)) {
    const d = describe(s);
    // Item-level changes inside one playlist are not news to a Simple-view reader; a different
    // playlist, the screen going dark or coming back are.
    if (prev && d.kind === prev.kind) continue;
    const key = s.local.slice(0, 10);
    const when = key === todayKey ? `${t('simple.coming.today')} ${wallLabel(s.local, false)}`
      : key === tomorrowKey ? `${t('simple.coming.tomorrow')} ${wallLabel(s.local, false)}` : wallLabel(s.local);
    const text = prev && prev.kind === 'off' && d.kind !== 'off' ? `${t('simple.coming.on')} — ${d.text}` : d.text;
    out.push({ when, text });
    prev = d;
    if (out.length >= max) break;
  }
  return { now: first ? first.text : null, changes: out };
}
