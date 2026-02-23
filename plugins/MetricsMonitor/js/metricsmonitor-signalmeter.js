///////////////////////////////////////////////////////////////
//                                                           //
//  metricsmonitor-signalmeter.js                  (V2.4)    //
//                                                           //
//  by Highpoint               last update: 23.02.2026       //
//                                                           //
//  Thanks for support by                                    //
//  Jeroen Platenkamp, Bkram, Wötkylä, AmateurAudioDude,     //
//  GOR and Bojcha                                           //
//                                                           //
//  https://github.com/Highpoint2000/metricsmonitor          //
//                                                           //
///////////////////////////////////////////////////////////////

(() => {
const sampleRate = 192000;    // Do not touch - this value is automatically updated via the config file
const MPXmode = "auto";    // Do not touch - this value is automatically updated via the config file
const MPXStereoDecoder = "off";    // Do not touch - this value is automatically updated via the config file
const MPXInputCard = "Mikrofon (HD USB Audio Device)";    // Do not touch - this value is automatically updated via the config file
const MPXTiltCalibration = 0;    // Do not touch - this value is automatically updated via the config file
const VisualDelayMs = 275;    // Do not touch - this value is automatically updated via the config file
const MeterInputCalibration = -0.4;    // Do not touch - this value is automatically updated via the config file
const MeterPilotCalibration = 0;    // Do not touch - this value is automatically updated via the config file
const MeterMPXCalibration = 0;    // Do not touch - this value is automatically updated via the config file
const MeterRDSCalibration = 0;    // Do not touch - this value is automatically updated via the config file
const MeterPilotScale = 116.857176;    // Do not touch - this value is automatically updated via the config file
const MeterRDSScale = 132.2072;    // Do not touch - this value is automatically updated via the config file
const fftSize = 4096;    // Do not touch - this value is automatically updated via the config file
const SpectrumAttackLevel = 3;    // Do not touch - this value is automatically updated via the config file
const SpectrumDecayLevel = 15;    // Do not touch - this value is automatically updated via the config file
const SpectrumSendInterval = 30;    // Do not touch - this value is automatically updated via the config file
const SpectrumYOffset = -40;    // Do not touch - this value is automatically updated via the config file
const SpectrumYDynamics = 2;    // Do not touch - this value is automatically updated via the config file
const StereoBoost = 1.5;    // Do not touch - this value is automatically updated via the config file
const AudioMeterBoost = 1.2;    // Do not touch - this value is automatically updated via the config file
const MODULE_SEQUENCE = [0,1,2,5,3,4];    // Do not touch - this value is automatically updated via the config file
const CANVAS_SEQUENCE = [2,5,4];    // Do not touch - this value is automatically updated via the config file
const LockVolumeSlider = true;    // Do not touch - this value is automatically updated via the config file
const EnableSpectrumOnLoad = true;    // Do not touch - this value is automatically updated via the config file
const EnableAnalyzerAdminMode = false;    // Do not touch - this value is automatically updated via the config file
const MeterColorSafe = "rgb(0, 255, 0)";    // Do not touch - this value is automatically updated via the config file
const MeterColorWarning = "rgb(255, 255,0)";    // Do not touch - this value is automatically updated via the config file
const MeterColorDanger = "rgb(255, 0, 0)";    // Do not touch - this value is automatically updated via the config file
const PeakMode = "dynamic";    // Do not touch - this value is automatically updated via the config file
const PeakColorFixed = "rgb(251, 174, 38)";    // Do not touch - this value is automatically updated via the config file
const MeterTiltCalibration = -900;    // Do not touch - this value is automatically updated via the config file

const CONFIG = (window.MetricsMonitor && window.MetricsMonitor.Config) ? window.MetricsMonitor.Config : {};

  // ==========================================================
  // CSS FIXES FOR ZOOMING (Signal Meter specific)
  // ==========================================================
  const style = document.createElement('style');
  style.innerHTML = `
    /* Fix for sub-pixel rendering gaps on zoom */
    .signal-meter-bar .segment {
      border-bottom: 1px solid rgba(0,0,0,0.8) !important; 
      margin-bottom: 0 !important; 
      box-sizing: border-box;      
    }
    .segment.peak-flag {
      z-index: 10;
      box-shadow: 0 0 4px rgba(255, 255, 255, 0.4);
    }
  `;
  document.head.appendChild(style);

  // -------------------------------------------------------
  // Utility Functions
  // -------------------------------------------------------
  const HUB_KEY = '__MM_SIGNALMETER_HUB__';
  const cssEscape = (s) => {
    try {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(s));
    } catch {}
    return String(s).replace(/[^a-zA-Z0-9_\-]/g, '\\$&');
  };
  const uid = (prefix = 'mm-sigm-') => `${prefix}${Math.random().toString(36).slice(2, 10)}`;

  // --- COLOR HELPERS ---
  function parseRgb(rgbStr) {
    const match = rgbStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) {
      return { r: parseInt(match[1]), g: parseInt(match[2]), b: parseInt(match[3]) };
    }
    return { r: 0, g: 255, b: 0 }; // Default fallback
  }

  function applyIntensity(colorObj, intensity) {
      const r = Math.min(255, Math.round(colorObj.r * intensity));
      const g = Math.min(255, Math.round(colorObj.g * intensity));
      const b = Math.min(255, Math.round(colorObj.b * intensity));
      return `rgb(${r},${g},${b})`;
  }

  // -------------------------------------------------------
  // Unit Conversion
  // -------------------------------------------------------
  function hfBaseToDisplay(unit, baseHF) {
    const ssu = (unit || '').toLowerCase();
    const v = Number(baseHF);
    if (!isFinite(v)) return 0;
    if (ssu === 'dbuv' || ssu === 'dbµv' || ssu === 'dbμv') return v - 10.875;
    if (ssu === 'dbm') return v - 119.75;
    return v; // default dBf
  }

  function hfPercentFromBase(baseHF) {
    const v = Number(baseHF);
    if (!isFinite(v)) return 0;
    let dBuV = v - 10.875;
    if (isNaN(dBuV)) dBuV = 0;
    const clamped = Math.max(0, Math.min(90, dBuV));
    return (clamped / 90) * 100;
  }

  function buildHFScale(unit) {
    const baseScale_dBuV = [90, 80, 70, 60, 50, 40, 30, 20, 10, 0];
    const ssu = (unit || '').toLowerCase();
    const lastIndex = baseScale_dBuV.length - 1;

    const round10 = (v) => Math.round(v / 10) * 10;

    if (ssu === 'dbm') {
      return baseScale_dBuV.map((v, idx) => {
        const dBm = v - 108.875;
        const rounded = round10(dBm);
        return idx === lastIndex ? `${rounded} dBm` : `${rounded}`;
      });
    }
    if (ssu === 'dbf') {
      return baseScale_dBuV.map((v, idx) => {
        const dBf = v + 10.875;
        const rounded = round10(dBf);
        return idx === lastIndex ? `${rounded} dBf` : `${rounded}`;
      });
    }
    // default: dBµV
    return baseScale_dBuV.map((v, idx) => {
      const rounded = round10(v);
      return idx === lastIndex ? `${rounded} dBµV` : `${rounded}`;
    });
  }

  // -------------------------------------------------------
  // Meter Drawing Helpers (scoped to a root element)
  // -------------------------------------------------------
  function stereoColorForPercent(p, totalSegments = 30) {
    const i = Math.max(0, Math.min(totalSegments - 1, Math.round((p / 100) * totalSegments) - 1));
    // Changed from totalSegments - 5 to totalSegments - 4 to start red at 0.0 dB
    const topBandStart = totalSegments - 4;
    
    const cDanger = parseRgb(MeterColorDanger);
    const cSafe = parseRgb(MeterColorSafe);

    if (i >= topBandStart) {
      const intensity = 0.8 + (0.2 * (i / totalSegments)); 
      return applyIntensity(cDanger, intensity);
    }
    const intensity = 0.4 + ((i / totalSegments) * 0.6); 
    return applyIntensity(cSafe, intensity);
  }

function updatePeakValue(peaks, channel, current, holdMs, smoothing) {
  const p = peaks[channel];
  if (!p) return;

  const now = Date.now();

  if (current > p.value) {
    // New peak
    p.value = current;
    p.lastUpdate = now;
  } else if (now - p.lastUpdate > holdMs) {
    // Linear decay (instead of multiplicative smoothing)
    p.value = Math.max(current, p.value - 2.5);

    // Clamp to zero
    if (p.value < 0.5) p.value = 0;
  }
}

function setPeakSegment(meterEl, peak, meterId) {
  const segments = meterEl.querySelectorAll(".segment");
  if (!segments.length) return;

  // Remove ALL previous peak flags (not only the first one)
  const prevAll = meterEl.querySelectorAll(".segment.peak-flag");
  prevAll.forEach((prev) => {
    prev.classList.remove("peak-flag");
    // remove any inline styling we may have applied
    prev.style.removeProperty("background-color");
    prev.style.removeProperty("box-shadow");
    prev.style.removeProperty("opacity");
  });

  const idx = Math.max(
    0,
    Math.min(segments.length - 1, Math.round((peak / 100) * segments.length) - 1)
  );

  const seg = segments[idx];
  if (!seg) return;

  seg.classList.add("peak-flag");

  // Peak Color Logic
  let peakColor = "";

  if (PeakMode === "fixed" && (meterId.includes("left") || meterId.includes("right"))) {
    peakColor = PeakColorFixed;
  } else {
    if (meterId.includes("left") || meterId.includes("right")) {
      peakColor = stereoColorForPercent(peak, segments.length);
    } else if (meterId.includes("hf")) {
      const hfThresholdIndex = Math.round((20 / 90) * segments.length);
      if (idx < hfThresholdIndex) {
        const cDanger = parseRgb(MeterColorDanger);
        const pos = idx / Math.max(1, hfThresholdIndex);
        const intensity = 0.6 + (pos * 0.4);
        peakColor = applyIntensity(cDanger, intensity);
      } else {
        const cSafe = parseRgb(MeterColorSafe);
        const intensity = 0.4 + ((idx / segments.length) * 0.6);
        peakColor = applyIntensity(cSafe, intensity);
      }
    }
  }

  if (peakColor) {
    seg.style.setProperty("background-color", peakColor, "important");
  }
}

  function updateMeterById(root, meterId, level, peaks, peakCfg) {
    if (!root) return;
    const meter = root.querySelector(`#${cssEscape(meterId)}`);
    if (!meter) return;

    const safeLevel = Math.max(0, Math.min(100, Number(level) || 0));
    const segments = meter.querySelectorAll('.segment');
    const activeCount = Math.round((safeLevel / 100) * segments.length);

    // Parse Config Colors
    const cDanger = parseRgb(MeterColorDanger);
    const cSafe = parseRgb(MeterColorSafe);
    const cWarning = parseRgb(MeterColorWarning);

    // hard-reset any previous peak leftovers BEFORE painting the bar
    segments.forEach((seg) => {
    if (seg.classList.contains("peak-flag")) seg.classList.remove("peak-flag");
      // remove any "important" peak color from earlier frames
      seg.style.removeProperty("background-color");
    });

    // Paint bar normally
    segments.forEach((seg, i) => {
      // Check for peak flag first
      if (seg.classList.contains("peak-flag")) return; 

      if (i < activeCount) {
        if (meterId.includes('left') || meterId.includes('right')) {
          // Stereo: Safe (bottom) -> Danger (top)
          // Changed from segments.length - 5 to segments.length - 4 to start red at 0.0 dB
          if (i >= segments.length - 4) {
            const intensity = 0.8 + (0.2 * (i / segments.length)); 
            seg.style.backgroundColor = applyIntensity(cDanger, intensity);
          } else {
            const intensity = 0.4 + ((i / segments.length) * 0.6);
            seg.style.backgroundColor = applyIntensity(cSafe, intensity);
          }
        } else if (meterId.includes('hf')) {
          // HF: Danger (bottom/low signal) -> Safe (top/high signal)
          const hfThresholdIndex = Math.round((20 / 90) * segments.length);
          if (i < hfThresholdIndex) {
            // Danger Zone
            const pos = i / hfThresholdIndex;
            const intensity = 0.6 + (0.4 * pos);
            seg.style.backgroundColor = applyIntensity(cDanger, intensity);
          } else {
            // Safe Zone
            const pos = i / segments.length;
            const intensity = 0.4 + (0.6 * pos);
            seg.style.backgroundColor = applyIntensity(cSafe, intensity);
          }
        } else {
          // Fallback
          seg.style.backgroundColor = '#333';
        }
      } else {
        // Ensure inactive segments are visible as dark gray
        seg.style.backgroundColor = '#333';
      }
    });

    // Peak marker (apply to HF as well if needed in future, currently mainly stereo here logic-wise)
    const key = meterId.includes('left') ? 'left' : (meterId.includes('right') ? 'right' : null);
    
    // Only update stereo peaks here based on args
    if (key) {
      updatePeakValue(peaks, key, safeLevel, peakCfg.holdMs, peakCfg.smoothing);
      setPeakSegment(meter, peaks[key].value, meterId);
    } 
  }

  // -------------------------------------------------------
  // Shared Hub (Single Socket + Single Audio Loop)
  // -------------------------------------------------------

  // Logarithmic dB scale parameters for the UI Meter
  // Scale goes from +5dB down to -35dB (Total range: 40dB)
  const METER_MAX_DB = 5;
  const METER_MIN_DB = -35;
  const METER_RANGE = METER_MAX_DB - METER_MIN_DB;

  // Convert digital peak amplitude to dBFS, then map to 0-100% based on our custom scale
  function amplitudeToMeterPercent(amplitude) {
    // Prevent log(0) calculation error
    if (amplitude < 0.00001) return 0;
    
    // Use StereoBoost for this module specifically to maintain 0dB integrity when = 1.0
    const linear = amplitude * StereoBoost;
    
    // Calculate physically accurate decibel value (dBFS)
    const db = 20 * Math.log10(linear);

    // Map to the 0-100% visual scale range (+5 dB to -35 dB)
    if (db <= METER_MIN_DB) return 0;
    if (db >= METER_MAX_DB) return 100;

    return ((db - METER_MIN_DB) / METER_RANGE) * 100;
  }

  function createHub() {
    return {
      socket: null,
      connected: false,
      connecting: null,
      msgListenerAttached: false,

      // Registered instances (key -> instance)
      instances: new Map(), 

      // Latest values
      latestSigBase: null,
      unit: (window.MetricsMonitor && typeof window.MetricsMonitor.getSignalUnit === 'function')
        ? (window.MetricsMonitor.getSignalUnit() || 'dbf').toLowerCase()
        : (localStorage.getItem('mm_signal_unit') || 'dbf').toLowerCase(),

      // Shared exported levels
      sharedLevels: {
        hf: 0,
        hfValue: 0,
        hfBase: 0,
        left: 0,
        right: 0
      },

      ensureConnected() {
        if (this.connected) return Promise.resolve(this.socket);
        if (this.connecting) return this.connecting;

        this.connecting = (async () => {
          while (!window.socketPromise) {
            await new Promise(r => setTimeout(r, 400));
          }
          const ws = await window.socketPromise;
          if (!ws) return null;
          this.socket = ws;

          if (!this.msgListenerAttached) {
            this.msgListenerAttached = true;
            ws.addEventListener('message', (evt) => {
              try {
                const msg = JSON.parse(evt.data);
                if (msg && msg.sig !== undefined) {
                  this.broadcastSig(msg.sig);
                }
              } catch {}
            });
          }

          this.connected = true;
          return ws;
        })().finally(() => {});
        return this.connecting;
      },

      broadcastSig(baseValue) {
        const v = Number(baseValue);
        if (!isFinite(v)) return;
        this.latestSigBase = v;
        for (const inst of this.instances.values()) {
          try { inst._onSig(v); } catch {}
        }
      },

      setUnit(unit) {
        if (!unit) return;
        const u = String(unit).toLowerCase();
        this.unit = u;
        for (const inst of this.instances.values()) {
          try { inst._onUnit(u); } catch {}
        }
      },

      // -----------------------
      // Shared Audio Analyser (Exact Logic from AudioMeter)
      // -----------------------
      audio: {
        ctx: null,
        sourceNode: null,
        splitter: null,
        analyserL: null,
        analyserR: null,
        dataL: null,
        dataR: null,
        rafId: null,
        setupIntervalId: null,
        subscribers: new Set(),
        smoothedLevelL: 0,
        smoothedLevelR: 0,
      },

      ensureAudio() {
        const A = this.audio;
        
        // This function is called repeatedly via interval, just like in audiometer.js
        const trySetup = () => {
            if (
                typeof Stream === "undefined" ||
                !Stream ||
                !Stream.Fallback ||
                !Stream.Fallback.Player ||
                !Stream.Fallback.Player.Amplification
            ) {
                // Not ready yet
                return;
            }

            const player = Stream.Fallback.Player;
            const sourceNode = player.Amplification;

            if (!sourceNode || !sourceNode.context) return;

            try {
                const ctx = sourceNode.context;

                // Reset if context changed (tab changed, etc)
                if (A.ctx !== ctx) {
                    A.ctx = ctx;
                    A.splitter = null;
                    A.analyserL = null;
                    A.analyserR = null;
                    A.dataL = null;
                    A.dataR = null;
                    A.sourceNode = null;
                    A.smoothedLevelL = 0;
                    A.smoothedLevelR = 0;
                }

                if (!A.analyserL || !A.dataL) {
                     A.analyserL = ctx.createAnalyser();
                     A.analyserR = ctx.createAnalyser();
                     
                     // Increased FFT size for smoother and more accurate extraction
                     A.analyserL.fftSize = 4096;
                     A.analyserR.fftSize = 4096;
                     
                     // Initialize high precision 32-bit float arrays
                     A.dataL = new Float32Array(A.analyserL.fftSize);
                     A.dataR = new Float32Array(A.analyserR.fftSize);
                }

                // Check source node connection
                if (A.sourceNode !== sourceNode) {
                    A.sourceNode = sourceNode;
                    
                    if (!A.splitter) {
                        A.splitter = ctx.createChannelSplitter(2);
                        try { A.splitter.connect(A.analyserL, 0); } catch(e){}
                        try { A.splitter.connect(A.analyserR, 1); } catch(e){}
                    }
                    
                    try { 
                        A.sourceNode.connect(A.splitter); 
                    } catch(e) {
                        if (e.name !== 'InvalidAccessError') console.warn('SignalMeter Audio Connect Error:', e);
                    }
                }

                // Ensure loop is running
                if (!A.rafId) {
                   startAudioLoop();
                }

            } catch (e) {
                console.error("SignalMeter: Audio Setup Error", e);
            }
        };
        
        const startAudioLoop = () => {
            if (A.rafId) cancelAnimationFrame(A.rafId);

            const loop = () => {
                if (A.ctx && A.ctx.state === 'suspended') {
                    A.rafId = requestAnimationFrame(loop);
                    return;
                }

                if (A.analyserL && A.analyserR && A.dataL && A.dataR) {
                    // Use Float32Array to get exact waveform floats (-1.0 to 1.0) for highly accurate dB translation
                    A.analyserL.getFloatTimeDomainData(A.dataL);
                    A.analyserR.getFloatTimeDomainData(A.dataR);
                    
                    let maxL = 0;
                    let maxR = 0;
                    
                    // Extract absolute peak values representing true digital peak amplitude
                    for (let i = 0; i < A.dataL.length; i++) {
                        const absL = Math.abs(A.dataL[i]);
                        if (absL > maxL) maxL = absL;
                    }
                    for (let i = 0; i < A.dataR.length; i++) {
                        const absR = Math.abs(A.dataR[i]);
                        if (absR > maxR) maxR = absR;
                    }

                    // Convert accurate physical peak level to our UI percentage scale based on Log/dB
                    const rawTargetPercentL = amplitudeToMeterPercent(maxL);
                    const rawTargetPercentR = amplitudeToMeterPercent(maxR);
                    
                    // Apply asymmetric smoothing: fast attack, slow smooth decay
                    const attack = 0.8;
                    const decay = 0.15; // Controls how fast the visual meter smoothly drops
                    
                    A.smoothedLevelL += (rawTargetPercentL > A.smoothedLevelL) 
                        ? (rawTargetPercentL - A.smoothedLevelL) * attack 
                        : (rawTargetPercentL - A.smoothedLevelL) * decay;

                    A.smoothedLevelR += (rawTargetPercentR > A.smoothedLevelR) 
                        ? (rawTargetPercentR - A.smoothedLevelR) * attack 
                        : (rawTargetPercentR - A.smoothedLevelR) * decay;

                    let levelL = Math.min(100, Math.max(0, A.smoothedLevelL));
                    let levelR = Math.min(100, Math.max(0, A.smoothedLevelR));

                    this.sharedLevels.left = levelL;
                    this.sharedLevels.right = levelR;

                    for (const inst of A.subscribers) {
                        try { inst._onAudio(levelL, levelR); } catch {}
                    }
                }
                A.rafId = requestAnimationFrame(loop);
            };
            A.rafId = requestAnimationFrame(loop);
        };

        if (!A.setupIntervalId) {
            A.setupIntervalId = setInterval(trySetup, 1000);
            trySetup();
        }
      }
    };
  }

  const HUB = window[HUB_KEY] || (window[HUB_KEY] = createHub());

  // Synchronize hub with global unit changes
  if (!HUB._unitListenerAttached && window.MetricsMonitor && typeof window.MetricsMonitor.onSignalUnitChange === 'function') {
    HUB._unitListenerAttached = true;
    window.MetricsMonitor.onSignalUnitChange((u) => HUB.setUnit(u));
    // Initialize once
    try {
      if (window.MetricsMonitor.getSignalUnit) HUB.setUnit(window.MetricsMonitor.getSignalUnit());
    } catch {}
  }

  // -------------------------------------------------------
  // Instance Factory
  // -------------------------------------------------------
  function createInstance(containerOrEl = 'level-meter-container', opts = {}) {
    const root = (typeof containerOrEl === 'string')
      ? document.getElementById(containerOrEl)
      : containerOrEl;
    if (!root) return null;

    const instanceKey = String(opts.instanceKey || uid());
    const bindExisting = !!opts.bindExisting;
    const textOnly = !!opts.textOnly;
    const useLegacyIds = opts.useLegacyIds !== undefined ? !!opts.useLegacyIds : true;
    const enableAudio = opts.enableAudio !== undefined ? !!opts.enableAudio : (!textOnly);

    // Destroy existing instance if key collision
    if (HUB.instances.has(instanceKey)) {
      try { HUB.instances.get(instanceKey).destroy(); } catch {}
      HUB.instances.delete(instanceKey);
    }

    const PEAK_CONFIG = { smoothing: 0.85, holdMs: 5000 };
    const peaks = {
      left: { value: 0, lastUpdate: Date.now() },
      right: { value: 0, lastUpdate: Date.now() }
    };

    const state = {
      hfUnit: (HUB.unit || 'dbf').toLowerCase(),
      highestSignal: -Infinity,
      levels: {
        hf: 0,
        hfValue: 0,
        hfBase: 0,
        left: 0,
        right: 0
      },
      ids: {
        left: 'left-meter',
        right: 'right-meter',
        hf: 'hf-meter'
      }
    };

    // DOM Bindings
    const dom = {
      root,
      elHighest: null,
      elMain: null,
      elDec: null,
      unitEls: [],
      meterExists: false,
    };

    function bindTextElements() {
      // Prioritize data attributes for embedded/canvas usage
      dom.elHighest = root.querySelector('[data-mm-signal="highest"]') || root.querySelector('#data-signal-highest');
      dom.elMain = root.querySelector('[data-mm-signal="main"]') || root.querySelector('#data-signal');
      dom.elDec = root.querySelector('[data-mm-signal="decimal"]') || root.querySelector('#data-signal-decimal');
      dom.unitEls = Array.from(root.querySelectorAll('.signal-units'));
    }

    function createLevelMeter(id, label, container, scaleValues) {
      const levelMeter = document.createElement('div');
      levelMeter.classList.add('signal-level-meter');

      const top = document.createElement('div');
      top.classList.add('meter-top');

      const meterBar = document.createElement('div');
      meterBar.classList.add('signal-meter-bar');
      meterBar.setAttribute('id', id);

      for (let i = 0; i < 30; i++) {
        const segment = document.createElement('div');
        segment.classList.add('segment');
        // Set initial background color
        segment.style.backgroundColor = '#333'; 
        meterBar.appendChild(segment);
      }
      if (id.includes('left') || id.includes('right')) {
        const marker = document.createElement('div');
        marker.className = 'peak-marker';
        meterBar.appendChild(marker);
      }

      const labelElement = document.createElement('div');
      labelElement.classList.add('label');
      labelElement.innerText = label;

      const meterWrapper = document.createElement('div');
      meterWrapper.classList.add('meter-wrapper');
      if (id.includes('left')) labelElement.classList.add('label-left');
      if (id.includes('right')) labelElement.classList.add('label-right');
      meterWrapper.appendChild(meterBar);
      meterWrapper.appendChild(labelElement);

      if (scaleValues && scaleValues.length > 0) {
        const scale = document.createElement('div');
        scale.classList.add('signal-meter-scale');
        scaleValues.forEach((v) => {
          const tick = document.createElement('div');
          tick.innerText = v;
          scale.appendChild(tick);
        });
        top.appendChild(scale);
      }

      top.appendChild(meterWrapper);
      levelMeter.appendChild(top);
      container.appendChild(levelMeter);
    }

    function buildUiFull() {
      // Use legacy IDs by default for CSS compatibility
      const idPrefix = useLegacyIds ? '' : `${instanceKey}-`;
      state.ids.left = idPrefix + 'left-meter';
      state.ids.right = idPrefix + 'right-meter';
      state.ids.hf = idPrefix + 'hf-meter';

      root.innerHTML = '';

      // Stereo Group
      const stereoGroup = document.createElement('div');
      stereoGroup.classList.add('stereo-group');

      const stereoScale = ['+5 dB', '0', '-5', '-10', '-15', '-20', '-25', '-30', '-35 dB'];
      createLevelMeter(state.ids.left, 'LEFT', stereoGroup, stereoScale);
      createLevelMeter(state.ids.right, 'RIGHT', stereoGroup, []);
      root.appendChild(stereoGroup);

      // HF Meter
      const hfScale = buildHFScale(state.hfUnit);
      createLevelMeter(state.ids.hf, 'RF', root, hfScale);
      const hfLevelMeter = root.querySelector(`#${cssEscape(state.ids.hf)}`)?.closest('.signal-level-meter');
      if (hfLevelMeter) hfLevelMeter.style.transform = 'translateX(-5px)';

      // Signal Panel
      const signalPanel = document.createElement('div');
      signalPanel.className = 'panel-33 no-bg-phone signal-panel-layout';
      // Use legacy IDs if requested, otherwise data attributes
      if (useLegacyIds) {
        signalPanel.innerHTML = `
          <h2 class="signal-heading">SIGNAL</h2>
          <div class="text-small text-gray highest-signal-container">
            <i class="fa-solid fa-arrow-up"></i>
            <span id="data-signal-highest"></span>
            <span class="signal-units"></span>
          </div>
          <div class="text-big">
            <span id="data-signal"></span><!--
         --><span id="data-signal-decimal" class="text-medium-big" style="opacity:0.7;"></span>
            <span class="signal-units text-medium">dBf</span>
          </div>
        `;
      } else {
        signalPanel.innerHTML = `
          <h2 class="signal-heading">SIGNAL</h2>
          <div class="text-small text-gray highest-signal-container">
            <i class="fa-solid fa-arrow-up"></i>
            <span data-mm-signal="highest"></span>
            <span class="signal-units"></span>
          </div>
          <div class="text-big">
            <span data-mm-signal="main"></span><!--
         --><span data-mm-signal="decimal" class="text-medium-big" style="opacity:0.7;"></span>
            <span class="signal-units text-medium">dBf</span>
          </div>
        `;
      }
      root.appendChild(signalPanel);

      dom.meterExists = true;
      bindTextElements();
    }

    // Build or bind
    if (bindExisting) {
      bindTextElements();
      dom.meterExists = !!root.querySelector('.signal-meter-bar');
    } else if (!textOnly) {
      buildUiFull();
    } else {
      // textOnly without bindExisting: simply bind elements
      bindTextElements();
    }

    // Instance Methods
    const instance = {
      key: instanceKey,
      root,
      opts: { bindExisting, textOnly, useLegacyIds, enableAudio },
      state,

      destroy() {
        // Unsubscribe from Hub
        HUB.instances.delete(instanceKey);
        HUB.audio.subscribers.delete(instance);
      },

      _onUnit(unit) {
        state.hfUnit = String(unit || 'dbf').toLowerCase();
        state.highestSignal = -Infinity;

        // Reset highest display
        if (dom.elHighest) dom.elHighest.textContent = '---';

        // Update unit text in this root
        if (dom.unitEls && dom.unitEls.length) {
          dom.unitEls.forEach(span => { span.textContent = state.hfUnit; });
        }

        // Update HF scale if meter exists
        if (dom.meterExists) {
          const meterEl = root.querySelector(`#${cssEscape(state.ids.hf)}`) || root.querySelector('#hf-meter');
          const levelMeter = meterEl?.closest('.signal-level-meter');
          const scaleEl = levelMeter?.querySelector('.signal-meter-scale');
          if (scaleEl) {
            const newScale = buildHFScale(state.hfUnit);
            const ticks = scaleEl.querySelectorAll('div');
            newScale.forEach((txt, idx) => { if (ticks[idx]) ticks[idx].innerText = txt; });
          }
        }

        // Re-apply last value
        if (typeof state.levels.hfBase === 'number' && isFinite(state.levels.hfBase) && HUB.latestSigBase !== null) {
          instance._onSig(HUB.latestSigBase);
        }
      },

      _onSig(baseValue) {
        // Display correction
        const correction = 0;
        const correctedBase = Number(baseValue) + correction;
        if (!isFinite(correctedBase)) return;

        state.levels.hfBase = correctedBase;
        const displayHF = hfBaseToDisplay(state.hfUnit, correctedBase);
        state.levels.hfValue = displayHF;

        // Export shared levels
        HUB.sharedLevels.hfBase = correctedBase;
        HUB.sharedLevels.hfValue = displayHF;

        // Update Highest Signal
        if (displayHF > state.highestSignal) {
          state.highestSignal = displayHF;
          if (dom.elHighest) dom.elHighest.textContent = state.highestSignal.toFixed(1);
        }

        // Update Main Text
        if (dom.elMain) {
          const parts = displayHF.toFixed(1).split('.');
          dom.elMain.textContent = parts[0];
          if (dom.elDec && parts[1]) dom.elDec.textContent = '.' + parts[1];
        }

        // Update HF Bar
        const percent = hfPercentFromBase(correctedBase);
        state.levels.hf = percent;
        HUB.sharedLevels.hf = percent;
        if (dom.meterExists && !textOnly) {
          updateMeterById(root, state.ids.hf, percent, peaks, PEAK_CONFIG);
          // Manually update HF peak here since updateMeterById mainly updates bar and stereo peaks
          const meter = root.querySelector(`#${cssEscape(state.ids.hf)}`);
          if (meter) setPeakSegment(meter, percent, state.ids.hf);
        }
      },

      _onAudio(levelL, levelR) {
        if (!dom.meterExists || textOnly) return;
        state.levels.left = levelL;
        state.levels.right = levelR;

        updateMeterById(root, state.ids.left, levelL, peaks, PEAK_CONFIG);
        updateMeterById(root, state.ids.right, levelR, peaks, PEAK_CONFIG);
      }
    };

    // Register instance
    HUB.instances.set(instanceKey, instance);

    // Initialize unit for instance
    instance._onUnit(HUB.unit);

    // Subscribe to audio if required
    if (enableAudio && !textOnly) {
      HUB.audio.subscribers.add(instance);
      HUB.ensureAudio();
    }

    // Connect socket and apply last values
    if (opts.autoConnect !== false) {
      HUB.ensureConnected();
    }
    if (HUB.latestSigBase !== null) {
      instance._onSig(HUB.latestSigBase);
    }
    // Apply latest audio levels
    if (HUB.sharedLevels.left || HUB.sharedLevels.right) {
      instance._onAudio(HUB.sharedLevels.left, HUB.sharedLevels.right);
    }

    return instance;
  }

  // -------------------------------------------------------
  // Public API (Backwards Compatible)
  // -------------------------------------------------------
  let defaultInstance = null;

  window.MetricsSignalMeter = {
    // Legacy entry point for panel mode
    init(containerOrId = 'level-meter-container') {
      defaultInstance = createInstance(containerOrId, {
        instanceKey: 'panel',
        bindExisting: false,
        textOnly: false,
        useLegacyIds: true,
        enableAudio: true,
        autoConnect: true
      });
      return defaultInstance;
    },

    // New multi-instance support
    createInstance,

    destroyInstance(instanceKey) {
      const key = String(instanceKey || '');
      const inst = HUB.instances.get(key);
      if (inst) inst.destroy();
    },

    // Headless start for data listener
    startDataListener() {
      HUB.ensureConnected();
    },

    // Backwards compatibility: Broadcast signal value
    setHF(baseValue) {
      HUB.broadcastSig(baseValue);
    },

    // Backwards compatibility: Set unit locally
    setHFUnit(unit) {
      HUB.setUnit(unit);
    },

    // Expose shared levels
    levels: HUB.sharedLevels,

    // Backwards compatibility helper
    updateMeter(meterId, level) {
      if (defaultInstance) {
        try {
          updateMeterById(defaultInstance.root, meterId, level,
            { left: { value: 0, lastUpdate: Date.now() }, right: { value: 0, lastUpdate: Date.now() } },
            { smoothing: 0.85, holdMs: 5000 }
          );
        } catch {}
      }
    }
  };

})();