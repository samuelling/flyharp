/* Invisible Hands — remote control between apps, over the internet. Protocol 1.
   One file, no dependencies. Add it to a page, describe your controls, and anyone in the same room can move them:

     <script src="invisible-hands.js"></script>
     const hands = InvisibleHands.create({
       app: 'my-app', name: 'My App',
       params: [{ id: 'speed', label: 'Speed', get: () => speed, set: v => { speed = v; } }],   // values are always 0..1
       outs:   [{ id: 'beat',  label: 'Beat',  get: () => beat }]                                // optional: what you publish
     });
     button.onclick = () => dialog.append(hands.panel());   // optional built-in panel: start, join, invite, switch off

   A page opened with ?room=<code> joins that room by itself. See SPEC.md for the messages. */
(function (root) {
  'use strict';
  var VERSION = 1;
  // The relay every app uses unless told otherwise. Override with create({relay}), window.INVISIBLE_HANDS_RELAY,
  // or ?relay=wss://... in the address.
  var DEFAULT_RELAY = 'wss://invisible-hands.samuelling.workers.dev';
  var WORDS = ('moss kiln opal fern dusk reed salt wren pine silk rust plum mint coal lark dune ' +
    'echo flax gale haze iris jade kelp loam moth nest onyx peat quay rook sage tide ' +
    'vole wasp yarn zinc bark clay dove elm fawn glow hush ink jute knot lime mist ' +
    'nook oat pond rye soot teal umber vine wick yew birch crow drift ember frost grain').split(' ');
  var ROOM = /^[a-z0-9][a-z0-9-]{3,47}$/;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function rand(n) {
    var a = new Uint32Array(1);
    if (root.crypto && root.crypto.getRandomValues) { root.crypto.getRandomValues(a); return a[0] % n; }
    return Math.floor(Math.random() * n);
  }
  // four words and two digits: easy to read out, and too many to stumble on (about 1.5 billion)
  function makeCode() { var w = []; for (var i = 0; i < 4; i++) w.push(WORDS[rand(WORDS.length)]); return w.join('-') + '-' + (10 + rand(90)); }
  function cleanCode(c) { c = String(c || '').trim().toLowerCase().replace(/\s+/g, '-'); return ROOM.test(c) ? c : null; }
  function query(name) {
    try { return new URLSearchParams(root.location.search).get(name); } catch (err) { return null; }
  }
  function okRelay(u) { return typeof u === 'string' && /^(wss:\/\/[^\s]+|ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?)$/.test(u) ? u.replace(/\/+$/, '') : ''; }

  function create(opts) {
    opts = opts || {};
    var app = String(opts.app || 'app'), name = String(opts.name || app);
    var params = (opts.params || []).slice(), outs = (opts.outs || []).slice();
    var relayFromQuery = okRelay(query('relay'));
    var relay = okRelay(opts.relay) || relayFromQuery || okRelay(root.INVISIBLE_HANDS_RELAY) || okRelay(DEFAULT_RELAY);
    var stateHz = opts.stateHz || 15;
    var ws = null, room = null, id = null, status = 'off', wanted = false, tries = 0, retryTimer = 0, pingTimer = 0, stateTimer = 0;
    var peers = new Map(), listeners = {}, allow = opts.allow !== false, offset = 0, rtt = null;
    var ramps = new Map(), base = new Map(), sent = {}, sentAll = 0, pings = {}, pingN = 0, lastError = '';

    function emit(ev, a, b) { (listeners[ev] || []).slice().forEach(function (fn) { try { fn(a, b); } catch (err) { if (root.console) root.console.error(err); } }); }
    function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return function () { listeners[ev] = (listeners[ev] || []).filter(function (f) { return f !== fn; }); }; }
    function setStatus(s) { if (s !== status) { status = s; emit('status', s); } }
    function param(pid) { for (var i = 0; i < params.length; i++) if (params[i].id === pid) return params[i]; return null; }
    function read(p) { try { var v = +p.get(); return isFinite(v) ? clamp(v, 0, 1) : 0; } catch (err) { return 0; } }
    function send(obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); return true; } catch (err) {} } return false; }
    function target(to) { return to && typeof to === 'object' ? to.id : to; }

    function describe(to) {
      var m = { t: 'describe',
        params: params.map(function (p) { return { id: p.id, label: p.label || p.id, kind: p.kind || 'cont', value: read(p) }; }),
        outs: outs.map(function (o) { return { id: o.id, label: o.label || o.id }; }) };
      if (to) m.to = to;
      send(m);
    }

    // ---- what arrives ----
    function stopRamp(pid) { var r = ramps.get(pid); if (r) { clearTimeout(r.timer); ramps.delete(pid); } }
    function applySet(p, v) { stopRamp(p.id); base.set(p.id, v); try { p.set(v); } catch (err) {} }
    function applyMod(p, v) {
      if (typeof p.mod === 'function') { try { p.mod(v); } catch (err) {} return; }
      // no mod of its own: swing around wherever the control stood when the modulation began
      if (!base.has(p.id)) base.set(p.id, read(p));
      try { p.set(clamp(base.get(p.id) + v, 0, 1)); } catch (err) {}
    }
    // a ramp is played here, against this machine's clock, so network jitter cannot roughen it
    function applyRamp(p, pts, at) {
      stopRamp(p.id);
      var t0 = at ? at - offset : Date.now(), from = read(p), total = 0, i;
      for (i = 0; i < pts.length; i++) total += pts[i][0];
      var r = { timer: 0 };
      ramps.set(p.id, r);
      (function tick() {
        var t = Date.now() - t0, v = from, acc = 0, prev = from, done = t >= total;
        if (done) v = pts[pts.length - 1][1];
        else if (t > 0) for (i = 0; i < pts.length; i++) {
          var d = pts[i][0];
          if (t <= acc + d) { v = d > 0 ? prev + (pts[i][1] - prev) * (t - acc) / d : pts[i][1]; break; }
          acc += d; prev = pts[i][1];
        }
        try { p.set(clamp(v, 0, 1)); } catch (err) {}
        if (done) { ramps.delete(p.id); base.set(p.id, v); } else r.timer = setTimeout(tick, 16);
      })();
    }

    function onMessage(ev) {
      var m; try { m = JSON.parse(ev.data); } catch (err) { return; }
      if (!m || typeof m !== 'object') return;
      var peer = m.from ? peers.get(m.from) : null, p;
      switch (m.t) {
        case 'welcome':
          id = m.id; offset = (+m.now || Date.now()) - Date.now(); tries = 0; lastError = '';
          peers.clear();
          (m.peers || []).forEach(function (q) { peers.set(q.id, { id: q.id, app: q.app, name: q.name, params: [], outs: [], state: {} }); });
          setStatus('on'); describe(); ping(); emit('peers', api.peers);
          break;
        case 'join':
          if (m.peer && m.peer.id) { peers.set(m.peer.id, { id: m.peer.id, app: m.peer.app, name: m.peer.name, params: [], outs: [], state: {} }); describe(m.peer.id); sentAll = 0; emit('peers', api.peers); }
          break;
        case 'leave':
          if (peers.delete(m.id)) emit('peers', api.peers);
          break;
        case 'describe':
          if (peer) { peer.params = Array.isArray(m.params) ? m.params : []; peer.outs = Array.isArray(m.outs) ? m.outs : []; emit('peers', api.peers); }
          break;
        case 'state':
          if (peer && m.outs) { for (var k in m.outs) peer.state[k] = m.outs[k]; emit('state', peer); }
          break;
        case 'set': case 'mod': case 'ramp':
          p = param(m.p);
          if (!p || !allow) break;
          if (m.t === 'set' && typeof m.v === 'number') applySet(p, clamp(m.v, 0, 1));
          else if (m.t === 'mod' && typeof m.v === 'number') applyMod(p, clamp(m.v, -1, 1));
          else if (m.t === 'ramp' && Array.isArray(m.pts) && m.pts.length) applyRamp(p, m.pts, m.at);
          emit('in', { from: m.from, p: m.p, t: m.t });
          break;
        case 'pong':
          if (pings[m.n]) {
            var now = Date.now(), trip = now - pings[m.n]; delete pings[m.n];
            if (rtt === null || trip <= rtt * 1.5) { rtt = rtt === null ? trip : Math.min(rtt, trip) * 0.7 + trip * 0.3; offset = m.now - (now - trip / 2); }
          }
          break;
        case 'error':
          emit('error', m.code);
          break;
      }
    }
    function ping() { var n = ++pingN; pings[n] = Date.now(); send({ t: 'ping', n: n }); }

    // ---- what goes out by itself: this app's own outputs, a few times a second, only when they change ----
    function publish() {
      if (status !== 'on' || !peers.size || !outs.length) return;
      var now = Date.now(), all = now - sentAll > 2000, o = {}, n = 0;
      outs.forEach(function (q) { var v = read(q); if (all || sent[q.id] === undefined || Math.abs(v - sent[q.id]) > 0.002) { o[q.id] = Math.round(v * 10000) / 10000; sent[q.id] = v; n++; } });
      if (all) sentAll = now;
      if (n) send({ t: 'state', outs: o });
    }

    // ---- the connection ----
    function open() {
      clearTimeout(retryTimer);
      if (!relay) { lastError = 'No relay address is set.'; setStatus('error'); return; }
      setStatus(tries ? 'retrying' : 'connecting');
      var sock;
      try { sock = new WebSocket(relay + '/room/' + room + '?app=' + encodeURIComponent(app) + '&name=' + encodeURIComponent(name)); }
      catch (err) { lastError = 'The relay address is not usable.'; setStatus('error'); return; }
      ws = sock;
      sock.onmessage = onMessage;
      sock.onclose = function () {
        if (ws !== sock) return;
        ws = null; id = null;
        if (peers.size) { peers.clear(); emit('peers', api.peers); }
        if (!wanted) { setStatus('off'); return; }
        tries++; lastError = 'Cannot reach the relay. Trying again.';
        setStatus('retrying');
        retryTimer = setTimeout(open, Math.min(15000, 500 * Math.pow(2, Math.min(tries, 5))));
      };
      sock.onerror = function () {};
    }
    function join(code) {
      var c = cleanCode(code);
      if (!c) { lastError = 'Room codes are 4 to 48 letters, digits and hyphens.'; emit('status', status); return false; }
      leave(); room = c; wanted = true; tries = 0; lastError = '';
      open();
      clearInterval(pingTimer); pingTimer = setInterval(function () { if (status === 'on') ping(); }, 10000);
      clearInterval(stateTimer); stateTimer = setInterval(publish, Math.round(1000 / stateHz));
      return true;
    }
    function leave() {
      wanted = false; clearTimeout(retryTimer); clearInterval(pingTimer); clearInterval(stateTimer);
      ramps.forEach(function (r) { clearTimeout(r.timer); }); ramps.clear(); base.clear(); sent = {};
      var s = ws; ws = null; id = null; room = null;
      if (s) { try { s.close(1000, 'bye'); } catch (err) {} }
      if (peers.size) { peers.clear(); emit('peers', api.peers); }
      setStatus('off');
    }
    function inviteUrl() {
      if (!room) return '';
      try {
        var u = new URL(root.location.href);
        u.searchParams.set('room', room);
        if (relayFromQuery) u.searchParams.set('relay', relayFromQuery);
        return u.toString();
      } catch (err) { return ''; }
    }

    // ---- the optional panel: plain elements that take the host page's font and colour ----
    function panel() {
      var doc = root.document;
      if (!doc.getElementById('ih-style')) {
        var st = doc.createElement('style'); st.id = 'ih-style';
        st.textContent = '.ih{font:inherit;color:inherit;display:flex;flex-direction:column;gap:12px;max-width:440px}' +
          '.ih-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
          '.ih button,.ih input[type=text]{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-color:color-mix(in srgb,currentColor 40%,transparent);border-radius:999px;padding:7px 14px;min-height:38px;cursor:pointer}' +
          '.ih input[type=text]{flex:1;min-width:130px;border-radius:10px;cursor:text}' +
          '.ih button:disabled{opacity:.45;cursor:default}' +
          '.ih-dot{flex:none;width:10px;height:10px;border-radius:50%;background:currentColor;opacity:.3}.ih-dot.on{opacity:1;background:#5fe0c0}.ih-dot.wait{opacity:.8;background:#e8b04a}' +
          '.ih-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.05em;letter-spacing:.03em;user-select:all;-webkit-user-select:all;word-break:break-all}' +
          '.ih-peers{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}.ih-peers li{padding:0;margin:0}.ih-peers li::before{content:none}' +
          '.ih-note{margin:0;opacity:.72;font-size:.9em;line-height:1.4}.ih label{display:flex;gap:8px;align-items:center;cursor:pointer}';
        doc.head.appendChild(st);
      }
      var el = function (tag, cls, txt) { var e = doc.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
      var box = el('div', 'ih'), copied = 0;
      function draw() {
        while (box.firstChild) box.removeChild(box.firstChild);
        var row = el('div', 'ih-row'), dot = el('span', 'ih-dot' + (status === 'on' ? ' on' : status === 'connecting' || status === 'retrying' ? ' wait' : ''));
        var words = status === 'on' ? 'Linked' : status === 'connecting' ? 'Connecting…' : status === 'retrying' ? 'Reconnecting…' : status === 'error' ? 'Not linked' : 'Not linked';
        row.appendChild(dot); row.appendChild(el('span', '', words)); box.appendChild(row);
        if (lastError && status !== 'on') box.appendChild(el('p', 'ih-note', lastError));
        if (room) {
          var r2 = el('div', 'ih-row'); r2.appendChild(el('span', '', 'Room')); r2.appendChild(el('span', 'ih-code', room)); box.appendChild(r2);
          var r3 = el('div', 'ih-row'), copy = el('button', '', Date.now() - copied < 1500 ? 'Copied' : 'Copy invite link'), bye = el('button', '', 'Leave');
          copy.type = bye.type = 'button';
          copy.onclick = function () {
            var u = inviteUrl(), done = function () { copied = Date.now(); draw(); setTimeout(draw, 1600); };
            if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) root.navigator.clipboard.writeText(u).then(done, function () { root.prompt && root.prompt('Copy this link', u); });
            else if (root.prompt) root.prompt('Copy this link', u);
          };
          bye.onclick = function () { leave(); };
          r3.appendChild(copy); r3.appendChild(bye); box.appendChild(r3);
          var list = el('ul', 'ih-peers');
          if (!peers.size) list.appendChild(el('li', 'ih-note', status === 'on' ? 'Nobody else is here yet. Send them the invite link.' : ''));
          peers.forEach(function (p) { list.appendChild(el('li', '', p.name + ' · ' + p.params.length + (p.params.length === 1 ? ' control' : ' controls'))); });
          box.appendChild(list);
        } else {
          var r4 = el('div', 'ih-row'), start = el('button', '', 'Start a room'); start.type = 'button';
          start.onclick = function () { join(makeCode()); };
          r4.appendChild(start); box.appendChild(r4);
          var r5 = el('div', 'ih-row'), inp = el('input'), go = el('button', '', 'Join'); go.type = 'button';
          inp.type = 'text'; inp.placeholder = 'room code'; inp.autocapitalize = 'none'; inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('aria-label', 'Room code');
          var doJoin = function () { if (!join(inp.value)) draw(); };
          go.onclick = doJoin; inp.onkeydown = function (e) { if (e.key === 'Enter') doJoin(); };
          r5.appendChild(inp); r5.appendChild(go); box.appendChild(r5);
        }
        if (params.length) {   // an app with nothing to move has nothing to switch off
          var lab = el('label'), cb = el('input'); cb.type = 'checkbox'; cb.checked = allow;
          cb.onchange = function () { api.allow = cb.checked; };
          lab.appendChild(cb); lab.appendChild(el('span', '', 'Let others move my controls')); box.appendChild(lab);
          box.appendChild(el('p', 'ih-note', 'Only numbers travel between apps. Untick the box, or leave the room, to take your controls back.'));
        } else box.appendChild(el('p', 'ih-note', 'Only numbers travel between apps.'));
      }
      on('status', draw); on('peers', draw);
      draw();
      return box;
    }

    var api = {
      version: VERSION,
      get room() { return room; }, get id() { return id; }, get status() { return status; }, get error() { return lastError; },
      get relay() { return relay; }, set relay(u) { relay = okRelay(u); },
      get peers() { return Array.from(peers.values()); },
      get allow() { return allow; }, set allow(v) { allow = !!v; if (!allow) { ramps.forEach(function (r) { clearTimeout(r.timer); }); ramps.clear(); } emit('allow', allow); },
      get latency() { return rtt === null ? null : Math.round(rtt / 2); },
      on: on, join: join, leave: leave, makeCode: makeCode, inviteUrl: inviteUrl, panel: panel,
      newRoom: function () { var c = makeCode(); join(c); return c; },
      describe: function () { describe(); },                        // call again if your controls change
      serverNow: function () { return Date.now() + offset; },         // the relay's clock, for timed ramps
      // sending: `to` is a peer (or its id), 'app:<slug>' for every copy of an app, or nothing for everyone
      set: function (to, p, v) { return send({ t: 'set', to: target(to) || undefined, p: p, v: clamp(+v, 0, 1) }); },
      mod: function (to, p, v) { return send({ t: 'mod', to: target(to) || undefined, p: p, v: clamp(+v, -1, 1) }); },
      ramp: function (to, p, pts, at) { var m = { t: 'ramp', to: target(to) || undefined, p: p, pts: pts }; if (at) m.at = at; return send(m); }
    };
    var auto = opts.autoJoin === false ? null : cleanCode(query('room'));
    if (auto) join(auto);
    return api;
  }

  root.InvisibleHands = { create: create, makeCode: makeCode, version: VERSION };
})(typeof window !== 'undefined' ? window : globalThis);
