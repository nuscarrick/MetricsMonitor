///////////////////////////////////////////////////////////////
//                                                           //
//  metricsmonitor-signalmeter.js                  (V2.5a)   //
//                                                           //
//  by Highpoint               last update: 09.03.2026       //
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
const MPXInputCard = "FM Server Mikrofon (2- HD USB Audio Device)";    // Do not touch - this value is automatically updated via the config file
const MPXTiltCalibration = 0;    // Do not touch - this value is automatically updated via the config file
const VisualDelayMs = 250;    // Do not touch - this value is automatically updated via the config file
const MeterInputCalibration = 10;    // Do not touch - this value is automatically updated via the config file
const MeterPilotCalibration = 0;    // Do not touch - this value is automatically updated via the config file
const MeterMPXCalibration = 0;    // Do not touch - this value is automatically updated via the config file
const MeterRDSCalibration = 0;    // Do not touch - this value is automatically updated via the config file
const MeterPilotScale = 96.20813245621108;    // Do not touch - this value is automatically updated via the config file
const MeterRDSScale = 101.78039701186412;    // Do not touch - this value is automatically updated via the config file
const fftSize = 4096;    // Do not touch - this value is automatically updated via the config file
const SpectrumAttackLevel = 3;    // Do not touch - this value is automatically updated via the config file
const SpectrumDecayLevel = 15;    // Do not touch - this value is automatically updated via the config file
const SpectrumSendInterval = 30;    // Do not touch - this value is automatically updated via the config file
const SpectrumYOffset = -40;    // Do not touch - this value is automatically updated via the config file
const SpectrumYDynamics = 2;    // Do not touch - this value is automatically updated via the config file
const ScopeInputCalibration = 7;    // Do not touch - this value is automatically updated via the config file
const StereoBoost = 3;    // Do not touch - this value is automatically updated via the config file
const AudioMeterBoost = 1.7;    // Do not touch - this value is automatically updated via the config file
const MODULE_SEQUENCE = [0,3,1,2,5,4];    // Do not touch - this value is automatically updated via the config file
const CANVAS_SEQUENCE = [2,5,4];    // Do not touch - this value is automatically updated via the config file
const MultipathMode = 0;    // Do not touch - this value is automatically updated via the config file
const LockVolumeSlider = true;    // Do not touch - this value is automatically updated via the config file
const EnableSpectrumOnLoad = false;    // Do not touch - this value is automatically updated via the config file
const EnableAnalyzerAdminMode = false;    // Do not touch - this value is automatically updated via the config file
const MeterColorSafe = "rgb(0, 255, 0)";    // Do not touch - this value is automatically updated via the config file
const MeterColorWarning = "rgb(255, 255,0)";    // Do not touch - this value is automatically updated via the config file
const MeterColorDanger = "rgb(255, 0, 0)";    // Do not touch - this value is automatically updated via the config file
const PeakMode = "fixed";    // Do not touch - this value is automatically updated via the config file
const PeakColorFixed = "rgb(251, 174, 38)";    // Do not touch - this value is automatically updated via the config file
const MeterTiltCalibration = -900;    // Do not touch - this value is automatically updated via the config file

const CONFIG = (window.MetricsMonitor && window.MetricsMonitor.Config) ? window.MetricsMonitor.Config : {};

  // -------------------------------------------------------
  // CSS FIXES FOR ZOOMING (Signal Meter specific)
  // -------------------------------------------------------
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

  // --- MP COLOR LOGIC ---
  function mpColorForIndex(i, totalSegments) {
      const cSafe = parseRgb(MeterColorSafe);
      const cWarning = parseRgb(MeterColorWarning);
      const cDanger = parseRgb(MeterColorDanger);

      // MP thresholds: < 10% Green, 10%-30% Yellow, > 30% Red
      const idxYellowStart = Math.round((10 / 100) * totalSegments);
      const idxRedStart = Math.round((30 / 100) * totalSegments);

      if (i < idxYellowStart) {
          const pos = i / Math.max(1, idxYellowStart - 1);
          const intensity = 0.45 + (0.3 * pos);
          return applyIntensity(cSafe, intensity);
      } else if (i < idxRedStart) {
          const pos = (i - idxYellowStart) / Math.max(1, idxRedStart - idxYellowStart);
          const intensity = 0.6 + (0.4 * pos);
          return applyIntensity(cWarning, intensity);
      } else {
          const pos = (i - idxRedStart) / Math.max(1, totalSegments - idxRedStart);
          const intensity = 0.6 + (0.4 * pos);
          return applyIntensity(cDanger, intensity);
      }
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

  function formatUnit(unit) {
    const ssu = (unit || '').toLowerCase();
    if (ssu === 'dbm') return 'dBm';
    if (ssu === 'dbf') return 'dBf';
    return 'dBµV';
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
    const round10 = (v) => Math.round(v / 10) * 10;

    if (ssu === 'dbm') {
      return baseScale_dBuV.map(v => `${round10(v - 108.875)}`);
    }
    if (ssu === 'dbf') {
      return baseScale_dBuV.map(v => `${round10(v + 10.875)}`);
    }
    // default: dBµV
    return baseScale_dBuV.map(v => `${round10(v)}`);
  }

  // -------------------------------------------------------
  // Multipath calculation (Dynamic Mode Check)
  // The code or algorithm for multipath calculation was adopted from the UIAddonPack plugin by AmateurAudioDude.
  // -------------------------------------------------------
  const MULTIPATH_SIGNAL_THRESHOLD_DBF = 25;
  const MULTIPATH_TIMEOUT_DURATION = 800;

  function smoothInterpolationMultipath(raw) {
    // Read dynamic mode from global config or fallback to local constant
    let isTefMode = true;
    if (window.MetricsMonitor && window.MetricsMonitor.Config && window.MetricsMonitor.Config.MultipathMode !== undefined) {
        isTefMode = (window.MetricsMonitor.Config.MultipathMode === 1);
    } else {
        isTefMode = (MultipathMode === 1);
    }

    const v = Number(raw);
    if (!isFinite(v)) return 0;

    if (!isTefMode) {
        return Math.min(99, Math.max(0, parseInt(raw, 10)));
    }

    // TEF Radio interpolation logic
    if (v <= 3) return 0;
    if (v >= 40) return 99; // Cap at 99 visually

    const normValue = (v - 3) / (40 - 3);
    const smoothValue = Math.pow(normValue, 1);
    const scaledValue = smoothValue * 99;
    return parseInt(scaledValue, 10);
  }

  // -------------------------------------------------------
  // Meter Drawing Helpers
  // -------------------------------------------------------
  function stereoColorForPercent(p, totalSegments = 30) {
    const i = Math.max(0, Math.min(totalSegments - 1, Math.round((p / 100) * totalSegments) - 1));
    const topBandStart = totalSegments - 5;
    
    const cDanger = parseRgb(MeterColorDanger);
    const cSafe = parseRgb(MeterColorSafe);

    if (i >= topBandStart) {
      const intensity = 0.8 + (0.2 * (i / totalSegments)); 
      return applyIntensity(cDanger, intensity);
    }
    const intensity = 0.4 + ((i / totalSegments) * 0.6); 
    return applyIntensity(cSafe, intensity);
  }

  function updatePeakValue(peaks, channel, current, holdMs, smoothing, decayRate = 2.5) {
    const p = peaks[channel];
    if (!p) return;

    // If current is invalid (<0), clear the peak instantly
    if (current < 0) {
        p.value = -1;
        return;
    }

    const now = Date.now();
    if (p.lastUpdate === undefined) p.lastUpdate = now;

    let actualHoldMs = holdMs;
    let actualDecayRate = decayRate;

    if (channel === 'mp') {
        actualHoldMs = 200;  // Extremely short hold for Multipath
        actualDecayRate = 8.0; // Very fast falloff    
    } else if (channel === 'hf') {
        actualHoldMs = 1500;
        actualDecayRate = 1.0;
    } else {
        actualHoldMs = holdMs; 
        actualDecayRate = 2.0; 
    }

    if (current >= p.value) {
      p.value = current;
      p.lastUpdate = now;
    } else if (now - p.lastUpdate > actualHoldMs) {
      p.value = Math.max(current, p.value - actualDecayRate);
      if (p.value <= current + 0.5) p.value = current;
    }
  }

  function setPeakSegment(meterEl, peak, meterId) {
    const segments = meterEl.querySelectorAll(".segment");
    if (!segments.length) return;

    // Remove ALL previous peak flags
    const prevAll = meterEl.querySelectorAll(".segment.peak-flag");
    prevAll.forEach((prev) => {
      prev.classList.remove("peak-flag");
      prev.style.removeProperty("background-color");
      prev.style.removeProperty("box-shadow");
      prev.style.removeProperty("opacity");
    });

    // Don't draw a peak if the value is invalid
    if (peak < 0) return;

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
      } else if (meterId.includes("mp")) {
        peakColor = mpColorForIndex(idx, segments.length);
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

    // Process invalid states (-1)
    const isInvalid = (level < 0);
    const safeLevel = isInvalid ? 0 : Math.max(0, Math.min(100, Number(level) || 0));
    const segments = meter.querySelectorAll('.segment');
    const activeCount = isInvalid ? 0 : Math.round((safeLevel / 100) * segments.length);

    const cDanger = parseRgb(MeterColorDanger);
    const cSafe = parseRgb(MeterColorSafe);
    
    segments.forEach((seg) => {
      if (seg.classList.contains("peak-flag")) seg.classList.remove("peak-flag");
      seg.style.removeProperty("background-color");
    });

    segments.forEach((seg, i) => {
      if (seg.classList.contains("peak-flag")) return; 

      if (i < activeCount) {
        if (meterId.includes('left') || meterId.includes('right')) {
          if (i >= segments.length - 5) {
            const intensity = 0.8 + (0.2 * (i / segments.length)); 
            seg.style.backgroundColor = applyIntensity(cDanger, intensity);
          } else {
            const intensity = 0.4 + ((i / segments.length) * 0.6);
            seg.style.backgroundColor = applyIntensity(cSafe, intensity);
          }
        } else if (meterId.includes('hf')) {
          const hfThresholdIndex = Math.round((20 / 90) * segments.length);
          if (i < hfThresholdIndex) {
            const pos = i / hfThresholdIndex;
            const intensity = 0.6 + (0.4 * pos);
            seg.style.backgroundColor = applyIntensity(cDanger, intensity);
          } else {
            const pos = i / segments.length;
            const intensity = 0.4 + (0.6 * pos);
            seg.style.backgroundColor = applyIntensity(cSafe, intensity);
          }
        } else if (meterId.includes('mp')) {
          seg.style.backgroundColor = mpColorForIndex(i, segments.length);
        } else {
          seg.style.backgroundColor = '#333';
        }
      } else {
        seg.style.backgroundColor = '#333';
      }
    });

    const key = meterId.includes('left') ? 'left' : 
                (meterId.includes('right') ? 'right' : 
                (meterId.includes('mp') ? 'mp' : 
                (meterId.includes('hf') ? 'hf' : null)));
    
    if (key) {
      let hold = peakCfg.holdMs; 
      let decay = 2.5;           
      
      if (key === 'mp') {
          hold = 200;  
          decay = 8.0; 
      }
      
      updatePeakValue(peaks, key, level, hold, peakCfg.smoothing, decay);
      setPeakSegment(meter, peaks[key].value, meterId);
    } 
  }

  // -------------------------------------------------------
  // Shared Hub 
  // -------------------------------------------------------
  const METER_MAX_DB = 5;
  const METER_MIN_DB = -26;
  const METER_RANGE = METER_MAX_DB - METER_MIN_DB;

  function amplitudeToMeterPercent(amplitude) {
    if (amplitude < 0.00001) return 0;
    const linear = amplitude * StereoBoost;
    const db = 20 * Math.log10(linear);

    if (db <= METER_MIN_DB) return 0;
    if (db >= METER_MAX_DB) return 100;
    return ((db - METER_MIN_DB) / METER_RANGE) * 100;
  }

  function createHub() {
    const hub = {
      socket: null,
      connected: false,
      connecting: null,
      msgListenerAttached: false,

      instances: new Map(), 
      latestSigBase: null,
      latestMultipath: null,
      
      lastMultipathProcessTime: 0,
      prevFreq: 0,

      unit: (window.MetricsMonitor && typeof window.MetricsMonitor.getSignalUnit === 'function')
        ? (window.MetricsMonitor.getSignalUnit() || 'dbf').toLowerCase()
        : (localStorage.getItem('mm_signal_unit') || 'dbf').toLowerCase(),

      sharedLevels: {
        hf: 0,
        hfValue: 0,
        hfBase: 0,
        left: 0,
        right: 0,
        mp: -1 // Initialize to invalid so it starts empty
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

                // 1. HF / Signal Update 
                if (msg && msg.sig !== undefined) {
                  this.broadcastSig(msg.sig);
                }

                // 2. Multipath Update 
                if (msg && msg.sigRaw !== undefined) {
                  const now = Date.now();

                  let currentFreq = 0;
                  if (msg.freq !== undefined) {
                      currentFreq = Number(msg.freq);
                  } else {
                      const freqEl = document.getElementById("data-frequency");
                      if (freqEl) currentFreq = Number(freqEl.textContent);
                  }

                  if (currentFreq !== 0 && this.prevFreq !== currentFreq) {
                      this.prevFreq = currentFreq;
                      this.broadcastMultipath(NaN);
                      return;
                  }
                  this.prevFreq = currentFreq;

                  if (now - this.lastMultipathProcessTime < MULTIPATH_TIMEOUT_DURATION) return;
                  this.lastMultipathProcessTime = now;

                  const sigRawValues = msg.sigRaw.split(',');
                  if (sigRawValues.length >= 2) {
                      const parsedSig = parseInt(sigRawValues[0].slice(2), 10);
                      const rawMultipath = sigRawValues[1];

                      let mpPercent = smoothInterpolationMultipath(rawMultipath);
                      if (mpPercent > 99) mpPercent = 99; // Caps strictly at 99.

                      if (parsedSig > MULTIPATH_SIGNAL_THRESHOLD_DBF) {
                          this.broadcastMultipath(mpPercent);
                      } else {
                          this.broadcastMultipath(NaN);
                      }
                  }
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

      broadcastMultipath(val) {
        if (val === null) {
          this.latestMultipath = null;
        } else {
          this.latestMultipath = val;
        }
        for (const inst of this.instances.values()) {
          try { inst._onMultipath(val); } catch {}
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
        
        const trySetup = () => {
            if (
                typeof Stream === "undefined" ||
                !Stream ||
                !Stream.Fallback ||
                !Stream.Fallback.Player ||
                !Stream.Fallback.Player.Amplification
            ) {
                return;
            }

            const player = Stream.Fallback.Player;
            const sourceNode = player.Amplification;

            if (!sourceNode || !sourceNode.context) return;

            try {
                const ctx = sourceNode.context;

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
                     
                     A.analyserL.fftSize = 4096;
                     A.analyserR.fftSize = 4096;
                     
                     A.dataL = new Float32Array(A.analyserL.fftSize);
                     A.dataR = new Float32Array(A.analyserR.fftSize);
                }

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
                    A.analyserL.getFloatTimeDomainData(A.dataL);
                    A.analyserR.getFloatTimeDomainData(A.dataR);
                    
                    let maxL = 0;
                    let maxR = 0;
                    
                    for (let i = 0; i < A.dataL.length; i++) {
                        const absL = Math.abs(A.dataL[i]);
                        if (absL > maxL) maxL = absL;
                    }
                    for (let i = 0; i < A.dataR.length; i++) {
                        const absR = Math.abs(A.dataR[i]);
                        if (absR > maxR) maxR = absR;
                    }

                    const rawTargetPercentL = amplitudeToMeterPercent(maxL);
                    const rawTargetPercentR = amplitudeToMeterPercent(maxR);
                    
                    const attack = 0.8; 
                    const decay = 0.6;  
                    
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

    return hub;
  }

  const HUB = window[HUB_KEY] || (window[HUB_KEY] = createHub());

  if (!HUB._unitListenerAttached && window.MetricsMonitor && typeof window.MetricsMonitor.onSignalUnitChange === 'function') {
    HUB._unitListenerAttached = true;
    window.MetricsMonitor.onSignalUnitChange((u) => HUB.setUnit(u));
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

    if (HUB.instances.has(instanceKey)) {
      try { HUB.instances.get(instanceKey).destroy(); } catch {}
      HUB.instances.delete(instanceKey);
    }

    const PEAK_CONFIG = { smoothing: 0.85, holdMs: 5000 };
    const peaks = {
      left: { value: 0, lastUpdate: Date.now() },
      right: { value: 0, lastUpdate: Date.now() },
      hf: { value: 0, lastUpdate: Date.now() },
      mp: { value: 0, lastUpdate: Date.now() }
    };

    const state = {
      hfUnit: (HUB.unit || 'dbf').toLowerCase(),
      highestSignal: -Infinity,
      levels: {
        hf: 0,
        hfValue: 0,
        hfBase: 0,
        left: 0,
        right: 0,
        mp: -1, // -1 means hidden / empty
        multipath: null
      },
      ids: {
        left: 'left-meter',
        right: 'right-meter',
        hf: 'hf-meter',
        mp: 'mp-meter'
      }
    };

    const dom = {
      root,
      elHighest: null,
      elMain: null,
      elDec: null,
      unitEls: [],
      elMultipathContainer: null,
      elMultipathValue: null,
      meterExists: false,
    };

    function bindTextElements() {
      dom.elHighest = root.querySelector('[data-mm-signal="highest"]') || root.querySelector('#data-signal-highest');
      dom.elMain = root.querySelector('[data-mm-signal="main"]') || root.querySelector('#data-signal');
      dom.elDec = root.querySelector('[data-mm-signal="decimal"]') || root.querySelector('#data-signal-decimal');
      dom.unitEls = Array.from(root.querySelectorAll('.signal-units'));
      
      dom.elMultipathContainer = root.querySelector('[data-mm-signal="multipath-container"]') || root.querySelector('#data-multipath-container');
      dom.elMultipathValue = root.querySelector('[data-mm-signal="multipath-value"]') || root.querySelector('#data-multipath-value');
    }

    function createLevelMeter(id, label, unitText, container, scaleValues) {
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
        segment.style.backgroundColor = '#333'; 
        meterBar.appendChild(segment);
      }
      
      if (id.includes('left') || id.includes('right') || id.includes('mp') || id.includes('hf')) {
        const marker = document.createElement('div');
        marker.className = 'peak-marker';
        meterBar.appendChild(marker);
      }

      const labelElement = document.createElement('div');
      labelElement.classList.add('label');
      labelElement.innerText = label;

      const unitElement = document.createElement('div');
      unitElement.classList.add('unit-label');
      if (id.includes('hf')) {
        unitElement.classList.add('hf-unit-label'); 
      }
      unitElement.innerText = unitText;

      const meterWrapper = document.createElement('div');
      meterWrapper.classList.add('meter-wrapper');
      if (id.includes('left')) labelElement.classList.add('label-left');
      if (id.includes('right')) labelElement.classList.add('label-right');
      
      meterWrapper.appendChild(unitElement); 
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
      const idPrefix = useLegacyIds ? '' : `${instanceKey}-`;
      state.ids.left = idPrefix + 'left-meter';
      state.ids.right = idPrefix + 'right-meter';
      state.ids.hf = idPrefix + 'hf-meter';
      state.ids.mp = idPrefix + 'mp-meter';

      root.innerHTML = '';

      // Stereo Group
      const stereoGroup = document.createElement('div');
      stereoGroup.classList.add('stereo-group');

      const stereoScale = ['+5', '0', '-5', '-10', '-15', '-20', '-26'];
      createLevelMeter(state.ids.left, 'LEFT', 'dB', stereoGroup, stereoScale);
      createLevelMeter(state.ids.right, 'RIGHT', 'dB', stereoGroup, []);
      root.appendChild(stereoGroup);

      // HF Meter
      const hfScale = buildHFScale(state.hfUnit);
      createLevelMeter(state.ids.hf, 'RF', formatUnit(state.hfUnit), root, hfScale);
      
      const hfLevelMeter = root.querySelector(`#${cssEscape(state.ids.hf)}`)?.closest('.signal-level-meter');
      if (hfLevelMeter) {
        hfLevelMeter.style.transform = 'translateX(-10px)';
        hfLevelMeter.style.marginLeft = '15px'; 
      }

      // MP Meter 
      const mpScale = ['99', '90', '80', '70', '60', '50', '40', '30', '20', '10', '0'];
      createLevelMeter(state.ids.mp, 'MP', '%', root, mpScale);
	  
	  const mpLevelMeter = root.querySelector(`#${cssEscape(state.ids.mp)}`)?.closest('.signal-level-meter');
      if (mpLevelMeter) {
        mpLevelMeter.style.transform = 'translateX(-5px)';
      }

      // Signal Panel
      const signalPanel = document.createElement('div');
      signalPanel.className = 'panel-33 no-bg-phone signal-panel-layout';
      
      if (useLegacyIds) {
        signalPanel.innerHTML = `
          <div id="data-signal-values-wrapper" style="transition: transform 0.3s ease; width: 100%;">
            <h2 class="signal-heading" style="display: block !important;">SIGNAL</h2>
            <div class="text-small text-gray highest-signal-container">
              <i class="fa-solid fa-arrow-up"></i>
              <span id="data-signal-highest"></span>
              <span class="signal-units"></span>
            </div>
            <div class="text-big">
              <span id="data-signal"></span><!--
           --><span id="data-signal-decimal" class="text-medium-big" style="opacity:0.7;"></span>
              <span class="signal-units text-medium" style="position: relative; top: -7px;">dBf</span>
            </div>
          </div>

          <div id="data-multipath-container"
               style="display: none; position: relative; top: -2px; text-align: center; z-index: 10; transition: transform 0.3s ease; width: 100%;">
            <h2 class="signal-heading"
                style="display: inline-block; font-size: 15px; text-transform: none; letter-spacing: normal; margin: 0; padding: 0; border: none; vertical-align: baseline; transition: color 0.3s;">
              Multipath:
            </h2>
            <span id="data-multipath-value"
                  style="color: #ffffff; font-weight: normal; vertical-align: baseline; margin-left: 3px; font-size: 15px; transition: color 0.3s;">
            </span>
          </div>
        `;
      } else {
        signalPanel.innerHTML = `
          <div data-mm-signal="values-wrapper" style="transition: transform 0.3s ease; width: 100%;">
            <h2 class="signal-heading" style="display: block !important;">SIGNAL</h2>
            <div class="text-small text-gray highest-signal-container">
              <i class="fa-solid fa-arrow-up"></i>
              <span data-mm-signal="highest"></span>
              <span class="signal-units"></span>
            </div>
            <div class="text-big">
              <span data-mm-signal="main"></span><!--
           --><span data-mm-signal="decimal" class="text-medium-big" style="opacity:0.7;"></span>
              <span class="signal-units text-medium" style="position: relative; top: -7px;">dBf</span>
            </div>
          </div>

          <div data-mm-signal="multipath-container"
               style="display: none; position: relative; top: -2px; text-align: center; z-index: 10; transition: transform 0.3s ease; width: 100%;">
            <h2 class="signal-heading"
                style="display: inline-block; font-size: 15px; text-transform: none; letter-spacing: normal; margin: 0; padding: 0; border: none; vertical-align: baseline; transition: color 0.3s;">
              Multipath:
            </h2>
            <span data-mm-signal="multipath-value"
                  style="color: #ffffff; font-weight: normal; vertical-align: baseline; margin-left: 3px; font-size: 15px; transition: color 0.3s;">
            </span>
          </div>
        `;
      }
      root.appendChild(signalPanel);

      dom.meterExists = true;
      bindTextElements();
    }

    if (bindExisting) {
      bindTextElements();
      dom.meterExists = !!root.querySelector('.signal-meter-bar');
    } else if (!textOnly) {
      buildUiFull();
    } else {
      bindTextElements();
    }

    const instance = {
      key: instanceKey,
      root,
      opts: { bindExisting, textOnly, useLegacyIds, enableAudio },
      state,
      _destroyed: false,

      destroy() {
        this._destroyed = true;
        HUB.instances.delete(instanceKey);
        HUB.audio.subscribers.delete(instance);
      },

      _renderLoop() {
        if (this._destroyed) return;
        if (!dom.meterExists || textOnly) {
            requestAnimationFrame(() => this._renderLoop());
            return;
        }

        // Independently update all visual meters at 60fps to guarantee smooth peak falls
        // regardless of whether Audio is currently playing.
        updateMeterById(this.root, this.state.ids.left, this.state.levels.left, peaks, PEAK_CONFIG);
        updateMeterById(this.root, this.state.ids.right, this.state.levels.right, peaks, PEAK_CONFIG);
        
        if (this.state.levels.hf !== undefined) {
           updateMeterById(this.root, this.state.ids.hf, this.state.levels.hf, peaks, PEAK_CONFIG);
        }
        if (this.state.levels.mp !== undefined) {
           updateMeterById(this.root, this.state.ids.mp, this.state.levels.mp, peaks, PEAK_CONFIG);
        }

        requestAnimationFrame(() => this._renderLoop());
      },

      _onUnit(unit) {
        state.hfUnit = String(unit || 'dbf').toLowerCase();
        state.highestSignal = -Infinity;

        if (dom.elHighest) dom.elHighest.textContent = '---';

        if (dom.unitEls && dom.unitEls.length) {
          dom.unitEls.forEach(span => { span.textContent = state.hfUnit; });
        }

        if (dom.meterExists) {
          const meterEl = root.querySelector(`#${cssEscape(state.ids.hf)}`) || root.querySelector('#hf-meter');
          const levelMeter = meterEl?.closest('.signal-level-meter');
          const scaleEl = levelMeter?.querySelector('.signal-meter-scale');
          if (scaleEl) {
            const newScale = buildHFScale(state.hfUnit);
            const ticks = scaleEl.querySelectorAll('div');
            newScale.forEach((txt, idx) => { if (ticks[idx]) ticks[idx].innerText = txt; });
          }
          
          const hfUnitLabel = root.querySelector('.hf-unit-label');
          if (hfUnitLabel) {
            hfUnitLabel.textContent = formatUnit(state.hfUnit);
          }
        }

        if (typeof state.levels.hfBase === 'number' && isFinite(state.levels.hfBase) && HUB.latestSigBase !== null) {
          instance._onSig(HUB.latestSigBase);
        }
      },

      _onSig(baseValue) {
        const correction = 0;
        const correctedBase = Number(baseValue) + correction;
        if (!isFinite(correctedBase)) return;

        state.levels.hfBase = correctedBase;
        const displayHF = hfBaseToDisplay(state.hfUnit, correctedBase);
        state.levels.hfValue = displayHF;

        HUB.sharedLevels.hfBase = correctedBase;
        HUB.sharedLevels.hfValue = displayHF;

        if (displayHF > state.highestSignal) {
          state.highestSignal = displayHF;
          if (dom.elHighest) dom.elHighest.textContent = state.highestSignal.toFixed(1);
        }

        if (dom.elMain) {
          const parts = displayHF.toFixed(1).split('.');
          dom.elMain.textContent = parts[0];
          if (dom.elDec && parts[1]) dom.elDec.textContent = '.' + parts[1];
        }

        const percent = hfPercentFromBase(correctedBase);
        state.levels.hf = percent;
        HUB.sharedLevels.hf = percent;
      },

      _onMultipath(val) {
        state.levels.multipath = val;
        
        const wrapper = dom.root.querySelector('#data-signal-values-wrapper') || dom.root.querySelector('[data-mm-signal="values-wrapper"]');
        
        if (dom.elMultipathContainer && dom.elMultipathValue) {
          if (val === null) {
            dom.elMultipathContainer.style.display = 'none';
            if (wrapper) wrapper.style.transform = 'translateY(0px)';
            dom.elMultipathContainer.style.transform = 'translateY(0px)';
          } else {
            dom.elMultipathContainer.style.display = 'block';
            if (wrapper) wrapper.style.transform = 'translateY(-5px)';
            dom.elMultipathContainer.style.transform = 'translateY(-5px)';

            if (Number.isNaN(val)) {
                dom.elMultipathValue.textContent = '--%';
            } else {
                dom.elMultipathValue.textContent = val.toFixed(0) + '%';
            }
          }
        }

        if (dom.meterExists && !textOnly) {
           let safeVal = -1; // -1 means invalid/blank
           if (val !== null && !Number.isNaN(val)) safeVal = val;
           state.levels.mp = safeVal;
           HUB.sharedLevels.mp = safeVal;
        }
      },

      _onAudio(levelL, levelR) {
        state.levels.left = levelL;
        state.levels.right = levelR;
      }
    };

    HUB.instances.set(instanceKey, instance);
    instance._onUnit(HUB.unit);

    if (enableAudio && !textOnly) {
      HUB.audio.subscribers.add(instance);
      HUB.ensureAudio();
    }

    if (opts.autoConnect !== false) {
      HUB.ensureConnected();
    }
    if (HUB.latestSigBase !== null) {
      instance._onSig(HUB.latestSigBase);
    }
    if (HUB.latestMultipath !== null) {
      instance._onMultipath(HUB.latestMultipath);
    }
    if (HUB.sharedLevels.left || HUB.sharedLevels.right) {
      instance._onAudio(HUB.sharedLevels.left, HUB.sharedLevels.right);
    }

    // Start UI loop so peaks drop regardless of audio status
    requestAnimationFrame(() => instance._renderLoop());

    return instance;
  }

  // -------------------------------------------------------
  // Public API
  // -------------------------------------------------------
  let defaultInstance = null;

  window.MetricsSignalMeter = {
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

    createInstance,

    destroyInstance(instanceKey) {
      const key = String(instanceKey || '');
      const inst = HUB.instances.get(key);
      if (inst) inst.destroy();
    },

    startDataListener() {
      HUB.ensureConnected();
    },

    setHF(baseValue) {
      HUB.broadcastSig(baseValue);
    },

    setHFUnit(unit) {
      HUB.setUnit(unit);
    },

    levels: HUB.sharedLevels,

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