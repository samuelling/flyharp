// Invisible Hands in FlyHarp: let another app, anywhere, move FlyHarp's controls and listen to the fly.
// The protocol and the drop-in file live in samuelling/InvisibleHands (js/vendor/invisible-hands.js is a copy).
//
// What can be moved: every slider, menu and switch in the drawer that changes the sound or the model, the per-area
// mixer (instrument, level, mute), the eye's lens, the ear's picture and lens, and the Synthesthesia loop. Values
// travel as 0..1: a slider spans its own range, a menu its options, a switch is on above 0.5. A remote move drives
// the control exactly as a hand would (the same input and change events), so the page stays in step.
// What cannot: anything that would ask this browser for the camera or microphone, and MIDI routing.
//
// What it sends back, 0..1, each relative to its own recent peak where marked:
//   notes        notes per second (30/s = 1)
//   retina … lobula plate   activity of each optic-lobe stage (peak-relative)
//   motion dir / motion     direction of the scene's mean flow (0 = rightward, counter-clockwise) and its strength
//   ear: sound, AMMC, wedge, ventrolateral, posterior slope   activity of each auditory area (peak-relative)
const Hands = (() => {
  const $ = id => document.getElementById(id);
  const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
  let hands = null;
  const base = new Map();     // where a control stood before modulation: the person's own setting is the centre
  let held = null;            // id of the control a person is dragging right now: local hands win
  const ihId = el => el && (el.dataset.ih || el.id);
  const elOf = id => $(id) || document.querySelector(`[data-ih="${id}"]`);

  // ---------------------------------------------------------------- controls
  function labelOf(el) {
    const lab = el.closest('label');
    if (!lab) return el.id;
    const t = [...lab.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim();
    return t || el.id;
  }
  function flash(id) { const el = elOf(id); if (!el) return; el.classList.add('ihMoved'); clearTimeout(el._ihT); el._ihT = setTimeout(() => el.classList.remove('ihMoved'), 500); }
  function param(id, label, get, set, el, kind) {
    return {id, label: label.slice(0, 64), kind: kind || 'cont', get,
      set(v) { if (held === id) return; set(v); base.set(id, v); flash(id); },
      mod(v) { if (held === id) return; if (!base.has(id)) base.set(id, get()); set(clamp(base.get(id) + v)); flash(id); }};
  }
  function range(id, label) {
    const el = () => $(id);
    return param(id, label || labelOf($(id)), () => { const e = el(); return (e.value - e.min) / (e.max - e.min); }, v => {
      const e = el(), st = +e.step || 0, lo = +e.min, hi = +e.max; let x = lo + v * (hi - lo);
      if (st) x = lo + Math.round((x - lo) / st) * st;
      if (+e.value === x) return;
      e.value = x; e.dispatchEvent(new Event('input', {bubbles: true})); e.dispatchEvent(new Event('change', {bubbles: true}));
    }, $(id));
  }
  function menu(id, label, skip = []) {
    const opts = () => [...$(id).options].filter(o => !skip.includes(o.value) && !o.disabled);
    return param(id, label || labelOf($(id)), () => { const o = opts(), i = o.findIndex(x => x.selected); return o.length > 1 ? Math.max(0, i) / (o.length - 1) : 0; }, v => {
      const o = opts(); if (!o.length) return; const pick = o[Math.round(v * (o.length - 1))];
      if ($(id).value === pick.value) return;
      $(id).value = pick.value; $(id).dispatchEvent(new Event('change', {bubbles: true}));
    }, $(id));
  }
  function toggle(id, label) {
    return param(id, label || labelOf($(id)), () => $(id).checked ? 1 : 0, v => {
      const on = v >= 0.5; if ($(id).checked === on) return;
      $(id).checked = on; $(id).dispatchEvent(new Event('change', {bubbles: true}));
    }, $(id), 'toggle');
  }
  function choice(id, label, list, get, set, el) {
    return param(id, label, () => { const i = list().indexOf(get()); return list().length > 1 ? Math.max(0, i) / (list().length - 1) : 0; },
      v => { const L = list(); set(L[Math.round(v * (L.length - 1))]); }, el);
  }
  function buildParams() {
    const F = window.__flyharp, TN = window.Tonnectome, AREA = ['retina', 'lamina', 'medulla', 'medulla to lobula', 'lobula plate'];
    const ps = [
      // stimulus (the camera is the player's to switch on)
      menu('kind', 'Stimulus', ['webcam']), range('contrast', 'Contrast'), range('size', 'Size'), range('speed', 'Speed'), range('direction', 'Direction'), range('light', 'Light'),
      // instrument
      range('tempo', 'Tempo'), range('thresh', 'Threshold'), range('rate', 'Note rate'), range('spread', 'Spread'), range('vol', 'Volume'), toggle('revOn', 'Reverb on'), range('rev', 'Reverb'),
      toggle('dlyOn', 'Echo on'), range('dlyTime', 'Echo time'), range('dlyFb', 'Echo feedback'), range('dlyMix', 'Echo level'), range('dlyMotion', 'Motion → echo'),
      menu('scale', 'Scale'), menu('root', 'Root'), toggle('spatial', 'Spatial pan'), toggle('fbOn', 'Feedback timbre'), range('fbDepth', 'Feedback depth'), menu('fbTarget', 'Feedback target'),
    ];
    // the per-area mixer: one instrument, level and mute for each stage of the optic lobe
    AREA.forEach((nm, g) => {
      const box = () => document.querySelector(`#hier .area[data-g="${g}"]`);
      ps.push(choice(`eng${g}`, `${nm}: instrument`, () => F.instruments, () => F.area[g].engine, k => F.setEngine(g, k), null));
      ps.push(param(`lvl${g}`, `${nm}: level`, () => F.area[g].level, v => F.setLevel(g, Math.round(v * 20) / 20), null));
      ps.push(param(`mute${g}`, `${nm}: mute`, () => F.area[g].mute ? 1 : 0, v => F.setMute(g, v >= 0.5), null, 'toggle'));
    });
    ps.push(
      // hearing (the ear's own source stays the instrument: the microphone is the player's to switch on)
      range('tnLevel', 'Ear: input level'), range('tnGain', 'Ear: network gain'), range('tnMix', 'Ear picture into the eye'),
      choice('earView', 'Ear: picture', () => TN.VIEWS, () => TN.view, v => TN.setView(v), null),
      choice('earLens', 'Ear: lens', () => TN.AREAS.map(a => a.id).concat('all'), () => TN.lens, v => TN.setLens(v), null),
      menu('em_shape', 'Ear picture: shape from'), menu('em_bright', 'Ear picture: brightness from'), menu('em_colour', 'Ear picture: colour from'),
      // the eye's lens and the model
      choice('eyeLens', 'Eye: lens', () => F.lenses, () => F.lens, v => F.setLens(v), null),
      menu('eyeGeom', 'Eye geometry'), toggle('gAdapt', 'Photoreceptor adaptation'), range('gTauA', 'Adaptation time'), range('gK', 'Adaptation strength'),
      toggle('gNorm', 'Normalization'), menu('gTarget', 'Normalization target'), range('gPool', 'Normalization pool'), range('gC50', 'Normalization c50'), range('gTauN', 'Normalization time'),
      range('loopMix', 'Synthesthesia: ears into the eye'),
    );
    return ps.filter(p => p);
  }

  // ---------------------------------------------------------------- outputs: what the fly sends back
  const peak = {};
  const rel = (k, v, floor) => { peak[k] = Math.max(floor, (peak[k] || floor) * 0.995, v); return clamp(v / peak[k]); };
  let nps = 0, n0 = 0, t0 = performance.now(), mot = {dir: 0, mag: 0}, motT = 0;
  function tick() {
    const F = window.__flyharp; if (!F) return;
    const now = performance.now();
    if (now - t0 > 250) { nps = 0.6 * nps + 0.4 * (F.stats.notes - n0) / ((now - t0) / 1000); n0 = F.stats.notes; t0 = now; }
    if (now - motT > 66) { mot = F.motion(); motT = now; }
  }
  function buildOuts() {
    const F = () => window.__flyharp, TN = () => window.Tonnectome;
    const vis = ['retina', 'lamina', 'medulla', 'lobula', 'lobula plate'].map((nm, k) => ({id: 'v' + k, label: nm, get: () => rel('v' + k, F().meter ? F().meter[k] : 0, 0.02)}));
    const ear = [['sound', 'ear: sound'], ['ammc', 'ear: AMMC'], ['wed', 'ear: wedge'], ['vlp', 'ear: ventrolateral'], ['slope', 'ear: posterior slope']]
      .map(([k, nm]) => ({id: 'e_' + k, label: nm, get: () => rel('e' + k, (TN() && TN().areaLvl[k]) || 0, 0.005)}));
    return [{id: 'notes', label: 'notes', get: () => { tick(); return clamp(nps / 30); }}, ...vis,
      {id: 'motionDir', label: 'motion direction', get: () => ((mot.dir / (2 * Math.PI)) + 1) % 1},
      {id: 'motion', label: 'motion strength', get: () => clamp(mot.mag * 2)}, ...ear];
  }

  // ---------------------------------------------------------------- where each mark goes
  // A labelled control: the mark joins the label's words (wrapped in a span, so grid layouts keep their columns).
  // The mixer: beside each area's instrument menu, level slider and mute button. Lenses and pictures: beside their row.
  function anchor(id) {
    const g = /^(eng|lvl|mute)(\d)$/.exec(id);
    if (g) return t => {
      const box = document.querySelector(`#hier .area[data-g="${g[2]}"]`); if (!box) return;
      const el = box.querySelector(g[1] === 'eng' ? '.eng' : g[1] === 'lvl' ? '.lvl' : '.mute'); el.dataset.ih = id;
      if (g[1] === 'mute') el.after(t); else el.before(t);
    };
    if (id === 'eyeLens') return t => { let row = $('ihEyeLens'); if (!row) { row = document.createElement('div'); row.id = 'ihEyeLens'; row.className = 'ihLensRow'; row.textContent = 'lens'; $('lenses').before(row); } row.prepend(t); };
    if (id === 'earLens') return t => document.querySelector('.earAllRow').prepend(t);
    if (id === 'earView') return t => $('tnViews').prepend(t);
    const el = $(id); if (!el) return null;
    const lab = el.closest('label');
    if (!lab) return t => el.before(t);
    return t => {
      let w = lab.querySelector(':scope > .ihLab');
      if (!w) {
        const tn = [...lab.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
        w = document.createElement('span'); w.className = 'ihLab';
        if (tn) { w.textContent = tn.textContent.trim(); tn.replaceWith(w); w.after(' '); if (lab.firstChild !== w) w.before(' '); } else lab.prepend(w);
      }
      w.append(t);
    };
  }

  // ---------------------------------------------------------------- the panel and the badge
  function init() {
    if (hands || !window.InvisibleHands) return;
    const params = buildParams();
    hands = InvisibleHands.create({app: 'flyharp', name: 'FlyHarp', params, outs: buildOuts()});
    // local hands win: while a person drags a control, remote moves of it wait; afterwards their setting is the centre
    const mine = e => { if (!e.isTrusted) return; const el = e.target.closest('input, select, button'), id = ihId(el); const p = id && params.find(q => q.id === id); if (p) base.set(p.id, p.get()); };
    document.addEventListener('pointerdown', e => { held = ihId(e.target.closest('input, select')) || null; }, true);
    document.addEventListener('pointerup', () => { held = null; }, true);
    for (const ev of ['input', 'change']) document.addEventListener(ev, mine, true);
    document.addEventListener('click', e => setTimeout(() => mine(e)), true);   // the mixer's mute button flips on click
    // the mark (linglab.org/invisiblehands/brand): pinned beside every control the room can move, and nowhere
    // else; grey while unlinked, coloured once linked, full strength with others in the room; the orange jumps on a move
    const tags = new Map(params.map(p => [p.id, hands.tag(p.id)]));
    const pin = () => {
      for (const p of params) {
        const t = tags.get(p.id); if (t.isConnected) continue;
        const at = anchor(p.id); if (at) at(t);
      }
    };
    window.addEventListener('flyharp:hier', pin); pin();
    $('handsPanel').appendChild(hands.panel());
    $('handsCount').textContent = `${params.length} controls`;
    $('handsList').textContent = params.map(p => p.label).join(' · ');
    $('handsOuts').textContent = buildOuts().map(o => o.label).join(' · ');
    const badge = $('handsBadge'), mk = InvisibleHands.icon({size: 22, title: 'Invisible Hands'});
    badge.querySelector('.ihMk').append(mk);
    document.querySelector('.ihHead .ihMk').append(InvisibleHands.icon({size: 30}));
    const tab = document.querySelector('.tabs button[data-tab="hands"]'); tab.prepend(InvisibleHands.icon({mini: true, size: 15}));
    let lastIn = 0;
    const draw = () => {
      const st = hands.status, n = hands.peers.length, linked = st === 'on' && hands.allow;
      badge.classList.toggle('linked', linked); badge.classList.toggle('live', linked && n > 0); badge.classList.toggle('wait', st === 'connecting' || st === 'retrying');
      badge.querySelector('.ihN').textContent = st === 'on' ? (hands.allow ? (n ? `· ${n}` : '· alone') : '· hands off') : st === 'error' ? '· not linked' : st === 'off' ? '' : '· linking';
    };
    hands.on('status', draw); hands.on('peers', draw); hands.on('allow', draw);
    hands.on('in', () => { const now = performance.now(); if (now - lastIn > 120) { badge.classList.remove('hit'); void badge.offsetWidth; badge.classList.add('hit'); lastIn = now; } });
    badge.onclick = () => { window.dispatchEvent(new CustomEvent('flyharp:drawer', {detail: 'hands'})); };
    draw();
    window.HANDS = hands;
  }
  return {init, get hands() { return hands; }};
})();
