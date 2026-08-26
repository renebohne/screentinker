import { api } from '../api.js';
import { esc } from '../utils.js';
import { showToast } from '../components/toast.js';

/*
 * The slide deck editor.
 *
 * ⚠️ THE DOCUMENT IS THE STATE, AND THE STAGE IS A VIEW OF IT. Every control writes into `deck.doc`
 * and re-renders from it. That sounds obvious and is the thing the old Content Designer got wrong:
 * it published baked HTML and kept no source, so 0 of 49 widgets in a real database can be reopened
 * for editing. Here the document is what is saved, and what plays is derived from it by publishing.
 *
 * ⚠️ SAVE AND PUBLISH ARE DIFFERENT ACTS. Saving stores the document; publishing pushes slides to
 * screens. Somebody part-way through a deck has every right to a slide that does not add up yet, and
 * nothing should reach a wall until they say so.
 */

const ANIMS = {
  none: 'None', fade: 'Fade', slideL: 'Slide in ←', slideR: 'Slide in →',
  slideU: 'Rise', slideD: 'Drop', zoom: 'Zoom', wipe: 'Wipe',
};
const EASES = { 'ease-out': 'Ease out', soft: 'Soft', linear: 'Linear', 'ease-in': 'Ease in' };
// Mirrors FONTS in server/lib/slide-render.js. Named generically because there is no font pipeline
// in this product yet: these are families a panel may or may not have, each backed by a generic.
const FONTS = { sans: 'Sans', serif: 'Serif', mono: 'Mono', condensed: 'Condensed' };
const KINDS = {
  head: { icon: 'H', label: 'Headline', size: 7, weight: 700 },
  body: { icon: 'T', label: 'Text', size: 3, weight: 400 },
  stat: { icon: '#', label: 'Big number', size: 14, weight: 700 },
  image: { icon: '▣', label: 'Photo', size: 0, weight: 400 },
  rule: { icon: '▬', label: 'Rule', size: 0, weight: 400 },
  box: { icon: '◻', label: 'Panel', size: 0, weight: 400 },
};
const TEXT_KINDS = ['head', 'body', 'stat'];

const state = {
  decks: [], deck: null, si: 0, ei: 0, tab: 'content',
  dirty: false, saving: false, contentIndex: null,
};

const slide = () => state.deck && state.deck.doc.slides[state.si];

/* The document stores template.elements; this is just a shorthand so the code below reads. */
function elementsOf(s) { return (s.template && Array.isArray(s.template.elements)) ? s.template.elements : []; }

const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

function newElement(kind) {
  const k = KINDS[kind];
  return {
    slot: uid('f'), kind,
    box: { x: 10, y: 40, w: 50, ...(kind === 'rule' ? { h: 0.7 } : {}), ...(kind === 'image' || kind === 'box' ? { h: 30 } : {}) },
    style: { color: '#FFFFFF', font: 'sans', size_cqw: k.size || 3, weight: k.weight, align: 'left', opacity: 1, radius_cqw: 0 },
    motion: { animation: 'slideU', delay: 0.2, duration: 0.55, easing: 'ease-out' },
    content_id: null,
  };
}

function newSlide(name = 'Untitled slide') {
  const e = newElement('head');
  return {
    id: uid('s'), name, dwell_sec: 10, widget_id: null,
    template: { background: '#1B2029', elements: [e] },
    fields: { [e.slot]: 'New slide' },
  };
}

/* ============================================================ render */

export async function render(container) {
  container.innerHTML = `<div class="page-header"><div><h1>Slides</h1>
    <div class="subtitle">Build a deck of slides and publish it as a playlist.</div></div>
    <button class="btn btn-primary" id="newDeck">+ New deck</button></div>
    <div id="deckArea"><p style="color:var(--text-muted)">Loading…</p></div>`;

  container.querySelector('#newDeck').addEventListener('click', async () => {
    const name = prompt('Name this deck');           // eslint-disable-line no-alert
    if (!name || !name.trim()) return;
    try {
      const d = await api.post('/slide-decks', { name: name.trim(), doc: { slides: [newSlide('Slide 1')] } });
      state.decks.unshift({ id: d.id, name: d.name, slide_count: d.doc.slides.length });
      await openDeck(container, d.id);
    } catch (e) { showToast(e.message || 'Could not create the deck', 'error'); }
  });

  // Loaded alongside the decks so the photo picker has something in it. Failure is not fatal:
  // a deck without its image list is still perfectly editable, and every other control works.
  if (state.contentIndex === null) await loadContent();

  try {
    state.decks = await api.get('/slide-decks');
  } catch (e) {
    container.querySelector('#deckArea').innerHTML =
      `<p style="color:var(--danger)">Could not load decks: ${esc(e.message || '')}</p>`;
    return;
  }
  if (state.deck) return renderEditor(container);
  renderList(container);
}

function renderList(container) {
  const host = container.querySelector('#deckArea');
  if (!state.decks.length) {
    host.innerHTML = `<div class="settings-section" style="text-align:center;padding:38px 20px">
      <p style="margin:0 0 6px;font-weight:600">No decks yet</p>
      <p style="margin:0;color:var(--text-muted);font-size:13px">A deck is a set of slides that
        publishes as a playlist — headline, photo, big number, each with its own entrance.</p></div>`;
    return;
  }
  host.innerHTML = `<div class="settings-section" style="padding:0">
    ${state.decks.map((d) => `
      <div style="display:flex;align-items:center;gap:12px;padding:11px 14px;border-bottom:1px solid var(--border)">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600">${esc(d.name)}</div>
          <div style="font-size:12px;color:var(--text-muted)">
            ${d.slide_count} slide${d.slide_count === 1 ? '' : 's'} · ${(d.total_sec || 0)}s total
            ${d.playlist_id ? '· published' : '· not published yet'}</div>
        </div>
        <button class="btn btn-secondary btn-sm" data-open="${esc(d.id)}">Edit</button>
        <button class="btn btn-secondary btn-sm" data-del="${esc(d.id)}">Delete</button>
      </div>`).join('')}
  </div>`;
  host.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => openDeck(container, b.dataset.open)));
  host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const d = state.decks.find((x) => x.id === b.dataset.del);
    // ⚠️ Spelled out, because the honest answer is surprising: deleting the document does NOT take
    // the published slides off the screens showing them.
    const msg = d && d.playlist_id
      ? `Delete "${d.name}"?\n\nThe playlist it published stays where it is — screens showing it keep playing.`
      : `Delete "${d && d.name}"?`;
    if (!confirm(msg)) return;                        // eslint-disable-line no-alert
    try {
      await api.delete(`/slide-decks/${b.dataset.del}`);
      state.decks = state.decks.filter((x) => x.id !== b.dataset.del);
      renderList(container);
    } catch (e) { showToast(e.message || 'Could not delete', 'error'); }
  }));
}

async function openDeck(container, id) {
  try {
    state.deck = await api.get(`/slide-decks/${id}`);
    state.si = 0; state.ei = 0; state.dirty = false;
    renderEditor(container);
  } catch (e) { showToast(e.message || 'Could not open the deck', 'error'); }
}

function renderEditor(container) {
  const d = state.deck;
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${esc(d.name)}</h1>
        <div class="subtitle" id="deckStatus"></div></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="backBtn">← All decks</button>
        <button class="btn btn-secondary" id="saveBtn">Save</button>
        <button class="btn btn-primary" id="pubBtn">Publish</button>
      </div>
    </div>
    <div id="warnBox"></div>
    <div class="settings-section" style="padding:10px 12px;margin-bottom:12px">
      <div id="strip" style="display:flex;gap:8px;overflow-x:auto"></div>
    </div>
    <div style="display:grid;grid-template-columns:42px minmax(0,1fr) 290px;gap:12px;align-items:start">
      <div class="settings-section" id="tools" style="padding:7px;display:flex;flex-direction:column;gap:5px"></div>
      <div class="settings-section" style="padding:12px">
        <div id="stage" style="position:relative;aspect-ratio:16/9;border-radius:4px;overflow:hidden;container-type:size"></div>
        <div style="display:flex;gap:9px;align-items:center;margin-top:10px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="playBtn">▶ Play entrance</button>
          <span style="margin-left:auto;font-size:12px;color:var(--text-muted)" id="settleLabel"></span>
        </div>
      </div>
      <div class="settings-section" style="padding:0">
        <div style="display:flex;border-bottom:1px solid var(--border)" id="tabs">
          ${['content', 'style', 'motion', 'slide'].map((t) => `
            <button class="tabBtn" data-tab="${t}" style="flex:1;padding:8px 2px;border:0;background:none;
              cursor:pointer;font-size:12px;font-weight:600;border-bottom:2px solid transparent">
              ${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
        </div>
        <div id="layers" style="max-height:170px;overflow-y:auto;border-bottom:1px solid var(--border)"></div>
        <div id="props" style="padding:11px 12px 14px;display:grid;gap:9px"></div>
      </div>
    </div>`;

  container.querySelector('#backBtn').addEventListener('click', async () => {
    if (state.dirty && !confirm('Leave without saving? Your changes will be lost.')) return; // eslint-disable-line no-alert
    state.deck = null;
    await render(container);
  });
  container.querySelector('#saveBtn').addEventListener('click', () => save(container));
  container.querySelector('#pubBtn').addEventListener('click', () => publish(container));
  container.querySelector('#playBtn').addEventListener('click', play);
  container.querySelectorAll('.tabBtn').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab; paintTabs(container); renderProps(container);
  }));
  container.querySelector('#tools').innerHTML = Object.entries(KINDS).map(([k, v]) =>
    `<button class="btn btn-secondary" data-add="${k}" title="Add ${v.label}"
       style="padding:0;aspect-ratio:1;display:grid;place-items:center">${v.icon}</button>`).join('');
  container.querySelector('#tools').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-add]'); if (!b) return;
    const s = slide(); if (!s) return;
    const e = newElement(b.dataset.add);
    s.template.elements.push(e);
    if (TEXT_KINDS.includes(e.kind)) s.fields[e.slot] = KINDS[e.kind].label;
    state.ei = s.template.elements.length - 1; state.tab = 'content';
    touch(container); play();
  });

  paintTabs(container);
  paintAll(container);
}

function paintTabs(container) {
  container.querySelectorAll('.tabBtn').forEach((b) => {
    const on = b.dataset.tab === state.tab;
    b.style.color = on ? 'var(--text)' : 'var(--text-muted)';
    b.style.borderBottomColor = on ? 'var(--primary)' : 'transparent';
  });
}

function paintAll(container) {
  renderStage(container); renderStrip(container); renderLayers(container);
  renderProps(container); renderStatus(container);
}

function touch(container) {
  state.dirty = true;
  paintAll(container);
}

/* ============================================================ stage */

function styleFor(e) {
  const s = e.style || {};
  const out = [`left:${e.box.x}%`, `top:${e.box.y}%`, `width:${e.box.w}%`];
  if (e.box.h != null) out.push(`height:${e.box.h}%`);
  if (s.opacity != null && s.opacity !== 1) out.push(`opacity:${s.opacity}`);
  if (s.radius_cqw) out.push(`border-radius:${s.radius_cqw}cqw`);
  if (e.kind === 'rule' || e.kind === 'box') out.push(`background:${s.color}`);
  else out.push(`color:${s.color}`);
  if (TEXT_KINDS.includes(e.kind)) {
    const fam = { sans: 'system-ui,sans-serif', serif: 'Georgia,serif', mono: 'ui-monospace,monospace',
      condensed: "'Arial Narrow',sans-serif" }[s.font] || 'system-ui,sans-serif';
    out.push(`font-family:${fam}`, `font-size:${s.size_cqw}cqw`, `font-weight:${s.weight}`,
      `text-align:${s.align}`, 'line-height:1.08', 'white-space:pre-wrap');
  }
  return out.join(';');
}

function renderStage(container) {
  const s = slide(); const stage = container.querySelector('#stage');
  if (!s) { stage.innerHTML = ''; return; }
  stage.style.background = s.template.background || '#000';
  stage.innerHTML = '';
  elementsOf(s).forEach((e, i) => {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;cursor:grab;${styleFor(e)}`;
    if (i === state.ei) d.style.outline = '1.5px solid var(--primary)';
    if (e.motion && e.motion.animation !== 'none') {
      d.dataset.anim = e.motion.animation;
      d.style.setProperty('--dur', `${e.motion.duration}s`);
      d.style.setProperty('--delay', `${e.motion.delay}s`);
    }
    if (e.kind === 'image') {
      const url = contentUrl(e.content_id);
      d.style.overflow = 'hidden';
      d.innerHTML = url
        ? `<img src="${esc(url)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
        : `<div style="width:100%;height:100%;display:grid;place-items:center;background:rgba(255,255,255,.07);
             border:1px dashed rgba(255,255,255,.22);color:rgba(255,255,255,.45);font-size:2.2cqw">photo</div>`;
    } else if (TEXT_KINDS.includes(e.kind)) {
      d.textContent = s.fields[e.slot] || '';
    }
    d.addEventListener('pointerdown', (ev) => startDrag(ev, i, d, container));
    stage.appendChild(d);
  });
  ensureKeyframes();
  const settle = settleOf(s);
  container.querySelector('#settleLabel').textContent =
    settle > s.dwell_sec
      ? `settles at ${settle.toFixed(2)}s — after this slide is replaced at ${s.dwell_sec}s`
      : `settles at ${settle.toFixed(2)}s of ${s.dwell_sec}s`;
  container.querySelector('#settleLabel').style.color =
    settle > s.dwell_sec ? 'var(--danger)' : 'var(--text-muted)';
}

/* Drag on the stage, in stage-relative percentages so it survives any panel size. */
function startDrag(ev, i, node, container) {
  ev.preventDefault();
  state.ei = i; renderLayers(container); renderProps(container); renderStage(container);
  const stage = container.querySelector('#stage');
  const r = stage.getBoundingClientRect();
  const e = elementsOf(slide())[i];
  const ox = ev.clientX - r.left - (e.box.x / 100) * r.width;
  const oy = ev.clientY - r.top - (e.box.y / 100) * r.height;
  const live = stage.children[i];
  live.setPointerCapture(ev.pointerId);
  const move = (m) => {
    e.box.x = Math.max(-20, Math.min(110, ((m.clientX - r.left - ox) / r.width) * 100));
    e.box.y = Math.max(-20, Math.min(110, ((m.clientY - r.top - oy) / r.height) * 100));
    live.style.left = `${e.box.x}%`; live.style.top = `${e.box.y}%`;
  };
  const up = () => {
    live.removeEventListener('pointermove', move);
    live.removeEventListener('pointerup', up);
    touch(container);
  };
  live.addEventListener('pointermove', move);
  live.addEventListener('pointerup', up);
}

/*
 * ⚠️ The same keyframes the SERVER emits (lib/slide-render.js). Kept in one <style> injected once
 * rather than per render: the editor previewing something different from what ships would make the
 * whole tool a liar, so if these ever diverge the preview is the thing that is wrong.
 */
function ensureKeyframes() {
  if (document.getElementById('stKeyframes')) return;
  const st = document.createElement('style');
  st.id = 'stKeyframes';
  st.textContent = `
    #stage.playing > div[data-anim] { animation-name:var(--kf); animation-duration:var(--dur);
      animation-delay:var(--delay); animation-fill-mode:both; animation-timing-function:ease-out; }
    #stage.playing > div[data-anim="fade"]   { --kf:st-fade }
    #stage.playing > div[data-anim="slideL"] { --kf:st-slide-l }
    #stage.playing > div[data-anim="slideR"] { --kf:st-slide-r }
    #stage.playing > div[data-anim="slideU"] { --kf:st-slide-u }
    #stage.playing > div[data-anim="slideD"] { --kf:st-slide-d }
    #stage.playing > div[data-anim="zoom"]   { --kf:st-zoom }
    #stage.playing > div[data-anim="wipe"]   { --kf:st-wipe }
    @keyframes st-fade    { from{opacity:0} to{opacity:1} }
    @keyframes st-slide-l { from{opacity:0;transform:translateX(-14%)} to{opacity:1;transform:none} }
    @keyframes st-slide-r { from{opacity:0;transform:translateX(14%)}  to{opacity:1;transform:none} }
    @keyframes st-slide-u { from{opacity:0;transform:translateY(26%)}  to{opacity:1;transform:none} }
    @keyframes st-slide-d { from{opacity:0;transform:translateY(-26%)} to{opacity:1;transform:none} }
    @keyframes st-zoom    { from{opacity:0;transform:scale(.86)}       to{opacity:1;transform:none} }
    @keyframes st-wipe    { from{clip-path:inset(0 100% 0 0)}          to{clip-path:inset(0 0 0 0)} }`;
  document.head.appendChild(st);
}

function play() {
  const stage = document.getElementById('stage');
  if (!stage) return;
  stage.classList.remove('playing');
  void stage.offsetWidth;                     // reflow, so the animation restarts
  stage.classList.add('playing');
}

function settleOf(s) {
  return elementsOf(s).reduce((m, e) =>
    (e.motion && e.motion.animation !== 'none' ? Math.max(m, e.motion.delay + e.motion.duration) : m), 0);
}

/* ============================================================ filmstrip */

function renderStrip(container) {
  const d = state.deck;
  container.querySelector('#strip').innerHTML = d.doc.slides.map((s, i) => `
    <button data-slide="${i}" style="flex:0 0 auto;width:124px;padding:0;cursor:pointer;text-align:left;
      border:1px solid ${i === state.si ? 'var(--primary)' : 'var(--border)'};border-radius:4px;overflow:hidden;background:var(--surface)">
      <div style="position:relative;aspect-ratio:16/9;container-type:size;background:${esc(s.template.background || '#000')}">
        ${elementsOf(s).map((e) => `<div style="position:absolute;overflow:hidden;${styleFor(e)}">${
          TEXT_KINDS.includes(e.kind) ? esc(s.fields[e.slot] || '') : ''}</div>`).join('')}
      </div>
      <div style="display:flex;gap:6px;padding:4px 6px;border-top:1px solid var(--border)">
        <span style="flex:1;font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</span>
        <span style="font-size:10px;color:var(--text-muted)">${s.dwell_sec}s</span>
      </div>
    </button>`).join('')
    + `<button id="addSlide" style="flex:0 0 auto;width:124px;border:1px dashed var(--border);
        border-radius:4px;background:none;color:var(--text-muted);cursor:pointer;font-size:12px">+ Add slide</button>`;

  container.querySelectorAll('[data-slide]').forEach((b) => b.addEventListener('click', () => {
    state.si = +b.dataset.slide; state.ei = 0; paintAll(container); play();
  }));
  container.querySelector('#addSlide').addEventListener('click', () => {
    state.deck.doc.slides.splice(state.si + 1, 0, newSlide(`Slide ${state.deck.doc.slides.length + 1}`));
    state.si++; state.ei = 0; touch(container); play();
  });
}

/* ============================================================ inspector */

function renderLayers(container) {
  const s = slide(); if (!s) return;
  container.querySelector('#layers').innerHTML = elementsOf(s).map((e, i) => `
    <button data-el="${i}" style="display:flex;align-items:center;gap:7px;padding:6px 12px;width:100%;
      text-align:left;border:0;cursor:pointer;border-bottom:1px solid var(--border);
      background:${i === state.ei ? 'var(--bg-hover, rgba(127,127,127,.12))' : 'none'}">
      <span style="width:14px;text-align:center;color:var(--text-muted);font-size:12px">${KINDS[e.kind].icon}</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px">
        ${esc(TEXT_KINDS.includes(e.kind) ? (s.fields[e.slot] || KINDS[e.kind].label) : KINDS[e.kind].label)}</span>
      <span style="font-size:10px;color:var(--text-muted);font-variant-numeric:tabular-nums">${
        !e.motion || e.motion.animation === 'none' ? '—' : `${e.motion.delay.toFixed(2)}+${e.motion.duration.toFixed(2)}`}</span>
    </button>`).join('');
  container.querySelectorAll('[data-el]').forEach((b) => b.addEventListener('click', () => {
    state.ei = +b.dataset.el; renderLayers(container); renderProps(container); renderStage(container);
  }));
}

const row = (label, inner) =>
  `<div style="display:grid;grid-template-columns:74px 1fr;align-items:center;gap:9px">
     <label style="font-size:12px;color:var(--text-muted)">${label}</label>${inner}</div>`;
const rng = (id, min, max, step, v, unit = '') =>
  `<div style="display:flex;align-items:center;gap:8px"><input type="range" id="${id}" min="${min}" max="${max}"
     step="${step}" value="${v}" style="flex:1;min-width:0">
     <span style="font-size:11.5px;min-width:44px;text-align:right;font-variant-numeric:tabular-nums">${
       (+v).toFixed(step < 0.1 ? 2 : 1)}${unit}</span></div>`;

function renderProps(container) {
  const host = container.querySelector('#props');
  const s = slide(); if (!s) { host.innerHTML = ''; return; }

  if (state.tab === 'slide') {
    host.innerHTML =
      row('Name', `<input class="input" id="sName" value="${esc(s.name)}">`)
      + row('Background', `<input type="color" id="sBg" value="${esc(s.template.background || '#000000')}" style="width:100%;height:28px">`)
      + row('Dwell', rng('sDwell', 1, 60, 1, s.dwell_sec, 's'))
      + `<button class="btn btn-secondary btn-sm" id="delSlide">Delete this slide</button>`;
    host.querySelector('#sName').oninput = (e) => { s.name = e.target.value; touch(container); };
    host.querySelector('#sBg').oninput = (e) => { s.template.background = e.target.value; touch(container); };
    host.querySelector('#sDwell').oninput = (e) => { s.dwell_sec = +e.target.value; touch(container); };
    host.querySelector('#delSlide').onclick = () => {
      if (state.deck.doc.slides.length === 1) { showToast('A deck needs at least one slide', 'error'); return; }
      state.deck.doc.slides.splice(state.si, 1);
      state.si = Math.max(0, state.si - 1); state.ei = 0; touch(container);
    };
    return;
  }

  const e = elementsOf(s)[state.ei];
  if (!e) { host.innerHTML = `<p style="font-size:12px;color:var(--text-muted)">Add an element from the toolbar.</p>`; return; }
  const isText = TEXT_KINDS.includes(e.kind);

  if (state.tab === 'content') {
    host.innerHTML =
      (isText
        ? row('Text', `<textarea class="input" id="pText" rows="3" style="resize:vertical">${esc(s.fields[e.slot] || '')}</textarea>`)
        : e.kind === 'image'
          ? row('Photo', `<select class="input" id="pImg"><option value="">— none —</option>${
              (state.contentIndex || []).map((c) => `<option value="${esc(c.id)}" ${
                c.id === e.content_id ? 'selected' : ''}>${esc(c.filename)}</option>`).join('')}</select>`)
            + `<p style="font-size:11.5px;color:var(--text-muted);grid-column:1/-1;margin:0">
                 Pick from the content library — the slide stores a reference, not a copy.</p>`
          : `<p style="font-size:12px;color:var(--text-muted)">Decorative — no text.</p>`)
      + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
           <button class="btn btn-secondary btn-sm" id="pFwd">↑ Forward</button>
           <button class="btn btn-secondary btn-sm" id="pDel">Delete</button></div>`;
    if (host.querySelector('#pText')) {
      host.querySelector('#pText').oninput = (ev) => {
        // ⚠️ One string, into fields. The template is not touched — that is the whole design.
        s.fields[e.slot] = ev.target.value; touch(container);
      };
    }
    if (host.querySelector('#pImg')) {
      host.querySelector('#pImg').onchange = (ev) => { e.content_id = ev.target.value || null; touch(container); };
    }
    host.querySelector('#pFwd').onclick = () => {
      const arr = s.template.elements;
      if (state.ei < arr.length - 1) {
        [arr[state.ei], arr[state.ei + 1]] = [arr[state.ei + 1], arr[state.ei]];
        state.ei++; touch(container);
      }
    };
    host.querySelector('#pDel').onclick = () => {
      const arr = s.template.elements;
      const [gone] = arr.splice(state.ei, 1);
      if (gone) delete s.fields[gone.slot];
      state.ei = Math.max(0, state.ei - 1); touch(container);
    };
    return;
  }

  if (state.tab === 'style') {
    const st = e.style;
    host.innerHTML =
      row('X', rng('pX', -20, 110, 1, e.box.x, '%'))
      + row('Y', rng('pY', -20, 110, 1, e.box.y, '%'))
      + row('Width', rng('pW', 1, 120, 1, e.box.w, '%'))
      + (e.box.h != null ? row('Height', rng('pH', 0.2, 110, 0.2, e.box.h, '%')) : '')
      + row('Colour', `<input type="color" id="pColor" value="${esc(st.color)}" style="width:100%;height:28px">`)
      + (isText ? row('Font', `<select class="input" id="pFont">${Object.entries(FONTS).map(([k, v]) =>
          `<option value="${k}" ${k === st.font ? 'selected' : ''}>${v}</option>`).join('')}</select>`) : '')
      + (isText ? row('Size', rng('pSize', 0.5, 30, 0.2, st.size_cqw)) : '')
      + (isText ? row('Weight', `<select class="input" id="pWeight">${[400, 500, 600, 700, 800].map((w) =>
          `<option value="${w}" ${w === st.weight ? 'selected' : ''}>${w}</option>`).join('')}</select>`) : '')
      + (isText ? row('Align', `<select class="input" id="pAlign">${['left', 'center', 'right'].map((a) =>
          `<option value="${a}" ${a === st.align ? 'selected' : ''}>${a}</option>`).join('')}</select>`) : '')
      + ((e.kind === 'image' || e.kind === 'box') ? row('Corner', rng('pRad', 0, 12, 0.2, st.radius_cqw || 0)) : '')
      + row('Opacity', rng('pOp', 0.1, 1, 0.05, st.opacity == null ? 1 : st.opacity))
      + `<p style="font-size:11.5px;color:var(--text-muted);grid-column:1/-1;margin:0">
           Sizes are relative to the screen, so a slide looks the same on a 720p panel and a 4K one.</p>`;

    const bindRange = (id, set) => { const n = host.querySelector(`#${id}`); if (n) n.oninput = (ev) => { set(+ev.target.value); touch(container); }; };
    bindRange('pX', (v) => { e.box.x = v; }); bindRange('pY', (v) => { e.box.y = v; });
    bindRange('pW', (v) => { e.box.w = v; }); bindRange('pH', (v) => { e.box.h = v; });
    bindRange('pSize', (v) => { st.size_cqw = v; }); bindRange('pRad', (v) => { st.radius_cqw = v; });
    bindRange('pOp', (v) => { st.opacity = v; });
    host.querySelector('#pColor').oninput = (ev) => { st.color = ev.target.value; touch(container); };
    const bindSel = (id, set) => { const n = host.querySelector(`#${id}`); if (n) n.onchange = (ev) => { set(ev.target.value); touch(container); }; };
    bindSel('pFont', (v) => { st.font = v; }); bindSel('pAlign', (v) => { st.align = v; });
    bindSel('pWeight', (v) => { st.weight = +v; });
    return;
  }

  // motion
  const m = e.motion || { animation: 'none', delay: 0, duration: 0.5, easing: 'ease-out' };
  host.innerHTML =
    row('Entrance', `<select class="input" id="mAnim">${Object.entries(ANIMS).map(([k, v]) =>
      `<option value="${k}" ${k === m.animation ? 'selected' : ''}>${v}</option>`).join('')}</select>`)
    + row('Delay', rng('mDelay', 0, 10, 0.05, m.delay, 's'))
    + row('Duration', rng('mDur', 0.1, 5, 0.05, m.duration, 's'))
    + row('Easing', `<select class="input" id="mEase">${Object.entries(EASES).map(([k, v]) =>
      `<option value="${k}" ${k === m.easing ? 'selected' : ''}>${v}</option>`).join('')}</select>`)
    + `<p style="font-size:11.5px;color:var(--text-muted);grid-column:1/-1;margin:0">
         Everything has to finish before the slide is replaced — watch the time under the stage.</p>`;
  host.querySelector('#mAnim').onchange = (ev) => {
    e.motion = ev.target.value === 'none' ? null : { ...m, animation: ev.target.value };
    touch(container); play();
  };
  const bindM = (id, key) => { const n = host.querySelector(`#${id}`); if (n) n.oninput = (ev) => {
    if (!e.motion) e.motion = { ...m }; e.motion[key] = +ev.target.value; touch(container); }; };
  bindM('mDelay', 'delay'); bindM('mDur', 'duration');
  host.querySelector('#mEase').onchange = (ev) => { if (!e.motion) e.motion = { ...m }; e.motion.easing = ev.target.value; touch(container); };
}

/* ============================================================ status, save, publish */

function renderStatus(container) {
  const d = state.deck;
  const total = d.doc.slides.reduce((a, s) => a + s.dwell_sec, 0);
  container.querySelector('#deckStatus').textContent =
    `${d.doc.slides.length} slide${d.doc.slides.length === 1 ? '' : 's'} · ${total}s total`
    + (state.dirty ? ' · unsaved changes' : '');

  // Warnings are computed locally so they track the edit, and re-checked by the server on save.
  const warn = d.doc.slides
    .map((s) => ({ s, settle: settleOf(s) }))
    .filter((x) => x.settle > x.s.dwell_sec);
  container.querySelector('#warnBox').innerHTML = warn.length ? `
    <div class="settings-section" style="border-left:3px solid var(--danger);margin-bottom:12px;padding:10px 13px">
      <strong style="font-size:13px">Some motion never finishes</strong>
      <ul style="margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--text-muted)">
        ${warn.map((x) => `<li>“${esc(x.s.name)}” settles at ${x.settle.toFixed(2)}s but is replaced at
           ${x.s.dwell_sec}s — on a screen that reads as text that never arrives.</li>`).join('')}
      </ul></div>` : '';
}

async function save(container) {
  if (state.saving) return;
  state.saving = true;
  try {
    const d = state.deck;
    const fresh = await api.put(`/slide-decks/${d.id}`, { name: d.name, doc: d.doc });
    state.deck = fresh; state.dirty = false;
    paintAll(container);
    showToast('Saved', 'success');
  } catch (e) {
    showToast(e.message || 'Could not save', 'error');
  } finally { state.saving = false; }
}

async function publish(container) {
  if (state.dirty) await save(container);
  try {
    const out = await api.post(`/slide-decks/${state.deck.id}/publish`, {});
    state.deck = out;
    paintAll(container);
    const n = out.published ? out.published.slides : state.deck.doc.slides.length;
    // ⚠️ Says what actually happened, including that it is now a playlist — an operator who does not
    // know that has no idea where to go to put these on a screen.
    showToast(`Published ${n} slide${n === 1 ? '' : 's'} to a playlist`, 'success');
  } catch (e) {
    showToast(e.message || 'Could not publish', 'error');
  }
}

/* ============================================================ content */

function contentUrl(id) {
  if (!id) return null;
  const c = (state.contentIndex || []).find((x) => x.id === id);
  if (!c) return null;
  return c.remote_url || (c.filepath ? `/uploads/content/${encodeURIComponent(c.filepath)}` : null);
}

async function loadContent() {
  try {
    const all = await api.get('/content');
    state.contentIndex = (Array.isArray(all) ? all : [])
      .filter((c) => (c.mime_type || '').startsWith('image/'))
      .map((c) => ({ id: c.id, filename: c.filename, filepath: c.filepath, remote_url: c.remote_url }));
  } catch (e) { state.contentIndex = []; }
}
