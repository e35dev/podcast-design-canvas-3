// app/audio.js — preview audio routing and automatic speaker leveling via Web Audio.
// Videos stay muted on the element; audible output is mixed here so creators can
// balance uneven speaker loudness in the live preview without re-uploading.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  const LEVELING_OFF = "off";
  const LEVELING_BALANCED = "balanced";
  const MAX_BOOST = 4;
  const MIN_RMS = 0.00008;

  function measureRms(analyser) {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length);
  }

  function measureBufferRms(audioBuf) {
    const channels = audioBuf.numberOfChannels;
    const len = audioBuf.length;
    if (!len || !channels) return 0;
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      const data = audioBuf.getChannelData(ch);
      for (let i = 0; i < len; i++) sum += data[i] * data[i];
    }
    return Math.sqrt(sum / (len * channels));
  }

  function createAudioMixer() {
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx = null;
    let masterGain = null;
    const speakers = {};
    const sourceRms = {};
    let levelingMode = LEVELING_OFF;
    let muted = true;

    function ensureCtx() {
      if (!ctx && AC) {
        ctx = new AC();
        masterGain = ctx.createGain();
        masterGain.gain.value = 0;
        masterGain.connect(ctx.destination);
      }
      return ctx;
    }

    function resumeIfNeeded() {
      if (!ctx || ctx.state !== "suspended") return Promise.resolve();
      return ctx.resume().catch(function () {});
    }

    async function measureSourceRms(videoEl) {
      const c = ensureCtx();
      if (!c || !videoEl || !videoEl.src) return 0;
      try {
        const resp = await fetch(videoEl.src);
        const buf = await resp.arrayBuffer();
        const audioBuf = await c.decodeAudioData(buf.slice(0));
        return measureBufferRms(audioBuf);
      } catch (e) {
        return 0;
      }
    }

    function connectSpeaker(bucket, videoEl) {
      const c = ensureCtx();
      if (!c || !videoEl) return;
      if (speakers[bucket] && speakers[bucket].video === videoEl) return;
      disconnectSpeaker(bucket);
      try {
        const source = c.createMediaElementSource(videoEl);
        const gain = c.createGain();
        gain.gain.value = 1;
        const analyser = c.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(gain);
        gain.connect(analyser);
        analyser.connect(masterGain);
        speakers[bucket] = { source: source, gain: gain, analyser: analyser, video: videoEl };
      } catch (e) {
        /* element may already be tapped elsewhere */
      }
    }

    async function analyzeSpeaker(bucket, videoEl) {
      connectSpeaker(bucket, videoEl);
      sourceRms[bucket] = await measureSourceRms(videoEl);
      await applyLeveling();
    }

    function disconnectSpeaker(bucket) {
      const chain = speakers[bucket];
      if (!chain) return;
      try {
        chain.source.disconnect();
        chain.gain.disconnect();
        chain.analyser.disconnect();
      } catch (e) {}
      delete speakers[bucket];
      delete sourceRms[bucket];
    }

    function setRawGains() {
      Object.keys(speakers).forEach(function (b) {
        speakers[b].gain.gain.value = 1;
      });
    }

    function readingsFromSources() {
      return Object.keys(speakers).map(function (b) {
        return { bucket: b, rms: sourceRms[b] || 0 };
      });
    }

    function readingsFromAnalysers() {
      return Object.keys(speakers).map(function (b) {
        return { bucket: b, rms: measureRms(speakers[b].analyser) };
      });
    }

    function applyGainsFromReadings(readings) {
      const active = readings.filter(function (r) {
        return r.rms > MIN_RMS;
      });
      if (active.length < 2) {
        setRawGains();
        return false;
      }
      const target = active.reduce(function (s, r) {
        return s + r.rms;
      }, 0) / active.length;
      active.forEach(function (r) {
        const boost = Math.min(MAX_BOOST, target / r.rms);
        speakers[r.bucket].gain.gain.value = boost;
      });
      return true;
    }

    async function applyLeveling() {
      const buckets = Object.keys(speakers);
      if (levelingMode !== LEVELING_BALANCED || buckets.length < 2) {
        setRawGains();
        return;
      }
      await resumeIfNeeded();
      if (applyGainsFromReadings(readingsFromSources())) return;
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise(function (r) {
          setTimeout(r, 250);
        });
        if (applyGainsFromReadings(readingsFromAnalysers())) return;
      }
      setRawGains();
    }

    function setLeveling(mode) {
      levelingMode = mode === LEVELING_BALANCED ? LEVELING_BALANCED : LEVELING_OFF;
      applyLeveling();
    }

    function setMuted(isMuted) {
      muted = !!isMuted;
      if (!masterGain) return;
      masterGain.gain.value = muted ? 0 : 1;
      if (!muted) resumeIfNeeded();
    }

    function getSpeakerLevels() {
      const out = {};
      Object.keys(speakers).forEach(function (b) {
        const live = measureRms(speakers[b].analyser);
        if (live > MIN_RMS) out[b] = live;
        else if (sourceRms[b]) out[b] = sourceRms[b] * speakers[b].gain.gain.value;
        else out[b] = 0;
      });
      return out;
    }

    function getSpeakerGains() {
      const out = {};
      Object.keys(speakers).forEach(function (b) {
        out[b] = speakers[b].gain.gain.value;
      });
      return out;
    }

    return {
      connectSpeaker: connectSpeaker,
      analyzeSpeaker: analyzeSpeaker,
      disconnectSpeaker: disconnectSpeaker,
      setLeveling: setLeveling,
      setMuted: setMuted,
      getSpeakerLevels: getSpeakerLevels,
      getSpeakerGains: getSpeakerGains,
      applyLeveling: applyLeveling,
    };
  }

  PDC.audio = {
    LEVELING_OFF: LEVELING_OFF,
    LEVELING_BALANCED: LEVELING_BALANCED,
    createAudioMixer: createAudioMixer,
    measureRms: measureRms,
    measureBufferRms: measureBufferRms,
  };
})();
