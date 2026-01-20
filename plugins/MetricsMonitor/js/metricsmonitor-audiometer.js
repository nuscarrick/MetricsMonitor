///////////////////////////////////////////////////////////////
//                                                           //
//  metricsmonitor-audiometer.js                    (V2.2)   //
//                                                           //
//  by Highpoint               last update: 20.01.2026       //
//                                                           //
//  Thanks for support by                                    //
//  Jeroen Platenkamp, Bkram, Wötkylä, AmateurAudioDude      //
//                                                           //
//  https://github.com/Highpoint2000/metricsmonitor          //
//                                                           //
///////////////////////////////////////////////////////////////

(() => {
const sampleRate = 192000;    // Do not touch - this value is automatically updated via the config file
const MPXmode = "auto";    // Do not touch - this value is automatically updated via the config file
const MPXStereoDecoder = "off";    // Do not touch - this value is automatically updated via the config file
const MPXInputCard = "";    // Do not touch - this value is automatically updated via the config file
const MPXTiltCalibration = 0;    // Do not touch - this value is automatically updated via the config file
const MeterInputCalibration = 0;    // Do not touch - this value is automatically updated via the config file
const MeterPilotCalibration = -9.6;    // Do not touch - this value is automatically updated via the config file
const MeterMPXCalibration = -22.7;    // Do not touch - this value is automatically updated via the config file
const MeterRDSCalibration = -3;    // Do not touch - this value is automatically updated via the config file
const MeterPilotScale = 400;    // Do not touch - this value is automatically updated via the config file
const MeterRDSScale = 750;    // Do not touch - this value is automatically updated via the config file
const fftSize = 4096;    // Do not touch - this value is automatically updated via the config file
const SpectrumAttackLevel = 3;    // Do not touch - this value is automatically updated via the config file
const SpectrumDecayLevel = 15;    // Do not touch - this value is automatically updated via the config file
const SpectrumSendInterval = 30;    // Do not touch - this value is automatically updated via the config file
const SpectrumYOffset = -40;    // Do not touch - this value is automatically updated via the config file
const SpectrumYDynamics = 2;    // Do not touch - this value is automatically updated via the config file
const StereoBoost = 0.9;    // Do not touch - this value is automatically updated via the config file
const AudioMeterBoost = 1;    // Do not touch - this value is automatically updated via the config file
const MODULE_SEQUENCE = [1,2,0,3,4];    // Do not touch - this value is automatically updated via the config file
const CANVAS_SEQUENCE = [2,4];    // Do not touch - this value is automatically updated via the config file
const LockVolumeSlider = true;    // Do not touch - this value is automatically updated via the config file
const EnableSpectrumOnLoad = true;    // Do not touch - this value is automatically updated via the config file
const EnableAnalyzerAdminMode = false;    // Do not touch - this value is automatically updated via the config file
const MeterColorSafe = "rgb(0, 255, 0)";    // Do not touch - this value is automatically updated via the config file
const MeterColorWarning = "rgb(255, 255,0)";    // Do not touch - this value is automatically updated via the config file
const MeterColorDanger = "rgb(255, 0, 0)";    // Do not touch - this value is automatically updated via the config file
const PeakMode = "dynamic";    // Do not touch - this value is automatically updated via the config file
const PeakColorFixed = "rgb(251, 174, 38)";    // Do not touch - this value is automatically updated via the config file
const MeterTiltCalibration = -900;    // Do not touch - this value is automatically updated via the config file

    // ==========================================================
    // CSS FIXES FOR ZOOMING
    // ==========================================================
    const style = document.createElement('style');
    style.innerHTML = `
      /* Fix for sub-pixel rendering gaps on zoom */
      .meter-bar .segment {
        border-bottom: 1px solid rgba(0,0,0,0.8) !important; 
        margin-bottom: 0 !important; 
        box-sizing: border-box;      
      }
      /* Ensure Peak Flags overlay correctly */
      .segment.peak-flag {
        z-index: 10;
        box-shadow: 0 0 4px rgba(255, 255, 255, 0.4);
      }
    `;
    document.head.appendChild(style);

// Internal Unit State
let hfUnit = "dbf";
let hfUnitListenerAttached = false;

// Levels (Publicly accessible)
const levels = {
  hf: 0,
  hfValue: 0,
  hfBase: 0,
  left: 0,
  right: 0
};

const EQ_BAND_COUNT = 5;

// EQ Display State
const eqLevels = new Array(EQ_BAND_COUNT).fill(0);

// Peak Hold Configuration
const PEAK_CONFIG = {
  smoothing: 0.85,
  holdMs: 5000
};

const peaks = {
  left:  { value: 0, lastUpdate: Date.now() },
  right: { value: 0, lastUpdate: Date.now() },
  eq1:   { value: 0, lastUpdate: Date.now() },
  eq2:   { value: 0, lastUpdate: Date.now() },
  eq3:   { value: 0, lastUpdate: Date.now() },
  eq4:   { value: 0, lastUpdate: Date.now() },
  eq5:   { value: 0, lastUpdate: Date.now() }
};

// Audio Context Variables
let eqAudioContext = null;
let eqAnalyser = null;
let eqDataArray = null;
let eqAnimationId = null;
let eqSourceNode = null;

// Stereo Analyser Variables
let stereoSplitter = null;
let stereoAnalyserL = null;
let stereoAnalyserR = null;
let stereoDataL = null;
let stereoDataR = null;

// Setup Interval
let eqSetupIntervalId = null;

// -------------------------------------------------------
// Helper: Parse RGB String to Object & Apply Intensity
// -------------------------------------------------------
function parseRgb(rgbStr) {
  const match = rgbStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (match) {
    return { r: parseInt(match[1]), g: parseInt(match[2]), b: parseInt(match[3]) };
  }
  return { r: 0, g: 255, b: 0 }; // Default fallback
}

function getScaledColor(colorObj, intensity) {
  // Clamp intensity to 255
  const r = Math.min(255, Math.round(colorObj.r * intensity));
  const g = Math.min(255, Math.round(colorObj.g * intensity));
  const b = Math.min(255, Math.round(colorObj.b * intensity));
  return `rgb(${r},${g},${b})`;
}

// -------------------------------------------------------
// HF Unit Conversion Helpers
// -------------------------------------------------------

// Convert Base HF (dBf) to Display Value
function hfBaseToDisplay(baseHF) {
  const ssu = (hfUnit || "").toLowerCase();
  const v = Number(baseHF);
  if (!isFinite(v)) return 0;

  if (ssu === "dbuv" || ssu === "dbµv" || ssu === "dbμv") {
    return v - 10.875;
  } else if (ssu === "dbm") {
    return v - 119.75;
  } else if (ssu === "dbf") {
    return v;
  }
  return v;
}

// Convert Base HF (dBf) to Percentage (for meter bar)
function hfPercentFromBase(baseHF) {
  const v = Number(baseHF);
  if (!isFinite(v)) return 0;

  let dBuV = v - 10.875;
  if (isNaN(dBuV)) dBuV = 0;

  const clamped = Math.max(0, Math.min(90, dBuV));
  return (clamped / 90) * 100;
}

// Build Scale labels based on unit
  function buildHFScale(unit) {
    const baseScale_dBuV = [90, 80, 70, 60, 50, 40, 30, 20, 10, 0];
    const ssu = (unit || hfUnit || "").toLowerCase();

    function round10(v) {
      return Math.round(v / 10) * 10;
    }

    const lastIndex = baseScale_dBuV.length - 1;

    if (ssu === "dbm") {
      return baseScale_dBuV.map((v, idx) => {
        const dBm = v - 108.875;
        const rounded = round10(dBm);
        return idx === lastIndex ? `${rounded} dBm` : `${rounded}`;
      });
    }

    if (ssu === "dbf") {
      return baseScale_dBuV.map((v, idx) => {
        const dBf = v + 10.875;
        const rounded = round10(dBf);
        return idx === lastIndex ? `${rounded} dBf` : `${rounded}`;
      });
    }

    // Default: dBµV
    return baseScale_dBuV.map((v, idx) => {
      const rounded = round10(v);
      return idx === lastIndex ? `${rounded} dBµV` : `${rounded}`;
    });
  }


// -------------------------------------------------------
// Peak & Color Helpers
// -------------------------------------------------------
function updatePeakValue(channel, current) {
  const p = peaks[channel];
  if (!p) return;

  const now = Date.now();

  if (current > p.value) {
    p.value = current;
    p.lastUpdate = now;
  } else if (now - p.lastUpdate > PEAK_CONFIG.holdMs) {
    p.value = p.value * PEAK_CONFIG.smoothing;
    if (p.value < 0.5) p.value = 0;
  }
}

// Calculate color with gradient logic based on CONFIG COLORS
function stereoColorForPercent(p, totalSegments = 30) {
  const i = Math.max(
    0,
    Math.min(totalSegments - 1, Math.round((p / 100) * totalSegments) - 1)
  );
  const topBandStart = totalSegments - 5;
  const cDanger = parseRgb(MeterColorDanger);
  const cSafe = parseRgb(MeterColorSafe);

  if (i >= topBandStart) {
    return MeterColorDanger;
  } else {
    const intensity = 0.4 + ((i / totalSegments) * 0.6); 
    return getScaledColor(cSafe, intensity);
  }
}

function setPeakSegment(meterEl, peak, meterId) {
  const segments = meterEl.querySelectorAll(".segment");
  if (!segments.length) return;

  const prev = meterEl.querySelector(".segment.peak-flag");
  if (prev) prev.classList.remove("peak-flag");

  const idx = Math.max(
    0,
    Math.min(segments.length - 1, Math.round((peak / 100) * segments.length) - 1)
  );
  const seg = segments[idx];
  if (!seg) return;

  seg.classList.add("peak-flag");

  // Determine Peak Color
  let peakColor = "";
  const isAudioMeter = meterId && (meterId.includes("left") || meterId.includes("right") || meterId.startsWith("eq"));

  if (PeakMode === "fixed" && isAudioMeter) {
    peakColor = PeakColorFixed;
  } else {
    // Dynamic Mode
    if (meterId && (meterId.includes("left") || meterId.includes("right"))) {
      peakColor = stereoColorForPercent(peak, segments.length);
    } else if (meterId && meterId.startsWith("eq")) {
        if (idx >= segments.length - 5) {
             peakColor = MeterColorDanger;
        } else {
             const cSafe = parseRgb(MeterColorSafe);
             const intensity = 0.4 + ((idx / segments.length) * 0.6);
             peakColor = getScaledColor(cSafe, intensity);
        }
    } else if (meterId.includes("hf")) {
        const hfThresholdIndex = Math.round((20 / 90) * segments.length);
        if (idx < hfThresholdIndex) {
            const cDanger = parseRgb(MeterColorDanger);
            const pos = idx / hfThresholdIndex; 
            const intensity = 0.6 + (pos * 0.4);
            peakColor = getScaledColor(cDanger, intensity);
        } else {
            const cSafe = parseRgb(MeterColorSafe);
            const intensity = 0.4 + ((idx / segments.length) * 0.6);
            peakColor = getScaledColor(cSafe, intensity);
        }
    }
  }

  // Apply Color FORCEFULLY
  if (peakColor) {
      seg.style.setProperty("background-color", peakColor, "important");
  }
}

// -------------------------------------------------------
// Meter Creation & Updating
// -------------------------------------------------------
function createLevelMeter(id, label, container, scaleValues) {
  const levelMeter = document.createElement("div");
  levelMeter.classList.add("level-meter");

  const top = document.createElement("div");
  top.classList.add("meter-top");

  const meterBar = document.createElement("div");
  meterBar.classList.add("meter-bar");
  meterBar.setAttribute("id", id);

  for (let i = 0; i < 30; i++) {
    const segment = document.createElement("div");
    segment.classList.add("segment");
    meterBar.appendChild(segment);
  }

  // Peak Marker only for Stereo channels
  if (id.includes("left") || id.includes("right")) {
    const marker = document.createElement("div");
    marker.className = "peak-marker";
    meterBar.appendChild(marker);
  }

  const labelElement = document.createElement("div");
  labelElement.classList.add("label");
  labelElement.innerText = label;

  const meterWrapper = document.createElement("div");
  meterWrapper.classList.add("meter-wrapper");

  if (id.includes("left")) labelElement.classList.add("label-left");
  if (id.includes("right")) labelElement.classList.add("label-right");

  meterWrapper.appendChild(meterBar);
  meterWrapper.appendChild(labelElement);

  if (scaleValues && scaleValues.length > 0) {
    const scale = document.createElement("div");
    scale.classList.add("meter-scale-AudioMeter");
    scaleValues.forEach((v) => {
      const tick = document.createElement("div");
      tick.innerText = v;
      scale.appendChild(tick);
    });
    top.appendChild(scale);
  }

  top.appendChild(meterWrapper);
  levelMeter.appendChild(top);
  container.appendChild(levelMeter);
}

function updateMeter(meterId, level) {
  const meter = document.getElementById(meterId);
  if (!meter) return;

  const safeLevel = Math.max(0, Math.min(100, Number(level) || 0));
  const segments = meter.querySelectorAll(".segment");
  const activeCount = Math.round((safeLevel / 100) * segments.length);

  // Parse Config Colors
  const cDanger = parseRgb(MeterColorDanger);
  const cSafe = parseRgb(MeterColorSafe);
  const cWarning = parseRgb(MeterColorWarning);

  segments.forEach((seg, i) => {
    let finalColor = "#333";

    if (i < activeCount) {
      // --- Stereo & EQ Meters ---
      if (
        meterId.includes("left") ||
        meterId.includes("right") ||
        meterId.startsWith("eq")
      ) {
        if (i >= segments.length - 5) {
          finalColor = MeterColorDanger;
        } else {
          const intensity = 0.4 + ((i / segments.length) * 0.6);
          finalColor = getScaledColor(cSafe, intensity);
        }

      // --- HF / RF Meter ---
      } else if (meterId.includes("hf")) {
        const hfThresholdIndex = Math.round((20 / 90) * segments.length);
        
        if (i < hfThresholdIndex) {
            const pos = i / hfThresholdIndex; 
            const intensity = 0.6 + (pos * 0.4);
            finalColor = getScaledColor(cDanger, intensity);
        } else {
            const intensity = 0.4 + ((i / segments.length) * 0.6);
            finalColor = getScaledColor(cSafe, intensity);
        }

      // --- Default Meters (Fallback) ---
      } else {
        if (i < segments.length * 0.6) {
           const intensity = 0.4 + ((i / segments.length) * 0.6);
           finalColor = getScaledColor(cSafe, intensity);
        } else if (i < segments.length * 0.8) {
           finalColor = MeterColorWarning;
        } else {
           finalColor = MeterColorDanger;
        }
      }
    } 

    // Apply color with !important to override any other styles/scripts
    seg.style.setProperty("background-color", finalColor, "important");
  });

  const isStereo = meterId.includes("left") || meterId.includes("right");
  const isEq = meterId.startsWith("eq");

  if (isStereo || isEq) {
    let key;
    if (isStereo) {
      if (meterId.includes("left")) key = "left";
      else if (meterId.includes("right")) key = "right";
    } else {
      const match = meterId.match(/^eq(\d+)-/);
      if (match) key = `eq${match[1]}`;
    }
    if (key && peaks[key]) {
      updatePeakValue(key, safeLevel);
      setPeakSegment(meter, peaks[key].value, meterId);
    }
  }
}

// -------------------------------------------------------
// EQ Calculation (10-band -> 5-band)
// -------------------------------------------------------
function mmCompute10BandLevels(freqData) {
  const bands = new Array(10).fill(0);
  const ranges = [
    [0, 2],   // Sub-bass
    [3, 5],   // Bass
    [6, 8],   // Low-mid
    [9, 12],  // Mid
    [13, 18], // High-mid
    [19, 25], // Presence
    [26, 32], // Brilliance 1
    [33, 40], // Brilliance 2
    [41, 48], // Air 1
    [49, 63]  // Air 2
  ];

  ranges.forEach((range, idx) => {
    let sum = 0;
    let count = 0;
    for (let i = range[0]; i <= range[1] && i < freqData.length; i++) {
      sum += freqData[i];
      count++;
    }
    bands[idx] = count > 0 ? sum / count : 0;
  });

  return bands;
}

function mmCollapse10To5(bands10) {
  if (!bands10 || bands10.length < 10) return null;

  const bands5 = [];
  bands5[0] = (bands10[0] + bands10[1]) / 2; // ~64 Hz
  bands5[1] = (bands10[2] + bands10[3]) / 2; // ~256 Hz
  bands5[2] = (bands10[4] + bands10[5]) / 2; // ~1 kHz
  bands5[3] = (bands10[6] + bands10[7]) / 2; // ~4 kHz
  bands5[4] = (bands10[8] + bands10[9]) / 2; // ~10 kHz
  return bands5;
}

// -------------------------------------------------------
// UI Overlay Helpers
// -------------------------------------------------------
function hideEqHint() {
  const hint = document.getElementById("eqHintText");
  if (!hint) return;
  hint.style.opacity = "0";
  setTimeout(() => {
    if (hint) hint.style.display = "none";
  }, 300);
}

// -------------------------------------------------------
// Audio Setup (Web Audio API)
// -------------------------------------------------------
function setupAudioEQ() {
  if (
    typeof Stream === "undefined" ||
    !Stream ||
    !Stream.Fallback ||
    !Stream.Fallback.Player ||
    !Stream.Fallback.Player.Amplification
  ) {
    setTimeout(setupAudioEQ, 2000);
    return;
  }
  
  const player = Stream.Fallback.Player;
  const sourceNode = player.Amplification;

  if (!sourceNode || !sourceNode.context) {
    setTimeout(setupAudioEQ, 2000);
    return;
  }

  try {
    const ctx = sourceNode.context;

    // Reset if AudioContext changed
    if (eqAudioContext !== ctx) {
      eqAudioContext   = ctx;
      eqAnalyser       = null;
      eqDataArray      = null;
      stereoSplitter   = null;
      stereoAnalyserL  = null;
      stereoAnalyserR  = null;
      stereoDataL      = null;
      stereoDataR      = null;
      eqSourceNode     = null;
    }

    if (!eqAnalyser || !eqDataArray) {
      eqAnalyser = eqAudioContext.createAnalyser();
      eqAnalyser.fftSize = 4096;
      eqAnalyser.smoothingTimeConstant = 0.6;
      eqDataArray = new Uint8Array(eqAnalyser.frequencyBinCount);
    }

    eqSourceNode = sourceNode;
    
    try { eqSourceNode.connect(eqAnalyser); } catch(e){}

    if (!stereoSplitter) {
      stereoSplitter  = eqAudioContext.createChannelSplitter(2);
      stereoAnalyserL = eqAudioContext.createAnalyser();
      stereoAnalyserR = eqAudioContext.createAnalyser();

      stereoAnalyserL.fftSize = 2048;
      stereoAnalyserR.fftSize = 2048;

      stereoDataL = new Uint8Array(stereoAnalyserL.frequencyBinCount);
      stereoDataR = new Uint8Array(stereoAnalyserR.frequencyBinCount);

      try { eqSourceNode.connect(stereoSplitter); } catch(e){}
      stereoSplitter.connect(stereoAnalyserL, 0);
      stereoSplitter.connect(stereoAnalyserR, 1);
    }

    if (!eqAnimationId) {
      startEqAnimation();
    }

    hideEqHint();
  } catch (e) {
    console.error("MetricsAudioMeter: Error while setting up audio analyser", e);
  }
}

function startEqAnimation() {
  if (eqAnimationId) cancelAnimationFrame(eqAnimationId);

  const loop = () => {
    if (!eqAnalyser || !eqDataArray) {
      eqAnimationId = requestAnimationFrame(loop);
      return;
    }

    // ---- AudioMeter Calculation ----
    eqAnalyser.getByteFrequencyData(eqDataArray);
    const levels10 = mmCompute10BandLevels(eqDataArray);
    const bands5 = mmCollapse10To5(levels10);

    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      let targetPercent = 0;
      if (bands5 && bands5[i] != null) {
        targetPercent = (bands5[i] / 255) * 100;
        targetPercent *= AudioMeterBoost;
      }

      if (targetPercent > 100) targetPercent = 100;
      if (targetPercent < 0) targetPercent = 0;

      eqLevels[i] += (targetPercent - eqLevels[i]) * 0.4;
      if (eqLevels[i] < 0.5) eqLevels[i] = 0;
      updateMeter(`eq${i + 1}-meter`, eqLevels[i]);
    }

    // ---- Stereo Calculation ----
    if (stereoAnalyserL && stereoAnalyserR && stereoDataL && stereoDataR) {
      stereoAnalyserL.getByteTimeDomainData(stereoDataL);
      stereoAnalyserR.getByteTimeDomainData(stereoDataR);

      let maxL = 0;
      let maxR = 0;

      for (let i = 0; i < stereoDataL.length; i++) {
        const d = Math.abs(stereoDataL[i] - 128);
        if (d > maxL) maxL = d;
      }
      for (let i = 0; i < stereoDataR.length; i++) {
        const d = Math.abs(stereoDataR[i] - 128);
        if (d > maxR) maxR = d;
      }

      let levelL = ((maxL / 128) * 100) * StereoBoost;
      let levelR = ((maxR / 128) * 100) * StereoBoost;

      levelL = Math.min(100, Math.max(0, levelL));
      levelR = Math.min(100, Math.max(0, levelR));

      levels.left = levelL;
      levels.right = levelR;

      // Use unique IDs to avoid conflict
      updateMeter("eq-left-meter", levelL);
      updateMeter("eq-right-meter", levelR);
    }

    eqAnimationId = requestAnimationFrame(loop);
  };

  eqAnimationId = requestAnimationFrame(loop);
}

// -------------------------------------------------------
// Public Initialization
// -------------------------------------------------------
function initAudioMeter(containerOrId = "level-meter-container") {
  const container =
    typeof containerOrId === "string"
      ? document.getElementById(containerOrId)
      : containerOrId;

  if (!container) return;

  if (window.MetricsMonitor && typeof window.MetricsMonitor.getSignalUnit === "function") {
    const u = window.MetricsMonitor.getSignalUnit();
    if (u) {
      hfUnit = u.toLowerCase();
    }
  }

  container.innerHTML = "";

  const signalMetersGroup = document.createElement("div");
  signalMetersGroup.classList.add("signal-meters-group");

  const stereoGroup = document.createElement("div");
  stereoGroup.classList.add("stereo-group");
  
  const stereoScale = [
    "+5 dB",
    "0",
    "-5",
    "-10",
    "-15",
    "-20",
    "-25",
    "-30",
    "-35 dB"
  ];
  
  createLevelMeter("eq-left-meter", "LEFT", stereoGroup, stereoScale);
  createLevelMeter("eq-right-meter", "RIGHT", stereoGroup, []);
  
  signalMetersGroup.appendChild(stereoGroup);

  const hfScale = buildHFScale(hfUnit);
  createLevelMeter("hf-meter", "RF", signalMetersGroup, hfScale);
  
  container.appendChild(signalMetersGroup);

  const eqGroup = document.createElement("div");
  eqGroup.classList.add("eq-group");

  const eqTitle = document.createElement("div");
  eqTitle.id = "eqTitle";
  eqTitle.innerText = "5-BAND AUDIOMETER";
  eqGroup.appendChild(eqTitle);

  const eqHintWrapper = document.createElement("div");
  eqHintWrapper.id = "eqHintWrapper";
  const eqHintText = document.createElement("div");
  eqHintText.id = "eqHintText";
  eqHintText.innerText = "Click play to show";
  eqHintWrapper.style.top = "-5%";
  eqHintWrapper.style.left = "-10%";
  eqHintWrapper.appendChild(eqHintText);
  stereoGroup.appendChild(eqHintWrapper);

  const eqBars = document.createElement("div");
  eqBars.classList.add("eq-bars");

  const eqFrequencyLabels = ["64", "256", "1k", "4k", "10k"];
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    const label = eqFrequencyLabels[i] || "";
    createLevelMeter(`eq${i + 1}-meter`, label, eqBars, []);
  }

  eqGroup.appendChild(eqBars);
  container.appendChild(eqGroup);

  // Initial Values
  updateMeter("eq-left-meter", levels.left);
  updateMeter("eq-right-meter", levels.right);
  updateMeter("hf-meter", levels.hf || 0);
  for (let i = 1; i <= EQ_BAND_COUNT; i++) {
    updateMeter(`eq${i}-meter`, 0);
  }

  setupAudioEQ();
  if (!eqSetupIntervalId) {
    eqSetupIntervalId = setInterval(setupAudioEQ, 3000);
  }

  if (!hfUnitListenerAttached && window.MetricsMonitor && typeof window.MetricsMonitor.onSignalUnitChange === "function") {
    hfUnitListenerAttached = true;
    window.MetricsMonitor.onSignalUnitChange((unit) => {
      if (window.MetricsAudioMeter && typeof window.MetricsAudioMeter.setHFUnit === "function") {
        window.MetricsAudioMeter.setHFUnit(unit);
      }
    });
  }
}

// -------------------------------------------------------
// Public API
// -------------------------------------------------------
window.MetricsAudioMeter = {
  init: initAudioMeter,

  setHF(baseValue) {
    const v = Number(baseValue);
    if (!isFinite(v)) return;

    levels.hfBase = v;
    const displayHF = hfBaseToDisplay(v);
    levels.hfValue = displayHF;

    const percent = hfPercentFromBase(v);
    levels.hf = percent;
    updateMeter("hf-meter", percent);
  },

  setHFUnit(unit) {
    if (!unit) return;
    hfUnit = unit.toLowerCase();

    const meterEl = document.getElementById("hf-meter");
    if (!meterEl) return;

    const levelMeter = meterEl.closest(".level-meter");
    if (!levelMeter) return;

    const scaleEl = levelMeter.querySelector(".meter-scale-AudioMeter");
    if (!scaleEl) return;

    const newScale = buildHFScale(hfUnit);
    const ticks = scaleEl.querySelectorAll("div");
    newScale.forEach((txt, idx) => {
      if (ticks[idx]) {
        ticks[idx].innerText = txt;
      }
    });

    if (typeof levels.hfBase === "number") {
      const displayHF = hfBaseToDisplay(levels.hfBase);
      levels.hfValue = displayHF;
    }
  },

  levels,
  updateMeter
};

})();