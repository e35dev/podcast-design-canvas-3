// app/audio.js — the episode audio engine. Builds ONE Web Audio graph that taps
// each speaker <video> (createMediaElementSource can only run once per element),
// runs the mix through real processing nodes — leveling (make-up gain), speech
// clarity (a presence EQ boost) and noise reduction (a high-pass that cuts low
// rumble) — and fans the result out to BOTH the speakers (live preview) and a
// MediaStreamDestination the exporter records. Controls change the node params,
// so the change is audible immediately and is captured in the export. Classic
// script on window.PDC.audio.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  // Preset values per control. Chosen so each non-off preset makes an audible,
  // measurable change to the signal (level and/or spectrum).
  const PRESETS = {
    leveling: { off: { gain: 1.0 }, auto: { gain: 1.7 } },
    clarity: { off: { freq: 3000, gain: 0 }, voice: { freq: 3000, gain: 9 } },
    noise: { off: { freq: 20 }, reduce: { freq: 220 } },
  };

  function createAudioEngine() {
    let ctx = null, leveling = null, clarity = null, noise = null, analyser = null, exportDest = null;
    const tapped = new WeakSet();
    let enabled = false;
    const state = { leveling: "off", clarity: "off", noise: "off" };

    function videos() {
      return [...document.querySelectorAll("video[data-speaker]")].filter((v) => v.src && v.src.indexOf("blob:") === 0);
    }

    function ensureGraph() {
      if (ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      leveling = ctx.createGain();
      clarity = ctx.createBiquadFilter();
      clarity.type = "peaking"; clarity.frequency.value = 3000; clarity.Q.value = 1; clarity.gain.value = 0;
      noise = ctx.createBiquadFilter();
      noise.type = "highpass"; noise.frequency.value = 20;
      analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
      exportDest = ctx.createMediaStreamDestination();
      leveling.connect(clarity); clarity.connect(noise); noise.connect(analyser);
      analyser.connect(ctx.destination);
      analyser.connect(exportDest);
      applyState();
    }

    function tapVideo(v) {
      if (tapped.has(v)) return;
      try {
        const src = ctx.createMediaElementSource(v);
        src.connect(leveling);
        tapped.add(v);
      } catch (e) { /* already tapped or unsupported */ }
    }

    function applyState() {
      if (!ctx) return;
      leveling.gain.value = PRESETS.leveling[state.leveling].gain;
      clarity.gain.value = PRESETS.clarity[state.clarity].gain;
      clarity.frequency.value = PRESETS.clarity[state.clarity].freq;
      noise.frequency.value = PRESETS.noise[state.noise].freq;
    }

    async function enable() {
      ensureGraph();
      if (ctx.state === "suspended") { try { await ctx.resume(); } catch (e) {} }
      // Route each speaker through Web Audio and unmute so real signal flows to
      // both the speakers and the export (a muted element taps to silence).
      videos().forEach((v) => { tapVideo(v); v.muted = false; });
      enabled = true;
      return true;
    }

    function retap() {
      if (!enabled) return;
      videos().forEach((v) => { tapVideo(v); v.muted = false; });
    }

    function set(kind, preset) {
      if (PRESETS[kind] && PRESETS[kind][preset]) { state[kind] = preset; applyState(); }
      return { ...state };
    }

    // RMS of the current processed signal (0..1) — drives the visible meter and
    // makes a control change observable.
    function level() {
      if (!analyser) return 0;
      const buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
      return Math.sqrt(sum / buf.length);
    }

    function exportAudioTracks() {
      return exportDest ? exportDest.stream.getAudioTracks() : [];
    }

    // The live processing parameters actually applied to the audio graph. These
    // change deterministically with the controls (no audio hardware required),
    // so they are a reliable signal that a setting changes the processed mix.
    function params() {
      if (!ctx) return { levelingGain: PRESETS.leveling[state.leveling].gain, clarityGain: PRESETS.clarity[state.clarity].gain, noiseFreq: PRESETS.noise[state.noise].freq };
      return { levelingGain: leveling.gain.value, clarityGain: clarity.gain.value, noiseFreq: noise.frequency.value };
    }

    return {
      enable, retap, set, level, exportAudioTracks, params,
      isEnabled: () => enabled,
      state: () => ({ ...state }),
      presets: PRESETS,
    };
  }

  PDC.audio = createAudioEngine();
})();
