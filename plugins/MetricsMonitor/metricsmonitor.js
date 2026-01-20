/////////////////////////////////////////////////////////////////
//                                                             //
//  METRICSMONITOR CLIENT SCRIPT FOR FM-DX-WEBSERVER (V2.2)    //
//                                                             //
//  by Highpoint               last update: 20.01.2026         //
//                                                             //
//  Thanks for support by                                      //
//  Jeroen Platenkamp, Bkram, Wötkylä, AmateurAudioDude        //
//                                                             //
//  https://github.com/Highpoint2000/metricsmonitor            //
//                                                             //
/////////////////////////////////////////////////////////////////

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

  // =========================================================
  // Plugin version and update check configuration
  // =========================================================
  const plugin_version = "2.4";
  const updateInfo = true;

  const plugin_name = "MetricsMonitor";
  const plugin_path = "https://raw.githubusercontent.com/Highpoint2000/MetricsMonitor/";
  const plugin_JSfile = "main/plugins/MetricsMonitor/metricsmonitor.js";

  const CHECK_FOR_UPDATES = updateInfo;
  const pluginSetupOnlyNotify = true;
  const pluginName = plugin_name;
  const pluginHomepageUrl = "https://github.com/Highpoint2000/MetricsMonitor/releases";
  const pluginUpdateUrl = plugin_path + plugin_JSfile;


  // ---------------------------------------------------------
  // Exposed configuration for consumption by sub-modules
  // ---------------------------------------------------------
  const CONFIG = {
    // Note: MODULE_SEQUENCE and CANVAS_SEQUENCE are processed later based on Admin Rights
    MODULE_SEQUENCE: Array.isArray(MODULE_SEQUENCE) ? MODULE_SEQUENCE : [0],
    CANVAS_SEQUENCE: Array.isArray(CANVAS_SEQUENCE) ? CANVAS_SEQUENCE : [0],

    sampleRate,
    MeterInputCalibration,
    MPXmode,
    MPXStereoDecoder,
    MPXInputCard,
    MeterPilotCalibration,
    MeterMPXCalibration,
    MeterRDSCalibration,
    SpectrumYOffset,
    SpectrumYDynamics,
    StereoBoost,
    AudioMeterBoost,
    LockVolumeSlider,
    EnableAnalyzerAdminMode
  };

  // =========================================================
  // ADMIN / TUNE AUTHENTICATION CHECK
  // =========================================================
  let isTuneAuthenticated = false;

  function checkAdminMode() {
      // If feature is disabled, everyone is authenticated
      if (!CONFIG.EnableAnalyzerAdminMode) {
          isTuneAuthenticated = true;
          return;
      }

      const bodyText = document.body.textContent || document.body.innerText;
      const isAdminLoggedIn =
          bodyText.includes("You are logged in as an administrator.") ||
          bodyText.includes("You are logged in as an adminstrator."); // Keep typo check just in case
      const canControlReceiver =
          bodyText.includes("You are logged in and can control the receiver.");

      if (isAdminLoggedIn || canControlReceiver) {
          // console.log("[MetricsMonitor] Admin or Tune mode found. Analyzer Access Granted.");
          isTuneAuthenticated = true;
      } else {
          // console.log("[MetricsMonitor] No special authentication. Analyzer Access Restricted.");
          isTuneAuthenticated = false;
      }
  }

  // Run check immediately
  checkAdminMode();

  // ---------------------------------------------------------
  // Sequence Filtering based on Permissions
  // If not authenticated, filter out ID 2 (Analyzer)
  // ---------------------------------------------------------
  function filterSequence(seq) {
      if (isTuneAuthenticated) return seq;
      // Remove '2' (Analyzer/Scope) from the list
      return seq.filter(id => Number(id) !== 2);
  }

  const FINAL_MODULE_SEQUENCE = filterSequence(CONFIG.MODULE_SEQUENCE);
  const FINAL_CANVAS_SEQUENCE = filterSequence(CONFIG.CANVAS_SEQUENCE);

  // Update CONFIG for sub-modules to see the filtered list
  CONFIG.MODULE_SEQUENCE = FINAL_MODULE_SEQUENCE;
  CONFIG.CANVAS_SEQUENCE = FINAL_CANVAS_SEQUENCE;

  // ---------------------------------------------------------
  // Dependency Flags (Updated based on FINAL sequences)
  // ---------------------------------------------------------
  const NEED_CANVAS_2 = FINAL_CANVAS_SEQUENCE.some(v => Number(v) === 2);
  const NEED_CANVAS_4 = FINAL_CANVAS_SEQUENCE.some(v => Number(v) === 4);
  const HAS_SUPPORTED_CANVAS = NEED_CANVAS_2 || NEED_CANVAS_4;

  const NEED_MODULE_0 = FINAL_MODULE_SEQUENCE.some(v => Number(v) === 0);
  const NEED_MODULE_1 = FINAL_MODULE_SEQUENCE.some(v => Number(v) === 1);
  const NEED_MODULE_2 = FINAL_MODULE_SEQUENCE.some(v => Number(v) === 2);
  const NEED_MODULE_3 = FINAL_MODULE_SEQUENCE.some(v => Number(v) === 3);
  const NEED_MODULE_4 = FINAL_MODULE_SEQUENCE.some(v => Number(v) === 4);

  // Map configuration to specific functional requirements
  const NEED_AudioMeter       = NEED_MODULE_0;                    
  const NEED_METERS          = NEED_MODULE_1 || NEED_CANVAS_2 || NEED_CANVAS_4;    
  const NEED_ANALYZER        = NEED_MODULE_2 || NEED_CANVAS_2;    
  const NEED_SIGNAL_METER    = NEED_MODULE_3 || NEED_MODULE_4 || NEED_CANVAS_4; 
  const NEED_SIGNAL_ANALYZER = NEED_MODULE_4 || NEED_CANVAS_4;      

  // ---------------------------------------------------------
  // Expose Config globally to window object
  // ---------------------------------------------------------
  window.MetricsMonitor = window.MetricsMonitor || {};
  window.MetricsMonitor.Config = CONFIG;

  // =========================================================
  // Simple structured internal logger
  // =========================================================
  window.MetricsMonitor._logBuffer = window.MetricsMonitor._logBuffer || [];
  const LOG_MAX_ENTRIES = 500;
  const LOG_PREFIX = "[MetricsMonitor]";

  function mmLog(level, message, obj) {
    const ts = new Date().toISOString();
    const entry = { ts, level, message, obj };
    window.MetricsMonitor._logBuffer.push(entry);
    if (window.MetricsMonitor._logBuffer.length > LOG_MAX_ENTRIES) {
      window.MetricsMonitor._logBuffer.shift();
    }

    const formatted = `${LOG_PREFIX} ${ts} - ${message}`;
    if (obj !== undefined) {
      if (level === "error") console.error(formatted, obj);
      else if (level === "warn") console.warn(formatted, obj);
      else console.log(formatted, obj);
    } else {
      if (level === "error") console.error(formatted);
      else if (level === "warn") console.warn(formatted);
      else console.log(formatted);
    }
  }

  window.MetricsMonitor.mmLog = mmLog;
  window.MetricsMonitor.getLogs = () => window.MetricsMonitor._logBuffer.slice();
  window.MetricsMonitor.clearLogs = () => {
    window.MetricsMonitor._logBuffer = [];
    mmLog("log", "Log buffer cleared");
  };

  mmLog("log", "Logger initialized. Admin Mode: " + (CONFIG.EnableAnalyzerAdminMode ? "Enabled" : "Disabled") + ". Access: " + (isTuneAuthenticated ? "Granted" : "Restricted"));

  // =========================================================
  // Mode handling (Panel Modules)
  // =========================================================
  let START_INDEX = 0;
  const ACTIVE_SEQUENCE = FINAL_MODULE_SEQUENCE.length > 0 ? FINAL_MODULE_SEQUENCE : [0];

  if (START_INDEX < 0 || START_INDEX >= ACTIVE_SEQUENCE.length) START_INDEX = 0;

  let mode = ACTIVE_SEQUENCE[START_INDEX];
  let modeIndex = START_INDEX;
  let isSwitching = false;

  // =========================================================
  // Active Canvas handling
  // Tracks which canvas (2 or 4) is currently active
  // =========================================================
  let activeCanvasMode = null; // 2 or 4
  let isCanvasVisible = false; // Toggle state

  // Select the initial canvas mode based on filtered configuration
  function pickInitialCanvasMode() {
    if (FINAL_CANVAS_SEQUENCE.length === 0) return null;
    return Number(FINAL_CANVAS_SEQUENCE[0]);
  }


  // =========================================================
  // Global signal unit handling (dBm/dBf/etc)
  // =========================================================
  let globalSignalUnit = localStorage.getItem("mm_signal_unit") || "dbf";
  let signalUnitListeners = [];

  window.MetricsMonitor.getSignalUnit = function () {
    return globalSignalUnit;
  };

  window.MetricsMonitor.setSignalUnit = function (unit) {
    if (!unit) return;
    unit = unit.toLowerCase();
    mmLog("log", "SET SIGNAL UNIT → " + unit);
    globalSignalUnit = unit;
    localStorage.setItem("mm_signal_unit", unit);
    signalUnitListeners.forEach((fn) => fn(unit));
  };

  window.MetricsMonitor.onSignalUnitChange = function (fn) {
    if (typeof fn === "function") signalUnitListeners.push(fn);
  };

  // Hook into the existing UI dropdown for signal units
  function hookSignalUnitDropdown() {
    const input = document.getElementById("signal-selector-input");
    const options = document.querySelectorAll("#signal-selector .option");

    if (!input || options.length === 0) {
      setTimeout(hookSignalUnitDropdown, 500);
      return;
    }
    input.value = globalSignalUnit;
    window.MetricsMonitor.setSignalUnit(globalSignalUnit);
    options.forEach((opt) => {
      opt.addEventListener("click", () => {
        const val = opt.dataset.value?.toLowerCase();
        input.value = val;
        window.MetricsMonitor.setSignalUnit(val);
      });
    });
  }
  setTimeout(hookSignalUnitDropdown, 500);

  // =========================================================
  // Auto-detect plugin Base URL
  // =========================================================
  let BASE_URL = "";
  (function detectBase() {
    try {
      let s = document.currentScript;
      if (!s) {
        const list = document.getElementsByTagName("script");
        s = list[list.length - 1];
      }
      if (s && s.src) {
        const src = s.src.split("?")[0].split("#")[0];
        BASE_URL = src.substring(0, src.lastIndexOf("/") + 1);
      }
    } catch (e) {
      mmLog("error", "Base URL detection failed", e);
    }
  })();

  function url(file) {
    return BASE_URL + file.replace(/^\.\//, "");
  }

  // =========================================================
  // Dynamic Resource Loading (CSS/JS)
  // =========================================================
  function loadCss(file) {
    const href = url(file);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }

  function loadScript(file) {
    return new Promise((resolve, reject) => {
      const src = url(file);
      const el = document.createElement("script");
      el.src = src;
      el.async = false;
      el.onload = () => resolve();
      el.onerror = (err) => reject(err);
      document.head.appendChild(el);
    });
  }

  // =========================================================
  // Build module area (Panel rendering)
  // =========================================================
  function buildMeters() {
    const meters = document.getElementById("level-meter-container");
    if (!meters) return;
    meters.innerHTML = "";
    mmLog("log", "MODE = " + mode);

    if (mode === 0) window.MetricsAudioMeter?.init("level-meter-container");
    else if (mode === 1) {
      if (window.MetricsMeters && typeof window.MetricsMeters.resetValues === "function") {
        window.MetricsMeters.resetValues();
      }
      window.MetricsMeters?.initMeters(meters);
    } else if (mode === 2) window.MetricsAnalyzer?.init("level-meter-container");
    else if (mode === 3) window.MetricsSignalMeter?.init("level-meter-container");
    else if (mode === 4) {
      window.MetricsSignalAnalyzer?.init("level-meter-container");
      // Ensure text/data updates for the signal panel (headless listener)
      if (window.MetricsSignalMeter && typeof window.MetricsSignalMeter.startDataListener === "function") {
        window.MetricsSignalMeter.startDataListener();
      }
    }
  }
  
  // ---------------------------------------------------------
  // Track manual audio mode (B0/B1) even if originated from Header/UI
  // ---------------------------------------------------------
function trackOutgoingTextCmd(cmd, source = "unknown") {
  const c = String(cmd || "").trim();

  if (c === "B0") {
    lastAudioMonoState = false;
    mmLog("log", `Audio state tracked: STEREO (B0) via ${source}`);
  } else if (c === "B1") {
    lastAudioMonoState = true;
    mmLog("log", `Audio state tracked: MONO (B1) via ${source}`);
  }

  if (c === "B0" || c === "B1" || c === "B2") {
    lastSentTextMode = c;
  }
}

// Monkey-patch WebSocket.send to intercept outgoing commands
function patchTextSocketSend(ws) {
  if (!ws || ws._mmSendPatched) return;
  const origSend = ws.send.bind(ws);

  ws.send = (data) => {
    try {
      if (typeof data === "string") {
        const s = data.trim();
        if (s === "B0" || s === "B1" || s === "B2") {
          trackOutgoingTextCmd(s, "ws.send");
        }
      }
    } catch (e) {}
    return origSend(data);
  };

  ws._mmSendPatched = true;
  mmLog("log", "TextSocket.send patched for outgoing command tracking");
}


  // =========================================================
  // TEXT SOCKET MANAGEMENT
  // =========================================================
  let TextSocket = null;
  let textSocketReady = false;
  let liveStereoState = true;          // default = stereo (failsafe)
  let liveStereoStateKnown = false;    // becomes true once msg.st is received

  async function ensureTextSocket() {
    try {
      if (!window.socketPromise) return null;
      TextSocket = await window.socketPromise;
      if (!TextSocket) return null;

      if (!textSocketReady) {
        mmLog("log", "TextSocket available via socketPromise.");

        TextSocket.addEventListener("message", (evt) => {
          try {
            const msg = JSON.parse(evt.data);
			if (msg.st !== undefined) {
				liveStereoStateKnown = true;
				const newState = msg.st === true || msg.st === 1;
				if (liveStereoState !== newState) {
					liveStereoState = newState;
				}
			}
          } catch (e) {
            /* ignore parse errors */
          }
        });

        textSocketReady = true;
		patchTextSocketSend(TextSocket);
      }
      return TextSocket;
    } catch (err) {
      mmLog("error", "ensureTextSocket() failed", err);
      return null;
    }
  }

  async function sendTextWebSocketCommand(cmd) {
    const ws = await ensureTextSocket();
    if (!ws) {
      mmLog("error", `Cannot send "${cmd}" – no TextSocket.`);
      return;
    }

    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(cmd);
        mmLog("log", `TextSocket → "${cmd}"`);
        if (window.MetricsHeader && typeof window.MetricsHeader.setMonoLockFromMode === "function") {
          window.MetricsHeader.setMonoLockFromMode(cmd);
        }
      } catch (err) {
        mmLog("error", "Failed sending command", { cmd, err });
      }
    } else {
      setTimeout(() => sendTextWebSocketCommand(cmd), 300);
    }
  }

  // =========================================================
  // MPX / Audio Sync Logic (Canvas-Aware)
  // Determines if B2 (MPX) or B0/B1 (Audio) is required
  // =========================================================
  let textModeInitialized = false;
  let lastSentTextMode = null;
  let lastAudioMonoState = null;

function getCurrentAudioStateIsMono() {
  if (window.MetricsHeader && typeof window.MetricsHeader.getStereoStatus === "function") {
    return !window.MetricsHeader.getStereoStatus();
  }
  // IMPORTANT: if stereo state is unknown yet, assume stereo (NOT mono)
  if (textSocketReady && liveStereoStateKnown) {
    return !liveStereoState;
  }
  return false;
}

function syncTextWebSocketMode(isInitial) {
  if (syncTextWebSocketMode._restoreTimer) {
    clearTimeout(syncTextWebSocketMode._restoreTimer);
    syncTextWebSocketMode._restoreTimer = null;
  }

  let cmd = null;

  const moduleIsMPX = (mode === 1 || mode === 2);
  const canvasIsMPX = (activeCanvasMode === 2 && isCanvasVisible);
  const needMPX = moduleIsMPX || canvasIsMPX;

  const restoreNormalCmd = () => (lastAudioMonoState === true ? "B1" : "B0");

  mmLog(
    "log",
    `syncTextWebSocketMode(init=${!!isInitial}, MPXmode=${CONFIG.MPXmode}, mode=${mode}, canvas=${activeCanvasMode}, needMPX=${needMPX}, lastSent=${lastSentTextMode}, lastMono=${lastAudioMonoState})`
  );

  // MPXmode = off  => always B0
  if (CONFIG.MPXmode === "off") {
    if (!textModeInitialized && isInitial) cmd = "B0";
    else if (lastSentTextMode !== "B0") cmd = "B0";
    else return;
  }

  // MPXmode = on   => always B2
  else if (CONFIG.MPXmode === "on") {
    if (lastSentTextMode !== "B2") cmd = "B2";
    else return;
  }

  // MPXmode = auto
  else {
    if (needMPX) {
      if (lastSentTextMode !== "B2") cmd = "B2";
      else return;
    } else {
      // Normal state:
      // On FIRST load in normal state: ALWAYS B0
      if (!textModeInitialized && isInitial) {
        lastAudioMonoState = false;
        cmd = "B0";
      } else if (lastSentTextMode === "B2") {
        // Restore B0/B1 based on manual state prior to MPX
        cmd = restoreNormalCmd();
      } else {
        // Already normal and initialized -> do NOT override manual B0/B1
        return;
      }
    }
  }

  if (!cmd) return;

  // Enter MPX: freeze current normal state (B0/B1) for later restoration
  if (cmd === "B2") {
    if (lastSentTextMode !== "B2") {
      if (lastSentTextMode === "B1") lastAudioMonoState = true;
      else if (lastSentTextMode === "B0") lastAudioMonoState = false;
      else {
        // Fallback if we don't know: read current audio state
        lastAudioMonoState = !!getCurrentAudioStateIsMono();
      }

      mmLog(
        "log",
        `Switching TO MPX (B2). Frozen restore state: ${lastAudioMonoState ? "MONO (B1)" : "STEREO (B0)"}`
      );
    }

    sendTextWebSocketCommand("B2");
    textModeInitialized = true;
    return;
  }

  // Restore normal B0/B1 (after leaving B2)
  if (cmd === "B0" || cmd === "B1") {
    const delay = (lastSentTextMode === "B2") ? 80 : 0;

    syncTextWebSocketMode._restoreTimer = setTimeout(() => {
      sendTextWebSocketCommand(cmd);
      textModeInitialized = true;
      syncTextWebSocketMode._restoreTimer = null;
    }, delay);
  }
}


  // =========================================================
  // Cleanup function for current mode
  // =========================================================
  function cleanupCurrentMode() {
    //console.log('mode:', mode, ' c-mode:', activeCanvasMode, ' c-visible:', isCanvasVisible);
    if (!isCanvasVisible || activeCanvasMode !== 2) {
      if (mode === 1 && window.MetricsAnalyzer?.cleanup) window.MetricsAnalyzer.cleanup();
      if (mode === 2 && window.MetricsMeters?.cleanup) window.MetricsMeters.cleanup();
      if (mode !== 1 && mode !== 2 && window.MetricsAnalyzer?.cleanup && window.MetricsMeters?.cleanup) {
        window.MetricsAnalyzer.cleanup();
        window.MetricsMeters.cleanup();
      }
    } else if (isCanvasVisible && activeCanvasMode === 2) {
      if (mode !== 1) window.MetricsMeters?.createWebSocket();
    }
  }

  // =========================================================
  // Switching & Panel Logic
  // =========================================================
  function switchModeWithFade(nextMode) {
    const meters = document.getElementById("level-meter-container");
    if (!meters) {
      mode = nextMode;
      cleanupCurrentMode();  // Cleanup before switching
      buildMeters();
      syncTextWebSocketMode(false);
      return;
    }
    if (isSwitching) return;

    const FADE_MS = 150;
    isSwitching = true;

    meters.style.transition = `opacity ${FADE_MS}ms ease-in-out`;
    if (!meters.style.opacity) meters.style.opacity = "1";
    void meters.offsetWidth;
    meters.style.opacity = "0";

    setTimeout(() => {
      mode = nextMode;
      cleanupCurrentMode();  // Cleanup before switching
      buildMeters();
      syncTextWebSocketMode(false);

      void meters.offsetWidth;
      meters.style.opacity = "1";
      setTimeout(() => {
        isSwitching = false;
      }, FADE_MS);
    }, FADE_MS);
  }

  function attachToggle() {
    const container = document.getElementById("level-meter-container");
    if (!container) return;

    // Only enable click toggle if there is more than one module available
    if (ACTIVE_SEQUENCE.length <= 1) {
      container.style.cursor = "default";
      return;
    }

    container.style.cursor = "pointer";
    container.addEventListener("click", () => {
      modeIndex = (modeIndex + 1) % ACTIVE_SEQUENCE.length;
      switchModeWithFade(ACTIVE_SEQUENCE[modeIndex]);
    });
  }

  function attachHotkeys() {
    document.addEventListener("keydown", (e) => {
      const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;

      const n = parseInt(e.key, 10);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;

      const idx = n - 1;
      if (idx >= ACTIVE_SEQUENCE.length) return;

      modeIndex = idx;
      switchModeWithFade(ACTIVE_SEQUENCE[modeIndex]);
    });
  }

  function lockVolumeControls(retry = 0) {
    if (!CONFIG.LockVolumeSlider) return;
    const MAX_RETRIES = 10;

    const slider = document.getElementById("volumeSlider");
    if (slider) {
      slider.value = "1";
      slider.disabled = true;
    } else if (retry < MAX_RETRIES) {
      setTimeout(() => lockVolumeControls(retry + 1), 500);
    }

    if (window.Stream?.Fallback?.Player?.Amplification?.gain) {
      try {
        Stream.Fallback.Player.Amplification.gain.value = 1.0;
      } catch (e) {}
    } else if (retry < MAX_RETRIES) {
      setTimeout(() => lockVolumeControls(retry + 1), 500);
    }
  }

  // =========================================================
  // Insert Panel + Tooltip (Only when > 1 module)
  // =========================================================
  let tooltipShownOnce = false;
  let tooltipTimeout;

  function insertPanel() {
    const panels = document.querySelectorAll(".flex-container .panel-33.no-bg-phone");
    if (panels.length < 3) return;

    const panel = panels[2];
    panel.id = "signalPanel";
    panel.innerHTML = "";
    panel.style.cssText =
      "position: relative; min-height: 235px; height: 235px; padding: 10px; display: flex; flex-direction: column; justify-content: flex-start; gap: 6px; margin-top: -88px; overflow: hidden; align-items: stretch;";

    const icons = document.createElement("div");
    icons.id = "signal-icons";
    icons.style.position = "absolute";
    panel.appendChild(icons);
    if (window.innerWidth < 800) icons.style.marginLeft = "14px";
    else icons.style.marginLeft = "-8px";

    if (window.MetricsHeader?.initHeader) MetricsHeader.initHeader(icons);

    const meters = document.createElement("div");
    meters.id = "level-meter-container";
    meters.style.opacity = "1";
    meters.style.marginTop = "25px";
    meters.style.width = "102%";
    panel.appendChild(meters);

    // Only enable panel click + tooltip if there is more than one module
    const allowModuleToggle = ACTIVE_SEQUENCE.length > 1;
    meters.style.cursor = allowModuleToggle ? "pointer" : "default";

    if (allowModuleToggle) {
      const customTooltip = document.createElement("div");
      // Use mapped IDs (1-indexed) for tooltip, but check logic
      const activeKeys = ACTIVE_SEQUENCE.map((val, index) => index + 1).join(",");
      customTooltip.textContent = "Click here or press a number " + activeKeys + " to change the display mode.";

      customTooltip.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        padding: 6px 15px;
        border-radius: 15px;
        background-color: var(--color-2);
        border: 2px solid color-mix(in srgb, var(--color-3) 100%, white 5%);
        color: #FFFFFF;
        font-family: Arial, sans-serif;
        font-size: 13px;
        z-index: 1000;
        pointer-events: none;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.3s, visibility 0.3s;
        white-space: normal;
        max-width: 240px;
        text-align: center;
      `;
      panel.appendChild(customTooltip);

      meters.addEventListener("mouseenter", () => {
        if (!tooltipShownOnce) {
          clearTimeout(tooltipTimeout);
          customTooltip.style.opacity = "1";
          customTooltip.style.visibility = "visible";
          tooltipTimeout = setTimeout(() => {
            customTooltip.style.opacity = "0";
            customTooltip.style.visibility = "hidden";
          }, 3000);
          tooltipShownOnce = true;
        }
      });
    }

    buildMeters();

ensureTextSocket().then(() => {
  if (activeCanvasMode == null) activeCanvasMode = pickInitialCanvasMode();
  syncTextWebSocketMode(true);
  autoEnableSpectrumWhenReady();
});

    attachToggle();
    attachHotkeys();
  }

  // =========================================================
  // UI Cleanup Elements
  // =========================================================
  function cleanup() {
    const flags = document.getElementById("flags-container-desktop");
    if (flags) flags.style.visibility = "hidden";

    function remove() {
      document.querySelector(".data-pty.text-color-default")?.remove();
      document.querySelector("h3.color-4.flex-center")?.remove();
    }
    remove();
    new MutationObserver(remove).observe(document.body, { childList: true, subtree: true });
  }

  if (CONFIG.LockVolumeSlider) {
    const style = document.createElement("style");
    style.innerHTML = `#volumeSlider { opacity: 0.4 !important; pointer-events: none !important; }`;
    document.head.appendChild(style);
  }

  // =========================================================
  // Update Checker
  // =========================================================
  function checkUpdate(setupOnly, pluginName, urlUpdateLink, urlFetchLink) {
    const isSetupPath = (window.location.pathname || "/").indexOf("/setup") >= 0;
    const ver = typeof plugin_version !== "undefined" ? plugin_version : "Unknown";

    fetch(urlFetchLink, { cache: "no-store" })
      .then((r) => r.text())
      .then((txt) => {
        let remoteVer = "Unknown";
        const match = txt.match(/const\s+plugin_version\s*=\s*['"]([^'"]+)['"]/);
        if (match) remoteVer = match[1];

        if (remoteVer !== "Unknown" && remoteVer !== ver) {
          mmLog("log", `Update available: ${ver} -> ${remoteVer}`);

          if (!setupOnly || isSetupPath) {
            const settings = document.getElementById("plugin-settings");
            if (settings) {
              settings.innerHTML += `<br><a href="${urlUpdateLink}" target="_blank">[${pluginName}] Update: ${ver} -> ${remoteVer}</a>`;
            }

            const updateIcon =
              document.querySelector(".wrapper-outer #navigation .sidenav-content .fa-puzzle-piece") ||
              document.querySelector(".wrapper-outer .sidenav-content") ||
              document.querySelector(".sidenav-content");

            if (updateIcon) {
              const redDot = document.createElement("span");
              redDot.style.cssText = `
                display: block;
                width: 12px;
                height: 12px;
                border-radius: 50%;
                background-color: #FE0830;
                margin-left: 82px;
                margin-top: -12px;
              `;
              updateIcon.appendChild(redDot);
            }
          }
        }
      })
      .catch((e) => {
        mmLog("error", `Update check for ${pluginName} failed`, e);
      });
  }

  // =========================================================
  // TOGGLE BUTTON (MPX/SIGNAL)
  // =========================================================
    // =========================================================
  // Robust button click binding (survives DOM rebuilds via event delegation)
  // =========================================================
  function installMpxSignalToggleHandlerOnce() {
    window.MetricsMonitor = window.MetricsMonitor || {};
    if (window.MetricsMonitor._mmMpxSignalDelegated) return;
    window.MetricsMonitor._mmMpxSignalDelegated = true;

    document.addEventListener(
      "click",
      (ev) => {
        try {
          if (ev && ev.__mmMpxHandled) return;
          const t = ev.target;
          const btn = t && t.closest ? t.closest("#mpx-signal-toggle-button") : null;
          if (!btn) return;
          ev.__mmMpxHandled = true;
          toggleMpxSignalCanvas();
        } catch (_) {}
      },
      true // capture
    );
  }

  function createMpxSignalButton() {
    installMpxSignalToggleHandlerOnce();
    
    // CRITICAL: Stop here if CANVAS_SEQUENCE does not contain 2 or 4 (filtered check)
    if (!HAS_SUPPORTED_CANVAS) return;

    const buttonId = "mpx-signal-toggle-button";
    if (document.getElementById(buttonId)) return;

    // Use addIconToPluginPanel if available (Webserver standard function)
    (function waitForFunction() {
      const maxWaitTime = 30000;
      let functionFound = false;

      const observer = new MutationObserver(() => {
        if (typeof addIconToPluginPanel === "function") {
          observer.disconnect();
          try {
            // Create Button with 'wave-square' icon
            addIconToPluginPanel(buttonId, "MPX/Signal", "solid", "wave-square", "MPX/Signal");
            functionFound = true;
          } catch (e) {
            mmLog("warn", "addIconToPluginPanel failed, using legacy button", e);
          }
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        if (!functionFound) legacyButtonCreate();
      }, maxWaitTime);
    })();

    const buttonCss = `
      #${buttonId}:hover { color: var(--color-5); filter: brightness(120%); }
      #${buttonId}.active { background-color: var(--color-2) !important; }
`;
    $("<style>").prop("type", "text/css").html(buttonCss).appendTo("head");
  }

  function legacyButtonCreate() {
    // Fallback for older versions or non-standard dashboards
    const buttonId = "mpx-signal-toggle-button";
    if (document.getElementById(buttonId)) return;

    // Avoid duplicates if a dashboard list exists (legacy behavior)
    if (document.querySelector(".dashboard-panel-plugin-list")) return;

    const BUTTON_NAME = "MPX/SIGNAL";

    const aButtonText = $("<strong>", { class: "aspectrum-text", html: BUTTON_NAME });
    const aButton = $("<button>", { id: buttonId, class: "hide-phone bg-color-2" });

    aButton.css({
      "border-radius": "0px",
      "width": "100px",
      "height": "22px",
      "position": "relative",
      "margin-top": "16px",
      "margin-left": "5px",
      "right": "0px"
    });

    aButton.append(aButtonText);

    let buttonWrapper = $("#button-wrapper");
    if (buttonWrapper.length) {
      buttonWrapper.append(aButton);
    } else {
      const wrapperElement = $(".tuner-info");
      if (wrapperElement.length) {
        buttonWrapper = $("<div>", { id: "button-wrapper", class: "button-wrapper" });
        wrapperElement.append(buttonWrapper);
        wrapperElement.append(document.createElement("br"));
        buttonWrapper.append(aButton);
      }
    }

    // Note: No direct click handler here (delegation handles it)
  }

    // =========================================================
  // RDS Logger coexistence helpers (avoid DOM conflicts)
  // =========================================================
  function getRdsLoggerState() {
    const loggingCanvas = document.getElementById("logging-canvas");
    const btn = document.getElementById("Log-on-off");
    const loaded = !!(loggingCanvas || btn);

    let on = false;
    try {
      // RDS Logger marks the button as .active when running
      if (btn && btn.classList.contains("active")) on = true;
      // Fallback: visible logging-canvas
      else if (loggingCanvas && getComputedStyle(loggingCanvas).display !== "none") on = true;
    } catch (_) {}

    return { loaded, on };
  }

  // Only restore elements that were hidden by MetricsMonitor itself
  function mmHideEl(el) {
    if (!el) return;
    if (el.dataset.mmHiddenByMm === "1") return;

    if (el.dataset.mmOrigDisplay === undefined) {
      el.dataset.mmOrigDisplay = (el.style && typeof el.style.display === "string") ? el.style.display : "";
    }

    el.dataset.mmHiddenByMm = "1";
    el.style.display = "none";
  }

  function mmRestoreEl(el) {
    if (!el) return;
    if (el.dataset.mmHiddenByMm !== "1") return;

    const orig = (el.dataset.mmOrigDisplay !== undefined) ? el.dataset.mmOrigDisplay : "";
    el.style.display = orig;

    delete el.dataset.mmHiddenByMm;
    delete el.dataset.mmOrigDisplay;
  }

  function setStandardCanvasVisibility(show) {
    const logger = getRdsLoggerState();

    // Elements that normally live in the canvas container
    // IMPORTANT: #logging-canvas is intentionally ignored here
    const ids = ["signal-canvas", "sdr-graph", "Antenna", "containerRotator", "sdr-graph-button-container"];

    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;

      // These elements are controlled by the RDS Logger when active
      const loggerManaged = (id === "signal-canvas" || id === "Antenna" || id === "containerRotator");

      if (show) {
        // If logger is ON, don't interfere with its elements
        if (logger.on && loggerManaged) return;
        mmRestoreEl(el);
      } else {
        mmHideEl(el);
      }
    });
  }


  // Apply custom styling for the MPX/Signal wide view
  function applyCustomContainerStyles() {
    const canvasContainer = document.querySelector(".canvas-container.hide-phone");
    if (!canvasContainer) return;

    canvasContainer.style.padding = "0";
    canvasContainer.style.margin = "0";
    canvasContainer.style.lineHeight = "0";
    canvasContainer.style.overflow = "visible";

    const parent = canvasContainer.parentElement;
    if (parent) {
      const cs = getComputedStyle(parent);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      canvasContainer.style.marginLeft = `-${padL}px`;
      canvasContainer.style.marginRight = `-${padR}px`;
      canvasContainer.style.width = `calc(98.4% + ${padL + padR}px)`;
    }
  }

  // Reset custom styling to fix layout when returning to standard view
  function resetContainerStyles() {
    const canvasContainer = document.querySelector(".canvas-container.hide-phone");
    if (!canvasContainer) return;

    canvasContainer.style.padding = "";
    canvasContainer.style.margin = "";
    canvasContainer.style.lineHeight = "";
    canvasContainer.style.overflow = "";
    canvasContainer.style.marginLeft = "";
    canvasContainer.style.marginRight = "";
    canvasContainer.style.width = "";
  }

    function toggleMpxSignalCanvas() {
    const logger = getRdsLoggerState();

    // Block toggle if RDS Logger is active to prevent conflicts
    if (logger.on) {
      mmLog("warn", "MPX/Signal toggle blocked: RDS Logger is active");
      if (typeof sendToast === "function") {
        try {
          sendToast("warning", "MetricsMonitor", "Disable RDS Logger first (Log button) to use MPX/Signal.", false, false);
        } catch (_) {}
      }
      return;
    }

    // Ensure we have a valid target canvas mode
    if (activeCanvasMode == null) activeCanvasMode = pickInitialCanvasMode();

    isCanvasVisible = !isCanvasVisible;

    cleanupCurrentMode();  // Cleanup before switching on canvas open/close

    const button = document.getElementById("mpx-signal-toggle-button");
    const mmContainerCombo = document.getElementById("mm-mpx-combo-flex");
    const mmContainerSignal = document.getElementById("mm-signal-analyzer-flex");

    if (isCanvasVisible) {
      // --- TURN ON (Show MM canvas) ---
      if (button) {
        button.classList.add("active");
        button.classList.remove("inactive");
      }

      // Hide standard elements (only those we manage)
      setStandardCanvasVisibility(false);

      // Apply full-width styles
      applyCustomContainerStyles();

      // Prepare MM canvas
      if (activeCanvasMode === 2) {
        replaceMainCanvasWithMpxComboIfRequired(); // will append/show
      } else if (activeCanvasMode === 4) {
        replaceMainCanvasIfRequired(); // will append/show
      }

      // Show the relevant MM container
      if (activeCanvasMode === 2 && mmContainerCombo) {
          mmContainerCombo.style.display = "flex";
          if(window.mmTriggerResize) window.mmTriggerResize();
      }
      if (activeCanvasMode === 4 && mmContainerSignal) {
          mmContainerSignal.style.display = "flex";
          if(window.mmTriggerResizeSignal) window.mmTriggerResizeSignal();
      }

      // Sync audio (trigger B2/B1 depending on need)
      syncTextWebSocketMode(false);
    } else {
      // --- TURN OFF (Show Standard canvas) ---
      if (button) {
        button.classList.remove("active");
        button.removeAttribute("disabled");
        button.setAttribute("aria-pressed","false");
      }

      // Hide MM elements & STOP Heartbeat (destroy instances)
      if (mmContainerCombo) {
          mmContainerCombo.style.display = "none";
          // If we had an analyzer active in Combo, destroy it to stop heartbeat
          if (window.MetricsAnalyzer && window.MetricsAnalyzer.destroy) {
              window.MetricsAnalyzer.destroy("mm-combo-analyzer-container");
          }
      }
      
      if (mmContainerSignal) {
          mmContainerSignal.style.display = "none";
          // Clean up signal analyzer if needed (Canvas 4)
          if (window.MetricsSignalAnalyzer && window.MetricsSignalAnalyzer.destroy) {
               window.MetricsSignalAnalyzer.destroy("main-signal-analyzer-container");
          } else if (window.MetricsSignalAnalyzer && window.MetricsSignalAnalyzer.cleanup) {
               window.MetricsSignalAnalyzer.cleanup();
          }
      }

      // Reset container styles to default
      resetContainerStyles();

      // Show standard elements
      setStandardCanvasVisibility(true);

      // Sync audio (trigger B0)
      syncTextWebSocketMode(false);
    }
  }


  function initCanvasVisibility() {
      // Initially, we want to be in the "OFF" state (Standard View)
      isCanvasVisible = false;
      // Ensure MM elements are hidden if they exist
      setStandardCanvasVisibility(true); 
  }

  // =========================================================
  // STARTUP
  // =========================================================
  function start() {
    mmLog("log", "Starting...");

    // Decide initial active canvas (2 or 4)
    activeCanvasMode = pickInitialCanvasMode();

    if (HAS_SUPPORTED_CANVAS) {
        initCanvasVisibility();
        createMpxSignalButton();
    }

    // --- CSS (conditional loading) ---
    [
      "css/metricsmonitor.css",
      "css/metricsmonitor_header.css",

      NEED_METERS ? "css/metricsmonitor_meters.css" : null,
      NEED_AudioMeter ? "css/metricsmonitor-audiometer.css" : null,
      NEED_ANALYZER ? "css/metricsmonitor-analyzer.css" : null,
      NEED_SIGNAL_METER ? "css/metricsmonitor-signalmeter.css" : null,
      NEED_SIGNAL_ANALYZER ? "css/metricsmonitor-signal-analyzer.css" : null
    ]
      .filter(Boolean)
      .forEach(loadCss);

    // --- JS (conditional loading) ---
    const scriptsToLoad = [
      "js/metricsmonitor-header.js",

      NEED_METERS ? "js/metricsmonitor-meters.js" : null,
      NEED_AudioMeter ? "js/metricsmonitor-audiometer.js" : null,
      NEED_ANALYZER ? "js/metricsmonitor-analyzer.js" : null,
      NEED_SIGNAL_METER ? "js/metricsmonitor-signalmeter.js" : null,
      NEED_SIGNAL_ANALYZER ? "js/metricsmonitor-signal-analyzer.js" : null
    ].filter(Boolean);

    Promise.all(scriptsToLoad.map(loadScript))
      .then(() => {
        // NOTE: We REMOVED the pre-loading logic here.
        // The canvas instances (and thus the heartbeat) will ONLY start
        // when the user clicks the toggle button or selects a panel mode.

        // Setup the toggle logic for clicking inside the MM canvas (switching 2 <-> 4)
        setupCanvasToggle();

        insertPanel();
        cleanup();
        lockVolumeControls();
      })
      .catch((err) => {
        mmLog("error", "Load error", err);
      });
  }

  if (CHECK_FOR_UPDATES) checkUpdate(pluginSetupOnlyNotify, pluginName, pluginHomepageUrl, pluginUpdateUrl);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  // =========================================================
  // CANVAS_SEQUENCE toggle logic (switching between 2 & 4)
  // =========================================================
  let isCanvasSwitching = false;
  let canvasTooltipShownOnce = false;
  let canvasTooltipTimeout;

  function switchCanvasWithFade(targetMode) {
    // Only switch if the custom view is visible
    if (!isCanvasVisible) {
        // Update state silently if hidden
        activeCanvasMode = targetMode;
        return;
    }
    
    // Switch visual logic
    const oldEl = (activeCanvasMode === 2) ? document.getElementById("mm-mpx-combo-flex") : document.getElementById("mm-signal-analyzer-flex");
    const newEl = (targetMode === 2) ? document.getElementById("mm-mpx-combo-flex") : document.getElementById("mm-signal-analyzer-flex");

    if (isCanvasSwitching) return;
    isCanvasSwitching = true;
    const FADE_MS = 150;

    // Fade Out current
    if (oldEl) {
        oldEl.style.transition = `opacity ${FADE_MS}ms`;
        oldEl.style.opacity = '0';
    }

    setTimeout(() => {
      
      // 1. DESTROY OLD
      // We must explicitly destroy the old analyzer to stop the heartbeat
      if (activeCanvasMode === 2) {
          if (window.MetricsAnalyzer && window.MetricsAnalyzer.destroy) {
              window.MetricsAnalyzer.destroy("mm-combo-analyzer-container");
          }
      } else if (activeCanvasMode === 4) {
          if (window.MetricsSignalAnalyzer && window.MetricsSignalAnalyzer.destroy) {
               window.MetricsSignalAnalyzer.destroy("main-signal-analyzer-container");
          }
      }
      
      // Hide old container explicitly
      if (oldEl) {
          oldEl.style.display = 'none';
          oldEl.style.opacity = '1'; // reset for next time
      }

      // 2. UPDATE MODE
      activeCanvasMode = targetMode;

      // 3. CREATE/SHOW NEW
      // This function handles display:flex AND calling init() again
      if (targetMode === 2) replaceMainCanvasWithMpxComboIfRequired();
      else if (targetMode === 4) replaceMainCanvasIfRequired();

      const createdEl = (targetMode === 2) ? document.getElementById("mm-mpx-combo-flex") : document.getElementById("mm-signal-analyzer-flex");
      if (createdEl) {
          createdEl.style.opacity = '0';
          createdEl.style.display = 'flex';
          
          requestAnimationFrame(() => {
             createdEl.style.transition = `opacity ${FADE_MS}ms`;
             createdEl.style.opacity = '1';
          });
      }

      syncTextWebSocketMode(false);
      
      // Update scaling immediately for new element
      if (targetMode === 2 && window.mmTriggerResize) window.mmTriggerResize();
      if (targetMode === 4 && window.mmTriggerResizeSignal) window.mmTriggerResizeSignal();
      
      setTimeout(() => { isCanvasSwitching = false; }, FADE_MS);

    }, FADE_MS);
  }

  function setupCanvasToggle() {
    const supported = [2, 4];
    // Robust check for numbers/strings in filter
    const active = FINAL_CANVAS_SEQUENCE.filter((m) => supported.some(s => Number(s) === Number(m))).map(Number);
    if (active.length < 2) return;

    // Attach click listener to wrapper container
    const container = document.querySelector(".canvas-container.hide-phone");
    if (!container) return;

    // Note: Trigger only if click was inside MM elements
    container.addEventListener("click", (e) => {
        if (!isCanvasVisible || isCanvasSwitching) return;
        // Check if click was inside our MM elements
        if (e.target.closest("#mm-mpx-combo-flex") || e.target.closest("#mm-signal-analyzer-flex")) {
             let currentIndex = active.indexOf(activeCanvasMode);
             if (currentIndex < 0) currentIndex = 0;
             currentIndex = (currentIndex + 1) % active.length;
             switchCanvasWithFade(active[currentIndex]);
        }
    });
  }

// =========================================================
// CANVAS_SEQUENCE = 4: Signal + Signal Analyzer
// =========================================================
  function replaceMainCanvasIfRequired() {
    if (!Array.isArray(CONFIG.CANVAS_SEQUENCE) || !CONFIG.CANVAS_SEQUENCE.some(v => Number(v) === 4)) return;

    const canvasContainer = document.querySelector(".canvas-container.hide-phone");
    if (!canvasContainer) return;

    // Check if exists
    if (document.getElementById("mm-signal-analyzer-flex")) {
        if (isCanvasVisible && activeCanvasMode === 4) {
             document.getElementById("mm-signal-analyzer-flex").style.display = 'flex';
        }
        return; 
    }

    // --- Create Elements (Append, DO NOT CLEAR) ---

    const INTERNAL_HEIGHT = 160; 
    const SIGNAL_COL_W = 180;
    const SIGNAL_BOX_W = 180;

    const CUSTOM_CSS = `
      #mm-signal-analyzer-flex{
        display: none; /* Hidden by default */
        align-items:stretch;
        width:100%;
        height:${INTERNAL_HEIGHT}px !important;
        min-height:${INTERNAL_HEIGHT}px !important;
        background: linear-gradient(180deg, #071c33 0%, #041425 100%);
        border:1px solid rgba(255,255,255,0.45);
        border-radius:0px;
        overflow:hidden;
        box-sizing:border-box;
        
        transform-origin: top center;
        position: relative;
        z-index: 5;
        
        /* Static Transform: 10px right, 10px up */
        transform: translate(10px, -10px);
        margin-bottom: -20px; /* Compensate for the upward shift layout-wise if needed */
      }
      /* ... (rest of CSS identical) ... */
      #mm-signal-col{ width:${SIGNAL_COL_W}px; min-width:${SIGNAL_COL_W}px; padding:12px 12px 12px 14px; display:flex; align-items:stretch; justify-content:stretch; box-sizing:border-box; border-right: none !important; }
      #mm-signal-box{ width:${SIGNAL_BOX_W}px; max-width:100%; flex:1; padding:40px 14px 12px 12px; display:flex; align-items:center; justify-content:center; box-sizing:border-box; }
      #mm-signal-analyzer-flex .signal-panel-layout .signal-heading{ align-self:flex-start; width:100%; padding-left:12px; box-sizing:border-box; margin:0; position:relative; top:-30px; line-height:1; }
      #mm-signal-analyzer-flex .signal-panel-layout .highest-signal-container{ align-self:flex-start; width:100%; padding-left:12px; box-sizing:border-box; margin-top:-18px; margin-bottom:16px; line-height:1; }
      #mm-signal-analyzer-flex .signal-panel-layout .text-big { flex-direction:column; align-items:center; text-align:center; line-height:1.05; margin-top:20px; margin-left:-2px; width:100%; }
      #main-signal-analyzer-container{ position:relative; flex:1; height:110%; padding:0px 6px 12px 12px; overflow:hidden; justify-content:center; box-sizing:border-box; border:none !important; outline:none !important; box-shadow: inset 1px 0 0 rgba(255,255,255,0.10) !important; }
      #main-signal-analyzer-container [data-mm-signal-analyzer-wrap], #main-signal-analyzer-container [data-mm-signal-analyzer-canvas], #main-signal-analyzer-container canvas{ height:100%; display:block; border:none !important; outline:none !important; box-shadow:none !important; }
    `;

    const existingStyle = document.getElementById("metrics-signal-analyzer-css");
    if (existingStyle) {
      existingStyle.textContent = CUSTOM_CSS;
    } else {
      const style = document.createElement("style");
      style.id = "metrics-signal-analyzer-css";
      style.textContent = CUSTOM_CSS;
      document.head.appendChild(style);
    }
    
    const flex = document.createElement("div");
    flex.id = "mm-signal-analyzer-flex";
    if (isCanvasVisible && activeCanvasMode === 4) flex.style.display = "flex";
    else flex.style.display = "none";
    canvasContainer.appendChild(flex);

    // ... (DOM Creation) ...
    const signalCol = document.createElement("div");
    signalCol.id = "mm-signal-col";
    flex.appendChild(signalCol);

    const signalBox = document.createElement("div");
    signalBox.id = "mm-signal-box";
    signalCol.appendChild(signalBox);

    const signalPanel = document.createElement("div");
    signalPanel.className = "panel-33 no-bg-phone signal-panel-layout";
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
    signalBox.appendChild(signalPanel);

    signalPanel.style.background = "none";
    signalPanel.style.border = "none";
    signalPanel.style.boxShadow = "none";
    signalPanel.style.margin = "0";
    signalPanel.style.padding = "0";
    signalPanel.style.height = "100%";
    signalPanel.style.display = "flex";
    signalPanel.style.flexDirection = "column";
    signalPanel.style.justifyContent = "center";
    signalPanel.style.alignItems = "flex-start";

    try {
      if (window.MetricsMonitor?.onSignalUnitChange) {
        window.MetricsMonitor.onSignalUnitChange((unit) => {
          signalBox.querySelectorAll(".signal-units").forEach((el) => (el.textContent = String(unit || "").toLowerCase()));
        });
        if (window.MetricsMonitor.getSignalUnit) {
          const u = window.MetricsMonitor.getSignalUnit();
          if (u) signalBox.querySelectorAll(".signal-units").forEach((el) => (el.textContent = String(u).toLowerCase()));
        }
      }
    } catch (e) {}

    const analyzerHost = document.createElement("div");
    analyzerHost.id = "main-signal-analyzer-container";
    flex.appendChild(analyzerHost);

    // Initialization logic
    const applyCanvasSizingAndRemoveInnerBorder = () => {
      const container = document.getElementById("main-signal-analyzer-container");
      const canvas = container ? container.querySelector('canvas[data-mm-signal-analyzer-canvas], canvas') : null;
      if (!canvas || !container) return;
      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      try {
        if (typeof Chart !== "undefined" && typeof Chart.getChart === "function") {
          const ch = Chart.getChart(canvas);
          if (ch?.options?.scales) {
            ["x", "y"].forEach((ax) => {
              const s = ch.options.scales[ax];
              if (!s) return;
              s.border = Object.assign({}, s.border || {}, { display: false });
              if (s.grid) s.grid.drawBorder = false;
              if (s.grid) { s.grid.borderColor = "rgba(0,0,0,0)"; s.grid.borderWidth = 0; }
            });
            ch.update("none");
          }
        }
      } catch (e) {}
    };

    const tryInit = (attempt = 0) => {
      const analyzer = window.MetricsSignalAnalyzer;
      if (!analyzer || typeof analyzer.init !== "function") {
        if (attempt < 25) return setTimeout(() => tryInit(attempt + 1), 200);
        return;
      }
      let canvasSigAnalyzerInstance = null;
      if (typeof analyzer.createInstance === "function") {
        canvasSigAnalyzerInstance = analyzer.createInstance({
          containerId: "main-signal-analyzer-container",
          instanceKey: "canvas4",
          embedded: true,
          useLegacyCss: false,
          hideValueAndUnit: true
        });
      } else {
        analyzer.init("main-signal-analyzer-container");
      }
      if (window.MetricsSignalMeter && typeof window.MetricsSignalMeter.startDataListener === "function") {
        window.MetricsSignalMeter.startDataListener();
      }
      setTimeout(() => {
        applyCanvasSizingAndRemoveInnerBorder();
        (canvasSigAnalyzerInstance?.redraw || analyzer.redraw)?.(true);
      }, 0);
      window.addEventListener("resize", () => {
        (canvasSigAnalyzerInstance?.resize || analyzer.resize)?.();
        setTimeout(() => {
          applyCanvasSizingAndRemoveInnerBorder();
          (canvasSigAnalyzerInstance?.redraw || analyzer.redraw)?.(true);
        }, 0);
      });
    };
    tryInit();
  }

// =========================================================
// CANVAS_SEQUENCE = 2: MPX Combo (Meters Left / Analyzer Right)
// =========================================================
  function replaceMainCanvasWithMpxComboIfRequired() {
    if (!Array.isArray(CONFIG.CANVAS_SEQUENCE) || !CONFIG.CANVAS_SEQUENCE.some(v => Number(v) === 2)) return;

    const canvasContainer = document.querySelector(".canvas-container.hide-phone");
    if (!canvasContainer) return;

    const comboId = "mm-mpx-combo-flex";
    let flex = document.getElementById(comboId);

    // DOM Creation logic (First Run Only)
    if (!flex) {
        mmLog("log", "[MM-DEBUG] Creating MPX Combo Layout (Static Scale)...");

        // Fixed Internal Height
        const INTERNAL_HEIGHT = 160; 
        const METERS_COL_W = 180;

        const CUSTOM_CSS = `
          /* MAIN CONTAINER SETUP */
          #mm-mpx-combo-flex {
            display: none;
            align-items: stretch;
            width: 100%;
            height: ${INTERNAL_HEIGHT}px !important;
            min-height: ${INTERNAL_HEIGHT}px !important;
            background: linear-gradient(180deg, #071c33 0%, #041425 100%);
            border: 1px solid rgba(255,255,255,0.45);
            box-sizing: border-box;
            transform-origin: top center;
            position: relative;
            z-index: 5;
            overflow: hidden;

            /* Static Transform: 10px right, 10px up */
            transform: translate(10px, -10px);
            margin-bottom: -20px; 
          }
          
          /* COLUMN FOR THE 3 METERS */
          #mm-combo-meters-col { 
            width: ${METERS_COL_W}px; 
            min-width: ${METERS_COL_W}px; 
            flex: 0 0 ${METERS_COL_W}px;
            top: 0px; 
            display: flex; 
            flex-direction: row; 
            justify-content: space-evenly; 
            align-items: stretch; 
            padding: 10px 2px 2px 2px; 
            box-sizing: border-box; 
            border-right: 1px solid rgba(255,255,255,0.1); 
            position: relative; 
            z-index: 5; 
            height: 100%;
          }

          /* ANALYZER RIGHT */
          #mm-combo-analyzer-col { 
            flex: 1 1 auto; 
            min-width: 0;
            height: 100%; 
            position: relative; 
            overflow: hidden; 
            padding: 0; 
            margin: 0; 
            z-index: 10; 
            display: flex;
            flex-direction: column;
          }

          #mm-combo-analyzer-container { 
            width: 100% !important; 
            height: 100% !important; 
            flex: 1;
            border: none !important; 
            margin: 0 !important; 
            padding: 0 !important; 
            box-shadow: none !important; 
            overflow: hidden !important; 
            position: relative;
          }

          #mm-combo-analyzer-container canvas { 
            width: 100% !important; 
            height: 100% !important; 
            border: none !important; 
            outline: none !important; 
            display: block !important; 
          }

          /* METER DESIGN (Minimal) */
          #mm-combo-meters-col .level-meter { margin: -5px 1px; height: 100%; display: flex; flex-direction: column; justify-content: flex-start; position: relative; flex: 1; overflow: visible !important; }
          #mm-combo-meters-col .meter-top { display: flex !important; flex-direction: row !important; width: 100%; height: 100%; position: relative; }
          #mm-combo-meters-col .meter-scale { display: flex !important; flex-direction: column; justify-content: space-between; width: 30px !important; min-width: 30px !important; text-align: right !important; margin-top: 0px !important; margin-right: -7px !important; padding-bottom: 5px; font-size: 12px !important; line-height: 1 !important; color: rgba(255,255,255,0.7); z-index: 2; transform: scale(0.75); transform-origin: top; }
          #mm-combo-meters-col .meter-wrapper { flex: 1; width: 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; position: relative; }
          #mm-combo-meters-col .level-meter canvas { display: block !important; visibility: visible !important; width: 100% !important; max-width: 30px !important; height: auto !important; flex: 1 1 auto !important; margin-bottom: 0px !important; } 
          #mm-combo-meters-col .label { display: block !important; opacity: 1 !important; visibility: visible !important; pointer-events: none !important; margin-top: 5px !important; line-height: 1.0 !important; font-size: 10px !important; }
          #mm-combo-meters-col .meter-bar .segment { border-bottom: 1px solid transparent !important; background-clip: padding-box !important; margin-bottom: 0 !important; box-sizing: border-box; }

          /* HIDE UNUSED */
          #mm-combo-meters-inner .stereo-group, #mm-combo-meters-inner #left-meter-wrapper, #mm-combo-meters-inner #right-meter-wrapper, #mm-combo-meters-inner #hf-meter-wrapper, #mm-combo-meters-inner #eqHintWrapper, #mm-combo-meters-inner #eqHintText { display: none !important; }
          #mm-mpx-combo-flex #volumeSlider, #mm-mpx-combo-flex [id*="volume"], #mm-mpx-combo-flex [class*="volume"] { display: none !important; }
        `;

        let style = document.getElementById("metrics-mpx-combo-css");
        if (!style) {
          style = document.createElement("style");
          style.id = "metrics-mpx-combo-css";
          document.head.appendChild(style);
        }
        style.textContent = CUSTOM_CSS;

        flex = document.createElement("div");
        flex.id = comboId;
        flex.style.display = "none";
        canvasContainer.appendChild(flex);

        // --- DOM Structure ---
        const leftCol = document.createElement("div");
        leftCol.id = "mm-combo-meters-col";
        flex.appendChild(leftCol);

        const metersContainer = document.createElement("div");
        metersContainer.id = "mm-combo-meters-inner";
        metersContainer.style.display = "flex";
        metersContainer.style.width = "100%";
        metersContainer.style.height = "100%";
        metersContainer.style.justifyContent = "space-around";
        leftCol.appendChild(metersContainer);

        const rightCol = document.createElement("div");
        rightCol.id = "mm-combo-analyzer-col";
        flex.appendChild(rightCol);

        const analyzerContainer = document.createElement("div");
        analyzerContainer.id = "mm-combo-analyzer-container";
        rightCol.appendChild(analyzerContainer);
        
        // --- Meters Init (Structure only) ---
        if (window.MetricsMeters && window.MetricsMeters.initMeters) {
          setTimeout(() => {
            window.MetricsMeters.initMeters(metersContainer);
            if (window.MetricsMeters.startAnimation) window.MetricsMeters.startAnimation(); 

            const COMBO_PREFIX = "mm-combo-";
            const idsToPrefix = ["left-meter", "right-meter", "hf-meter", "stereo-pilot-meter", "rds-meter", "mpx-meter"];
            
            idsToPrefix.forEach((id) => {
              const el = metersContainer.querySelector(`#${id}`);
              if (el) {
                 el.id = COMBO_PREFIX + id;
                 const wrapper = el.closest(".level-meter");
                 if (wrapper) wrapper.id = id + "-wrapper";
                 if (el.width === 0) el.width = 40;
                 if (el.height === 0) el.height = 200;
              }
            });
          }, 250);
        }
    }

    // --- VISIBILITY & LOGIC INIT (Runs on Toggle) ---
    // If the canvas should be visible, show it and re-init the Analyzer
    if (isCanvasVisible && activeCanvasMode === 2) {
      flex.style.display = 'flex';
      
      if (window.MetricsAnalyzer && typeof window.MetricsAnalyzer.init === "function") {
          // Force layout reflow before initializing
          // This ensures the container has dimensions when init() calls resize()
          void flex.offsetWidth; 

          window.MetricsAnalyzer.init("mm-combo-analyzer-container", {
            instanceKey: "combo-main",
            embedded: true,
            useLegacyCss: false
          });

          // Extra safety resize after initialization
          setTimeout(() => {
            if (window.MetricsAnalyzer.resize) {
                window.MetricsAnalyzer.resize("mm-combo-analyzer-container");
            }
          }, 50);
      }
    }
  }
  
  function autoEnableSpectrumWhenReady() {
    if (!EnableSpectrumOnLoad) return;

    mmLog('log', 'AutoEnableSpectrum: Start searching for button...');

    let attempts = 0;
    const MAX_ATTEMPTS = 60; // 30 seconds (60 * 500ms)

    const interval = setInterval(() => {
      attempts++;
      const btn = document.getElementById("spectrum-graph-button");
      
      const shouldLog = (attempts === 1 || attempts % 5 === 0);

      if (!btn) {
        if (shouldLog) mmLog('log', `AutoEnableSpectrum: Button not found yet (Attempt ${attempts}/${MAX_ATTEMPTS})`);
      } else {
        // Button found. Check if already active.
        const isActive = btn.classList.contains("active") || btn.classList.contains("bg-color-4");

        if (isActive) {
           mmLog('log', `AutoEnableSpectrum: SUCCESS! Button is active. (Attempt ${attempts})`);
           clearInterval(interval);
           return;
        } else {
           // Button exists but inactive. Click it.
           // Note: Do NOT clear interval. Retry in next cycle if listener was missing.
           mmLog('log', `AutoEnableSpectrum: Button found (inactive). Sending CLICK... (Attempt ${attempts})`);
           btn.click();
        }
      }

      if (attempts >= MAX_ATTEMPTS) {
        mmLog('warn', 'AutoEnableSpectrum: Timeout! Button was not activated or not found.');
        clearInterval(interval);
      }
    }, 500);
  }
  
// =========================================================
// MPX DATA SOCKET DISPATCH
// =========================================================
(function installMpxDataListener() {

  if (window.MetricsMonitor._mpxListenerInstalled) return;
  window.MetricsMonitor._mpxListenerInstalled = true;

  // Shared state (used by meters)
  window.mpxPeakVal = 0;
  window.pilotPeakVal = 0;
  window.rdsPeakVal = 0;
  window.noiseFloorVal = 0;
  window.websocketRdsActive = false;

  window.mpxDevPeakRawKHz = 0;
  window.mpxDevPpmKHz = 0;
  window.modPower_dBr = null;
  window.devExceedPct = 0;

  if (!window.dataPluginsWsPromise) {
    mmLog("warn", "MPX listener: dataPluginsWsPromise not found");
    return;
  }

  window.dataPluginsWsPromise.then((ws) => {
    if (!ws) {
      mmLog("error", "MPX listener: dataPluginsWs missing");
      return;
    }

    ws.addEventListener("message", (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }

      if (!msg || msg.type !== "MPX") return;

      // ---------------------------------------------------
      // CRITICAL: Receive deviation in kHz from server
      // ---------------------------------------------------
      if (typeof msg.peak === "number") {
        mpxPeakVal = msg.peak; 
      }

      // ---------------------------------------------------
      // ITU / BS.412 metrics
      // ---------------------------------------------------
      if (typeof msg.devPeakRawKHz === "number") {
        mpxDevPeakRawKHz = msg.devPeakRawKHz;
      }
      if (typeof msg.devPpmKHz === "number") {
        mpxDevPpmKHz = msg.devPpmKHz;
      }
      if (typeof msg.modPower_dBr === "number") {
        modPower_dBr = msg.modPower_dBr;
      }
      if (typeof msg.devExceedPct === "number") {
        devExceedPct = msg.devExceedPct;
      }

      // ---------------------------------------------------
      // Pilot / RDS / Noise
      // ---------------------------------------------------
      pilotPeakVal  = msg.pilot || 0;
      rdsPeakVal    = msg.rds   || 0;
      noiseFloorVal = msg.noise || noiseFloorVal;

      websocketRdsActive = true;

      // ---------------------------------------------------
      // Trigger meter update
      // ---------------------------------------------------
      if (typeof updateMpxTotalFromSpectrum === "function") {
        updateMpxTotalFromSpectrum();
      }
    });

    mmLog("log", "MPX data listener installed");
  });
})();

// =========================================================
// SPECTRUM GRAPH BUTTON FIX
// =========================================================
(function fixSpectrumButtons() {
    // CSS to force buttons to the top z-index when graph is active
    const fixCss = `
        /* Force higher z-index for Spectrum Graph buttons */
        #sdr-graph-button-container .rectangular-spectrum-button,
        #sdr-graph-button-container button {
            z-index: 9999 !important; /* Top layer */
        }
        
        /* If graph is in overlay mode (negative margins), adjust container */
        
        /* Specific fix for overlay position */
        .canvas-container[style*="visible"] #sdr-graph-button-container {
             top: 10px !important; 
             position: absolute !important;
             width: 100%;
             pointer-events: none; /* Allow clicks through, except on buttons */
        }

        .canvas-container[style*="visible"] #sdr-graph-button-container button {
             pointer-events: auto; /* Make buttons clickable again */
        }
    `;

    const style = document.createElement('style');
    style.id = "mm-spectrum-fix-css";
    style.textContent = fixCss;
    document.head.appendChild(style);

    // Observer to check if Spectrum Plugin is active and needs class adjustment
    const observer = new MutationObserver(() => {
        const sdrGraph = document.getElementById('sdr-graph');
        const btnContainer = document.getElementById('sdr-graph-button-container');
        
        if (sdrGraph && sdrGraph.style.display !== 'none' && btnContainer) {
            // Ensure container is visible and has correct z-index when graph shows
            btnContainer.style.zIndex = "8";
            btnContainer.style.display = "block";
        }
    });

    // Observe body for spectrum plugin element insertion
    observer.observe(document.body, { childList: true, subtree: true });
})();

})();