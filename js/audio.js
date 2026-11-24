// Sound out: internal multi-timbral voices (AudioWorklet) + Web MIDI.
const Sound = (() => {
  let ctx = null, node = null, master = null, wet = null, dry = null, bus = null, ready = false;
  let revIn = null, dIn = null, dL = null, dR = null, fbL = null, fbR = null;
  const D = {on: true, time: 0.38, fb: 0.4, mix: 0.3, depth: 0.6};   // echo settings (the drawer's sliders)
  const M = {mx: 0, my: 0, s: 0};                                     // the fly's motion: rightward, upward, strength
  const now = {tL: 0.38, tR: 0.38, fb: 0.4, send: 0};
  let ear = null;   // The Tonnectome: {node, own, mic, micSrc} — the fly's antenna listening to the instrument and/or the microphone
  let midi = null, out = null;
  const pending = [];

  async function start() {
    if (ctx) { if (ctx.state === 'suspended') await ctx.resume(); return true; }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.7; master.connect(ctx.destination);
    bus = ctx.createGain(); bus.connect(master);            // everything the instrument makes, before the volume control
    dry = ctx.createGain(); dry.gain.value = 0.8; dry.connect(bus);
    const rev = ctx.createConvolver(); rev.buffer = impulse(3.2, 2.5);
    wet = ctx.createGain(); wet.gain.value = 0.35; rev.connect(wet); wet.connect(bus);
    revIn = ctx.createGain(); revIn.gain.value = 1; revIn.connect(rev);      // the reverb's on/off: its tail rings out
    // echo: a ping-pong delay (left echo feeds the right and back), darkened a little on each repeat; the fly's
    // motion read-out can push its times, feedback and send around (setMotion)
    dIn = ctx.createGain(); dIn.gain.value = 0;
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    dL = ctx.createDelay(3); dR = ctx.createDelay(3); fbL = ctx.createGain(); fbR = ctx.createGain();
    const tL = ctx.createBiquadFilter(), tR = ctx.createBiquadFilter(); tL.type = tR.type = 'lowpass'; tL.frequency.value = tR.frequency.value = 3800;
    dIn.connect(split); split.connect(dL, 0); split.connect(dR, 1);
    dL.connect(tL); tL.connect(fbL); fbL.connect(dR);
    dR.connect(tR); tR.connect(fbR); fbR.connect(dL);
    dL.connect(merge, 0, 0); dR.connect(merge, 0, 1);
    const dOut = ctx.createGain(); dOut.gain.value = 0.9; merge.connect(dOut); dOut.connect(bus); dOut.connect(revIn);
    applyDelay(true);
    try {
      await ctx.audioWorklet.addModule('js/voices-worklet.js' + (window.FH_V ? '?v=' + window.FH_V : ''));
      node = new AudioWorkletNode(ctx, 'voices', {outputChannelCount: [2]});
      node.connect(dry); node.connect(revIn); node.connect(dIn);
      ready = true;
    } catch (e) {
      console.warn('AudioWorklet unavailable, using oscillator voices', e);
      node = {fallback: true, rev: revIn, dly: dIn}; ready = true;
    }
    return true;
  }

  function impulse(sec, decay) {
    const len = Math.round(ctx.sampleRate * sec), b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return b;
  }

  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  // note: {midi, vel 0..1, pan -1..1, dur s, engine, p (engine params), channel}
  function play(n, opts) {
    if (opts.internal && ready) {
      if (!node.fallback) node.port.postMessage({engine: n.engine, freq: mtof(n.midi), vel: n.vel, pan: n.pan, dur: n.dur, p: n.p});
      else oscVoice(n);
    }
    if (opts.midi && out) {
      const ch = (n.channel || 0) & 15, note = Math.max(0, Math.min(127, Math.round(n.midi))), v = Math.max(1, Math.min(127, Math.round(n.vel * 127)));
      out.send([0x90 | ch, note, v]);
      out.send([0x80 | ch, note, 0], performance.now() + n.dur * 1000);
    }
  }

  function oscVoice(n) {
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner();
    o.type = 'triangle'; o.frequency.value = mtof(n.midi);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25 * n.vel, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3 + 2 * n.dur);
    p.pan.value = n.pan; o.connect(g); g.connect(p); p.connect(dry); p.connect(node.rev); p.connect(node.dly);
    o.start(t); o.stop(t + 0.4 + 2 * n.dur);
  }

  async function initMIDI() {
    if (!navigator.requestMIDIAccess) return [];
    try { midi = await navigator.requestMIDIAccess(); } catch (e) { return []; }
    return Array.from(midi.outputs.values()).map(o => ({id: o.id, name: o.name}));
  }
  function setOutput(id) { out = midi && id ? midi.outputs.get(id) || null : null; }
  function allNotesOff() { if (out) for (let c = 0; c < 16; c++) out.send([0xB0 | c, 123, 0]); }
  // The Tonnectome: route the instrument's own sound (and optionally the microphone) into the ear filterbank,
  // which posts its frames straight to the ear-network worker through `port`
  async function attachEar(port) {
    if (!ctx || ear) return !!ear;
    try {
      await ctx.audioWorklet.addModule('js/ear-worklet.js' + (window.FH_V ? '?v=' + window.FH_V : ''));
      const n = new AudioWorkletNode(ctx, 'ear', {numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit'});
      const own = ctx.createGain(), mic = ctx.createGain(), mute = ctx.createGain(); own.gain.value = 1; mic.gain.value = 0; mute.gain.value = 0;
      bus.connect(own); own.connect(n); mic.connect(n); n.connect(mute); mute.connect(ctx.destination);
      n.port.postMessage({port}, [port]);
      ear = {node: n, own, mic, micSrc: null};
      return true;
    } catch (e) { console.warn('ear unavailable', e); return false; }
  }
  // source: 'own' | 'mic' | 'both'; level scales what the ear hears
  async function setEarSource(source, level = 1) {
    if (!ear) return false;
    if ((source === 'mic' || source === 'both') && !ear.micSrc) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
        ear.micSrc = ctx.createMediaStreamSource(s); ear.micSrc.connect(ear.mic);
      } catch (e) { console.warn('microphone unavailable', e); source = 'own'; }
    }
    ear.own.gain.value = source === 'mic' ? 0 : level;
    ear.mic.gain.value = source === 'own' ? 0 : 3 * level;   // microphones arrive much quieter than the instrument
    return source;
  }
  function setVolume(v) { if (master) master.gain.value = v; }
  function setReverb(v) { if (wet) wet.gain.value = v; }
  function setReverbOn(on) { if (revIn) revIn.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.03); }
  // Echo, pushed by motion. With depth d: sideways motion pulls the two echo times apart (they lean the way the scene
  // moves; while they shift the repeats bend in pitch, like tape), upward motion raises the feedback and downward
  // lowers it, and the send follows the motion's strength, so a still scene lets the echo fall quiet.
  function applyDelay(jump) {
    const d = D.depth, c = v => Math.max(0.02, Math.min(2.5, v));
    now.tL = c(D.time * (1 + 0.6 * d * M.mx)); now.tR = c(D.time * (1 - 0.6 * d * M.mx));
    now.fb = Math.max(0, Math.min(0.92, D.fb + 0.35 * d * M.my));
    now.send = D.on ? D.mix * (1 - d + d * M.s) : 0;
    if (!dIn) return;
    const t = ctx.currentTime, tc = jump ? 0.01 : 0.12;
    dL.delayTime.setTargetAtTime(now.tL, t, tc); dR.delayTime.setTargetAtTime(now.tR, t, tc);
    fbL.gain.setTargetAtTime(now.fb, t, 0.08); fbR.gain.setTargetAtTime(now.fb, t, 0.08);
    dIn.gain.setTargetAtTime(now.send, t, 0.08);
  }
  function setDelay(o) { Object.assign(D, o); applyDelay(); }
  function setMotion(mx, my, s) { M.mx = mx; M.my = my; M.s = s; applyDelay(); }
  return {start, play, initMIDI, setOutput, allNotesOff, setVolume, setReverb, setReverbOn, setDelay, setMotion, get echo() { return now; }, attachEar, setEarSource, running: () => !!ctx && ctx.state === 'running'};
})();
