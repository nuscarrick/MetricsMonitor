//////////////////////////////////////////////////////////////////
//                                                              //
//  METRICSMONITOR SERVER SCRIPT FOR FM-DX-WEBSERVER  (V2.4)    //
//                                                              //
//  by Highpoint                     last update: 23.02.2026    //
//                                                              //
//  Thanks for support by                                       //
//  Jeroen Platenkamp, Bkram, Wötkylä, AmateurAudioDude         //
//  GOR and Bojcha                                              //
//                                                              //
//  https://github.com/Highpoint2000/metricsmonitor             //
//                                                              //
//////////////////////////////////////////////////////////////////

// ====================================================================================
//  DEBUG CONFIGURATION
//  Set to 'true' to enable detailed logging of MPX/RDS/SNR values to the console.
//  This is useful for calibrating the input levels or debugging signal issues.
// ====================================================================================
let ENABLE_EXTENDED_LOGGING = false;

// ====================================================================================
//  MODULE IMPORTS
//  We need these built-in Node.js modules and external dependencies to function.
// ====================================================================================
const { spawn, execSync } = require("child_process");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const dgram = require("dgram"); // NEW: Required for UDP communication

// Import core server utilities for logging and configuration
// These paths assume the standard file structure of the FM-DX-Webserver
const { logInfo, logError, logWarn } = require("./../../server/console");
const mainConfig = require("./../../config.json");

// ====================================================================================
//  PLUGIN CONFIGURATION MANAGEMENT
//  Handles loading, validating, and normalizing the 'metricsmonitor.json' config file.
// ====================================================================================

// Path to the configuration file
const configFilePath = path.join(
  __dirname,
  "./../../plugins_configs/metricsmonitor.json"
);

/**
 * DEFAULT CONFIGURATION OBJECT
 * These values are used if the config file is missing or specific keys are undefined.
 * The order here reflects the user's requested JSON structure.
 */
const defaultConfig = {
  // 1. Audio & MPX Hardware Settings
  sampleRate: 48000,            // The sample rate for capture (Hz)
  MPXmode: "off",               // Mode switch (off/auto/on)
  MPXChannel: "auto",           // Channel selection (auto/left/right)
  MPXStereoDecoder: "off",      // Internal stereo decoder switch
  MPXInputCard: "",             // Input device name (if empty, uses config.json device)
  MPXTiltCalibration: 0.0,      // Tilt Correction in microseconds (0 = off)
  VisualDelayMs: 250,           // Delay for visual synchronization in ms

  // 2. Calibration Offsets (Meters)
  MeterInputCalibration: 0.0,
  MeterPilotCalibration: 0.0,
  MeterMPXCalibration: 0.0,
  MeterRDSCalibration: 0.0,

  // 3. Meter Scales 
  MeterPilotScale: 400.0,       // Default factor for Pilot
  MeterMPXScale: 100.0,         // Default factor for MPX 
  MeterRDSScale: 750.0,         // Default factor for RDS

  // 4. FFT / Spectrum Settings
  fftSize: 512,                 // FFT Window size (resolution)
  
  // 5. Spectrum Visuals
  SpectrumInputCalibration: 0,  // Input Gain Calibration in dB (applies to SPECTRUM only)
  SpectrumAttackLevel: 3,       // Smoothing attack
  SpectrumDecayLevel: 15,       // Smoothing decay
  SpectrumSendInterval: 30,     // WebSocket update rate (approx 30fps)
  "Spectrum-Y-Offset": -40,     // Y-Axis offset for the visual curve
  "Spectrum-Y-Dynamics": 2,     // Dynamic range scaling for the visual curve

  // 6. Meter Gains
  StereoBoost: 2,               // Multiplier for L/R stereo meters
  AudioMeterBoost: 1.0,         // Multiplier for 5-Band audiometer

  // 7. Layout & UI
  MODULE_SEQUENCE: "1,2,5,0,3,4", // Order of UI modules
  CANVAS_SEQUENCE: "2,5,4",       // Order of Canvas elements
  LockVolumeSlider: true,         // Lock the main volume slider in UI
  EnableSpectrumOnLoad: false,    // Start spectrum automatically
  EnableAnalyzerAdminMode: false, // Enable Admin/Debug features in Analyzer

  // 8. Colors & Peaks
  MeterColorSafe: "rgb(0, 255, 0)",     // RGB Array (Green)
  MeterColorWarning: "rgb(255, 255,0)", // RGB Array (Yellow)
  MeterColorDanger: "rgb(255, 0, 0)",   // RGB Array (Red)
  PeakMode: "dynamic",                  // "dynamic" or "fixed"
  PeakColorFixed: "rgb(251, 174, 38)"   // RGB Color for fixed peak
};

/**
 * NORMALIZE PLUGIN CONFIGURATION
 * Ensures that the loaded JSON object contains all necessary keys.
 * Migrates old/deprecated keys to new names if found.
 */
function normalizePluginConfig(json) {
  // 1. Migration: Rename minSendIntervalMs -> SpectrumSendInterval
  if (typeof json.minSendIntervalMs !== "undefined" && typeof json.SpectrumSendInterval === "undefined") {
    json.SpectrumSendInterval = json.minSendIntervalMs;
    delete json.minSendIntervalMs;
  }
  
  // 2. Migration: Rename Curve-Y-Offset -> Spectrum-Y-Offset
  if (typeof json["Curve-Y-Offset"] !== "undefined" && typeof json["Spectrum-Y-Offset"] === "undefined") {
    json["Spectrum-Y-Offset"] = json["Curve-Y-Offset"];
    delete json["Curve-Y-Offset"];
  }

  // 3. Migration: Rename Curve-Y-Dynamics -> Spectrum-Y-Dynamics
  if (typeof json["Curve-Y-Dynamics"] !== "undefined" && typeof json["Spectrum-Y-Dynamics"] === "undefined") {
    json["Spectrum-Y-Dynamics"] = json["Curve-Y-Dynamics"];
    delete json["Curve-Y-Dynamics"];
  }

  // 4. Migration: Rename stereoBoost -> StereoBoost
  if (typeof json.stereoBoost !== "undefined" && typeof json.StereoBoost === "undefined") {
    json.StereoBoost = json.stereoBoost;
    delete json.stereoBoost;
  }

  // 5. Migration: Rename eqBoost / EqBoost -> AudioMeterBoost
  if (typeof json.AudioMeterBoost === "undefined") {
    if (typeof json.eqBoost !== "undefined") {
      json.AudioMeterBoost = json.eqBoost;
      delete json.eqBoost;
    } else if (typeof json.EqBoost !== "undefined") {
      json.AudioMeterBoost = json.EqBoost;
      delete json.EqBoost;
    }
  }

  // 6. Migration: ExtStereoDecoder -> MPXStereoDecoder
  if (typeof json.ExtStereoDecoder !== "undefined" && typeof json.MPXStereoDecoder === "undefined") {
    json.MPXStereoDecoder = json.ExtStereoDecoder;
    delete json.ExtStereoDecoder; 
  }

  // 7. Migration: MPXinputCalibration/MPXboost -> MeterInputCalibration
  if (typeof json.MeterInputCalibration === "undefined") {
    if (typeof json.MPXinputCalibration !== "undefined") {
        json.MeterInputCalibration = json.MPXinputCalibration;
        delete json.MPXinputCalibration;
    } else if (typeof json.MPXboost !== "undefined") {
        json.MeterInputCalibration = json.MPXboost;
        delete json.MPXboost;
    }
  }

  // 8. Migration: pilotCalibration -> MeterPilotCalibration
  if (typeof json.pilotCalibration !== "undefined" && typeof json.MeterPilotCalibration === "undefined") {
    json.MeterPilotCalibration = json.pilotCalibration;
    delete json.pilotCalibration;
  }

  // 9. Migration: mpxCalibration -> MeterMPXCalibration
  if (typeof json.mpxCalibration !== "undefined" && typeof json.MeterMPXCalibration === "undefined") {
    json.MeterMPXCalibration = json.mpxCalibration;
    delete json.mpxCalibration;
  }

  // 10. Migration: rdsCalibration -> MeterRDSCalibration
  if (typeof json.rdsCalibration !== "undefined" && typeof json.MeterRDSCalibration === "undefined") {
    json.MeterRDSCalibration = json.rdsCalibration;
    delete json.rdsCalibration;
  }
  
  // 11. Migration: CurveInputCalibration -> SpectrumInputCalibration
  if (typeof json.CurveInputCalibration !== "undefined" && typeof json.SpectrumInputCalibration === "undefined") {
    json.SpectrumInputCalibration = json.CurveInputCalibration;
    delete json.CurveInputCalibration;
  }
  
  // Cleanup: Remove unused keys
  if (typeof json.SpectrumAverageLevel !== "undefined") delete json.SpectrumAverageLevel;
  if (typeof json.DevLimitKHz !== "undefined") delete json.DevLimitKHz;
  if (typeof json.DevRefKHz !== "undefined") delete json.DevRefKHz;
  if (typeof json.DevUncKHz !== "undefined") delete json.DevUncKHz;
  if (typeof json.DevScaleKHzPerAmp !== "undefined") delete json.DevScaleKHzPerAmp;
  if (typeof json.MeterMonoScale !== "undefined") delete json.MeterMonoScale;
  if (typeof json.MeterStereoScale !== "undefined") delete json.MeterStereoScale;
  if (typeof json.fftLibrary !== "undefined") delete json.fftLibrary;
  if (typeof json.MeterStereoCalibration !== "undefined") delete json.MeterStereoCalibration;

  // Apply Defaults for missing keys
  const result = {

    sampleRate: typeof json.sampleRate !== "undefined" ? json.sampleRate : defaultConfig.sampleRate,
    MPXmode: typeof json.MPXmode !== "undefined" ? json.MPXmode : defaultConfig.MPXmode,
    MPXChannel: typeof json.MPXChannel !== "undefined" ? json.MPXChannel : defaultConfig.MPXChannel,
    MPXStereoDecoder: typeof json.MPXStereoDecoder !== "undefined" ? json.MPXStereoDecoder : defaultConfig.MPXStereoDecoder,
    MPXInputCard: typeof json.MPXInputCard !== "undefined" ? json.MPXInputCard : defaultConfig.MPXInputCard,
    MPXTiltCalibration: typeof json.MPXTiltCalibration !== "undefined" ? json.MPXTiltCalibration : defaultConfig.MPXTiltCalibration,
    VisualDelayMs: typeof json.VisualDelayMs !== "undefined" ? json.VisualDelayMs : defaultConfig.VisualDelayMs,

    MeterInputCalibration: typeof json.MeterInputCalibration !== "undefined" ? json.MeterInputCalibration : defaultConfig.MeterInputCalibration,
    MeterPilotCalibration: typeof json.MeterPilotCalibration !== "undefined" ? json.MeterPilotCalibration : defaultConfig.MeterPilotCalibration,
    MeterMPXCalibration: typeof json.MeterMPXCalibration !== "undefined" ? json.MeterMPXCalibration : defaultConfig.MeterMPXCalibration,
    MeterRDSCalibration: typeof json.MeterRDSCalibration !== "undefined" ? json.MeterRDSCalibration : defaultConfig.MeterRDSCalibration,

    MeterPilotScale: typeof json.MeterPilotScale !== "undefined" ? json.MeterPilotScale : defaultConfig.MeterPilotScale,
    MeterMPXScale: typeof json.MeterMPXScale !== "undefined" ? json.MeterMPXScale : defaultConfig.MeterMPXScale,
    MeterRDSScale: typeof json.MeterRDSScale !== "undefined" ? json.MeterRDSScale : defaultConfig.MeterRDSScale,

    fftSize: typeof json.fftSize !== "undefined" ? json.fftSize : defaultConfig.fftSize,
    
    SpectrumInputCalibration: typeof json.SpectrumInputCalibration !== "undefined" ? json.SpectrumInputCalibration : defaultConfig.SpectrumInputCalibration,
    SpectrumAttackLevel: typeof json.SpectrumAttackLevel !== "undefined" ? json.SpectrumAttackLevel : defaultConfig.SpectrumAttackLevel,
    SpectrumDecayLevel: typeof json.SpectrumDecayLevel !== "undefined" ? json.SpectrumDecayLevel : defaultConfig.SpectrumDecayLevel,
    SpectrumSendInterval: typeof json.SpectrumSendInterval !== "undefined" ? json.SpectrumSendInterval : defaultConfig.SpectrumSendInterval,
    "Spectrum-Y-Offset": typeof json["Spectrum-Y-Offset"] !== "undefined" ? json["Spectrum-Y-Offset"] : defaultConfig["Spectrum-Y-Offset"],
    "Spectrum-Y-Dynamics": typeof json["Spectrum-Y-Dynamics"] !== "undefined" ? json["Spectrum-Y-Dynamics"] : defaultConfig["Spectrum-Y-Dynamics"],
    
    StereoBoost: typeof json.StereoBoost !== "undefined" ? json.StereoBoost : defaultConfig.StereoBoost,
    AudioMeterBoost: typeof json.AudioMeterBoost !== "undefined" ? json.AudioMeterBoost : defaultConfig.AudioMeterBoost,
    
    MODULE_SEQUENCE: typeof json.MODULE_SEQUENCE !== "undefined" ? json.MODULE_SEQUENCE : defaultConfig.MODULE_SEQUENCE,
    CANVAS_SEQUENCE: typeof json.CANVAS_SEQUENCE !== "undefined" ? json.CANVAS_SEQUENCE : defaultConfig.CANVAS_SEQUENCE,
    LockVolumeSlider: typeof json.LockVolumeSlider !== "undefined" ? json.LockVolumeSlider : defaultConfig.LockVolumeSlider,
    EnableSpectrumOnLoad: typeof json.EnableSpectrumOnLoad !== "undefined" ? json.EnableSpectrumOnLoad : defaultConfig.EnableSpectrumOnLoad,
    EnableAnalyzerAdminMode: typeof json.EnableAnalyzerAdminMode !== "undefined" ? json.EnableAnalyzerAdminMode : defaultConfig.EnableAnalyzerAdminMode,
    
    MeterColorSafe: typeof json.MeterColorSafe !== "undefined" ? json.MeterColorSafe : defaultConfig.MeterColorSafe,
    MeterColorWarning: typeof json.MeterColorWarning !== "undefined" ? json.MeterColorWarning : defaultConfig.MeterColorWarning,
    MeterColorDanger: typeof json.MeterColorDanger !== "undefined" ? json.MeterColorDanger : defaultConfig.MeterColorDanger,
    PeakMode: typeof json.PeakMode !== "undefined" ? json.PeakMode : defaultConfig.PeakMode,
    PeakColorFixed: typeof json.PeakColorFixed !== "undefined" ? json.PeakColorFixed : defaultConfig.PeakColorFixed,
  };

  // Preserve any extra custom keys
  for (const key of Object.keys(json)) {
    if (!(key in result)) {
      result[key] = json[key];
    }
  }

  return result;
}

/**
 * LOAD OR CREATE CONFIG FILE
 * Reads the JSON file. If missing or corrupt, creates a new one with defaults.
 * Also handles creating a .bak backup before overwriting.
 * 
 * @param {string} filePath - Absolute path to the config file
 * @returns {Object} - The usable configuration object
 */
function loadConfig(filePath) {
  const dir = path.dirname(filePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf8").trim();

      if (raw.length === 0) {
        throw new Error("Empty JSON file");
      }

      let json = JSON.parse(raw);

      if (!json || Object.keys(json).length === 0) {
        throw new Error("Empty JSON object");
      }

      // Normalize
      json = normalizePluginConfig(json);
      
      // CREATE BACKUP BEFORE OVERWRITING
      try {
        const backupPath = filePath + ".bak";
        fs.copyFileSync(filePath, backupPath);
      } catch (backupErr) {
        logWarn(`[MPX] Failed to create config backup: ${backupErr.message}`);
      }

      // Write back with new order/keys
      fs.writeFileSync(filePath, JSON.stringify(json, null, 2), "utf8");

      return json;
    } catch (err) {
      logError("[MPX CONFIG ERROR] Raw Content was:", fs.readFileSync(filePath, "utf8")); // Shows the content causing the error
      logWarn(
        "[MPX] metricsmonitor.json invalid ? rewriting with defaults:",
        err.message
      );
      // Backup defaults
      fs.writeFileSync(
        filePath,
        JSON.stringify(defaultConfig, null, 2),
        "utf8"
      );
      return defaultConfig;
    }
  }

  // File does not exist, create it
  logWarn(
    "[MPX] metricsmonitor.json not found ? creating new file with defaults."
  );
  fs.writeFileSync(filePath, JSON.stringify(defaultConfig, null, 2), "utf8");
  return defaultConfig;
}

// ====================================================================================
//  CONFIGURATION VALUES & APPLICATION
//  Declare variables that will hold config values and a function to update them.
// ====================================================================================

let configPlugin;

// Sequences
let MODULE_SEQUENCE;
let CANVAS_SEQUENCE;

// Sample Rate
let ANALYZER_SAMPLE_RATE;
let CONFIG_SAMPLE_RATE;

// Audio processing parameters
let STEREO_BOOST;
let AUDIO_METER_BOOST;
let FFT_SIZE;
let SPECTRUM_SEND_INTERVAL;

// Calibration (dB to Linear)
let METER_INPUT_CALIBRATION_DB;
let METER_GAIN_FACTOR;
let SPECTRUM_INPUT_CALIBRATION_DB;
let SPECTRUM_GAIN_FACTOR;

// Visual settings
let SPECTRUM_ATTACK_LEVEL;
let SPECTRUM_DECAY_LEVEL;
let MPX_MODE;
let MPX_CHANNEL;
let MPX_STEREO_DECODER;
let MPX_INPUT_CARD;
let LOCK_VOLUME_SLIDER;
let ENABLE_SPECTRUM_ON_LOAD;
let ENABLE_ANALYZER_ADMIN_MODE;
let MPX_TILT_CALIBRATION;
let VISUAL_DELAY_MS; // NEW

// Calibrations
let METER_PILOT_CALIBRATION;
let METER_MPX_CALIBRATION;
let METER_RDS_CALIBRATION;

// Meter Scales
let METER_PILOT_SCALE;
let METER_RDS_SCALE;
let METER_MONO_SCALE;
let METER_STEREO_SCALE;
let METER_MPX_SCALE;

// Curve adjustments
let SPECTRUM_Y_OFFSET;
let SPECTRUM_Y_DYNAMICS;

// Color & Peak Settings
let METER_COLOR_SAFE;
let METER_COLOR_WARNING;
let METER_COLOR_DANGER;
let PEAK_MODE;
let PEAK_COLOR_FIXED;

// Feature Toggles
let isModule2Active;
let ENABLE_MPX;
let ENABLE_ANALYZER;

/**
 * APPLY CONFIG
 * Takes a config object and updates all module-level variables.
 * @param {Object} newConfig - The configuration object to apply.
 */
function applyConfig(newConfig) {
    configPlugin = newConfig;

    // Update all variables
    MODULE_SEQUENCE = configPlugin.MODULE_SEQUENCE;
    CANVAS_SEQUENCE = configPlugin.CANVAS_SEQUENCE;
    ANALYZER_SAMPLE_RATE = Number(configPlugin.sampleRate) || 192000;
    CONFIG_SAMPLE_RATE = ANALYZER_SAMPLE_RATE;
    STEREO_BOOST = Number(configPlugin.StereoBoost) || 1.0;
    AUDIO_METER_BOOST = Number(configPlugin.AudioMeterBoost) || 1.0;
    FFT_SIZE = Number(configPlugin.fftSize) || 4096;
    SPECTRUM_SEND_INTERVAL = Number(configPlugin.SpectrumSendInterval) || 30;
    
    METER_INPUT_CALIBRATION_DB = Number(configPlugin.MeterInputCalibration) || 0;
    METER_GAIN_FACTOR = Math.pow(10, METER_INPUT_CALIBRATION_DB / 20.0);  
    MPX_TILT_CALIBRATION = Number(configPlugin.MPXTiltCalibration) || 0.0;
    VISUAL_DELAY_MS = Number(configPlugin.VisualDelayMs);
    if (isNaN(VISUAL_DELAY_MS) || VISUAL_DELAY_MS < 0) VISUAL_DELAY_MS = 250;

    SPECTRUM_INPUT_CALIBRATION_DB = Number(configPlugin.SpectrumInputCalibration) || 0;
    SPECTRUM_GAIN_FACTOR = Math.pow(10, SPECTRUM_INPUT_CALIBRATION_DB / 20.0);
    SPECTRUM_ATTACK_LEVEL = Number(configPlugin.SpectrumAttackLevel) || 3;
    SPECTRUM_DECAY_LEVEL = Number(configPlugin.SpectrumDecayLevel) || 15;
    
    MPX_MODE = String(configPlugin.MPXmode || "auto").toLowerCase();
    MPX_CHANNEL = String(configPlugin.MPXChannel || "auto").toLowerCase();
    MPX_STEREO_DECODER = String(configPlugin.MPXStereoDecoder || "off").toLowerCase();
    
    MPX_INPUT_CARD = String(configPlugin.MPXInputCard || "").replace(/^["'](.*)["']$/, "$1").trim();
    
    LOCK_VOLUME_SLIDER = configPlugin.LockVolumeSlider === true;
    ENABLE_SPECTRUM_ON_LOAD = configPlugin.EnableSpectrumOnLoad === true;
    ENABLE_ANALYZER_ADMIN_MODE = configPlugin.EnableAnalyzerAdminMode === true;
    
    METER_PILOT_CALIBRATION = Number(configPlugin.MeterPilotCalibration) || 0.0;
    METER_MPX_CALIBRATION = Number(configPlugin.MeterMPXCalibration) || 0.0;
    METER_RDS_CALIBRATION = Number(configPlugin.MeterRDSCalibration) || 0.0;
    
    // SCALES
    METER_PILOT_SCALE = Number(configPlugin.MeterPilotScale) || 400.0;
    METER_MPX_SCALE = Number(configPlugin.MeterMPXScale) || 100.0; 
    METER_RDS_SCALE = Number(configPlugin.MeterRDSScale) || 750.0;   
       
    SPECTRUM_Y_OFFSET = Number(configPlugin["Spectrum-Y-Offset"]) || -40;
    SPECTRUM_Y_DYNAMICS = Number(configPlugin["Spectrum-Y-Dynamics"]) || 2.0;
    
    METER_COLOR_SAFE = JSON.stringify(configPlugin.MeterColorSafe || "rgb(0, 255, 0)");
    METER_COLOR_WARNING = JSON.stringify(configPlugin.MeterColorWarning || "rgb(255, 255, 0)");
    METER_COLOR_DANGER = JSON.stringify(configPlugin.MeterColorDanger || "rgb(255, 0, 0)");
    PEAK_MODE = String(configPlugin.PeakMode || "dynamic");
    PEAK_COLOR_FIXED = String(configPlugin.PeakColorFixed || "rgb(251, 174, 38)");
    
    // Update feature toggles
    isModule2Active = sequenceContainsId(MODULE_SEQUENCE, 2) || sequenceContainsId(CANVAS_SEQUENCE, 2);
    ENABLE_MPX = isModule2Active; 
    ENABLE_ANALYZER = ENABLE_MPX;

    logInfo(`[MPX Config] New configuration applied. Gain: ${METER_INPUT_CALIBRATION_DB}dB | Tilt: ${MPX_TILT_CALIBRATION}us | Delay: ${VISUAL_DELAY_MS}ms | MPXChannel: ${MPX_CHANNEL}`);
}

/**
 * Reloads the config from disk and applies it.
 */
function reloadAndApplyConfig() {
    const newConfig = loadConfig(configFilePath);
    applyConfig(newConfig);
}

// ====================================================================================
//  PATH DEFINITIONS FOR CLIENT FILES
// ====================================================================================
const MetricsMonitorClientFile = path.join(__dirname, "metricsmonitor.js");
const MetricsMonitorClientAnalyzerFile = path.join(
  __dirname,
  "js/metricsmonitor-analyzer.js"
);
const MetricsMonitorClientMetersFile = path.join(
  __dirname,
  "js/metricsmonitor-meters.js"
);
const MetricsMonitorClientAudioMeterFile = path.join(
  __dirname,
  "js/metricsmonitor-audiometer.js"
);
const MetricsMonitorClientHeaderFile = path.join(
  __dirname,
  "js/metricsmonitor-header.js"
);
const MetricsMonitorClientSignalMeterFile = path.join(
  __dirname,
  "js/metricsmonitor-signalmeter.js"
);
const MetricsMonitorClientSignalAnalyzerFile = path.join(
  __dirname,
  "js/metricsmonitor-signal-analyzer.js"
);

/**
 * HELPER: sequenceContainsId
 * Checks if a module ID is present in the sequence string/array.
 */
function sequenceContainsId(seq, id) {
  let arr;
  if (Array.isArray(seq)) {
    arr = seq;
  } else {
    arr = String(seq)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
  }
  return arr.includes(id);
}

// ====================================================================================
//  SYSTEM PATCHING
//  These functions modify other server files to ensure compatibility.
// ====================================================================================

/**
 * PATCH HELPERS.JS
 * Adds an exemption for Localhost (127.0.0.1) to bypass the Anti-Spam protection.
 * This is critical because the plugin communicates via internal WebSocket on localhost.
 */
const LOCALHOST_PATCH_MARKER = "// MM_LOCALHOST_SPAM_BYPASS:";

function patchHelpersForLocalhostBypass() {
  try {
    const helpersPath = path.join(__dirname, "./../../server/helpers.js");

    if (!fs.existsSync(helpersPath)) {
      logWarn(
        "[MPX] helpers.js not found, cannot patch antispamProtection()."
      );
      return;
    }

    let content = fs.readFileSync(helpersPath, "utf8");

    if (content.includes(LOCALHOST_PATCH_MARKER)) {
      // Already patched
      return;
    }

    // Locate the function
    const fnSignature =
      "function antispamProtection(message, clientIp, ws, userCommands, lastWarn, userCommandHistory, lengthCommands, endpointName) {";
    const fnIndex = content.indexOf(fnSignature);

    if (fnIndex === -1) {
      logWarn(
        "[MPX] antispamProtection() not found in helpers.js  skipping localhost patch."
      );
      return;
    }

    // Locate start of function body
    const commandLine = "const command = message.toString();";
    const cmdIndex = content.indexOf(commandLine, fnIndex);

    if (cmdIndex === -1) {
      logWarn(
        "[MPX] 'const command = message.toString();' not found in antispamProtection()  skipping localhost patch."
      );
      return;
    }

    const insertPos = cmdIndex + commandLine.length;

    const insertion = `
  ${LOCALHOST_PATCH_MARKER} allow internal server apps on localhost
  const isLocalhost =
    clientIp === "127.0.0.1" ||
    clientIp === "::1" ||
    clientIp === "::ffff:127.0.0.1" ||
    (clientIp && clientIp.replace(/^::ffff:/, '') === "127.0.0.1");

  if (isLocalhost) {
    // no spam/bot checks for local server applications
    return command;
  }`;

    content = content.slice(0, insertPos) + insertion + content.slice(insertPos);
    fs.writeFileSync(helpersPath, content, "utf8");

    logInfo(
      "[MPX] helpers.js patched: localhost exempt in antispamProtection(). Please restart the webserver!"
    );
  } catch (err) {
    logWarn(
      `[MPX] Failed to patch helpers.js for localhost exemption: ${err.message}`
    );
  }
}

// ====================================================================================
//  CLIENT-SIDE FILE UPDATES & DEPLOYMENT
// ====================================================================================

/**
 * Injects the current server configuration directly into the client .js files.
 */
function updateSettings() {
    logInfo("[MPX Config] Injecting latest configuration into client JS files...");
    
    /**
     * Normalize sequence to JSON string for injection
     */
    function normalizeSequenceJS(seq) {
        if (Array.isArray(seq)) {
            return JSON.stringify(seq);
        }
        if (typeof seq === "string") {
            const items = seq
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map(Number);
            return JSON.stringify(items);
        }
        return "[0, 1, 2, 3, 4]";
    }

    const MODULE_SEQUENCE_JS = normalizeSequenceJS(MODULE_SEQUENCE);
    const CANVAS_SEQUENCE_JS = normalizeSequenceJS(CANVAS_SEQUENCE);

    function buildHeaderBlock() {
        // This block is injected at the top of client files
        // NOTE: Sending renamed constants to the client to match new naming convention
        return (
          `const sampleRate = ${ANALYZER_SAMPLE_RATE};    // Do not touch - this value is automatically updated via the config file\n` +
          `const MPXmode = "${MPX_MODE}";    // Do not touch - this value is automatically updated via the config file\n` +
          `const MPXStereoDecoder = "${MPX_STEREO_DECODER}";    // Do not touch - this value is automatically updated via the config file\n` +
          `const MPXInputCard = "${MPX_INPUT_CARD}";    // Do not touch - this value is automatically updated via the config file\n` +
          `const MPXTiltCalibration = ${MPX_TILT_CALIBRATION};    // Do not touch - this value is automatically updated via the config file\n` +
          `const VisualDelayMs = ${VISUAL_DELAY_MS};    // Do not touch - this value is automatically updated via the config file\n` +
          `const MeterInputCalibration = ${METER_INPUT_CALIBRATION_DB};    // Do not touch - this value is automatically updated via the config file\n` +
          `const MeterPilotCalibration = ${METER_PILOT_CALIBRATION};    // Do not touch - this value is automatically updated via the config file\n` +
          `const MeterMPXCalibration = ${METER_MPX_CALIBRATION};    // Do not touch - this value is automatically updated via the config file\n` +
          `const MeterRDSCalibration = ${METER_RDS_CALIBRATION};    // Do not touch - this value is automatically updated via the config file\n` +
          `const MeterPilotScale = ${METER_PILOT_SCALE};    // Do not touch - this value is automatically updated via the config file\n` +
          `const MeterRDSScale = ${METER_RDS_SCALE};    // Do not touch - this value is automatically updated via the config file\n` +
          `const fftSize = ${FFT_SIZE};    // Do not touch - this value is automatically updated via the config file\n` +
          `const SpectrumAttackLevel = ${SPECTRUM_ATTACK_LEVEL};    // Do not touch - this value is automatically updated via the config file\n` +
          `const SpectrumDecayLevel = ${SPECTRUM_DECAY_LEVEL};    // Do not touch - this value is automatically updated via the config file\n` +
          `const SpectrumSendInterval = ${SPECTRUM_SEND_INTERVAL};    // Do not touch - this value is automatically updated via the config file\n` +
          `const SpectrumYOffset = ${SPECTRUM_Y_OFFSET};    // Do not touch - this value is automatically updated via the config file\n` +
          `const SpectrumYDynamics = ${SPECTRUM_Y_DYNAMICS};    // Do not touch - this value is automatically updated via the config file\n` +
          `const StereoBoost = ${STEREO_BOOST};    // Do not touch - this value is automatically updated via the config file\n` +
          `const AudioMeterBoost = ${AUDIO_METER_BOOST};    // Do not touch - this value is automatically updated via the config file\n` +
          `const MODULE_SEQUENCE = ${MODULE_SEQUENCE_JS};    // Do not touch - this value is automatically updated via the config file\n` +
          `const CANVAS_SEQUENCE = ${CANVAS_SEQUENCE_JS};    // Do not touch - this value is automatically updated via the config file\n` +
          `const LockVolumeSlider = ${LOCK_VOLUME_SLIDER};    // Do not touch - this value is automatically updated via the config file\n` +
          `const EnableSpectrumOnLoad = ${ENABLE_SPECTRUM_ON_LOAD};    // Do not touch - this value is automatically updated via the config file\n` +
          `const EnableAnalyzerAdminMode = ${ENABLE_ANALYZER_ADMIN_MODE};    // Do not touch - this value is automatically updated via the config file\n` +
          `const MeterColorSafe = ${METER_COLOR_SAFE};    // Do not touch - this value is automatically updated via the config file\n` +
          `const MeterColorWarning = ${METER_COLOR_WARNING};    // Do not touch - this value is automatically updated via the config file\n` +
          `const MeterColorDanger = ${METER_COLOR_DANGER};    // Do not touch - this value is automatically updated via the config file\n` +
          `const PeakMode = "${PEAK_MODE}";    // Do not touch - this value is automatically updated via the config file\n` +
          `const PeakColorFixed = "${PEAK_COLOR_FIXED}";    // Do not touch - this value is automatically updated via the config file\n` 
        );
    }

    function removeOldConstants(code) {
        // Regex to remove existing constant definitions to prevent duplicates
        let out = code
        // Old names
        .replace(/^\s*const\s+minSendIntervalMs\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+CurveYOffset\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+CurveYDynamics\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+Curve-Y-Offset\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+Curve-Y-Dynamics\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+stereoBoost\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+eqBoost\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+EqBoost\s*=.*;[^\n]*\n?/gm, "")

        // Renamed names
        .replace(/^\s*const\s+MPXinputCalibration\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MPXboost\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MPXinputCalibrationDB\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+pilotCalibration\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+mpxCalibration\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+rdsCalibration\s*=.*;[^\n]*\n?/gm, "")

        // New names (to ensure clean update)
        .replace(/^\s*const\s+SpectrumSendInterval\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+SpectrumYOffset\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+SpectrumYDynamics\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+StereoBoost\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+AudioMeterBoost\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MeterInputCalibration\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MPXTiltCalibration\s*=.*;[^\n]*\n?/gm, "") 
        .replace(/^\s*const\s+VisualDelayMs\s*=.*;[^\n]*\n?/gm, "") // NEW
        .replace(/^\s*const\s+MeterPilotCalibration\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MeterMPXCalibration\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MeterRDSCalibration\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MeterPilotScale\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MeterMPXScale\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MeterRDSScale\s*=.*;[^\n]*\n?/gm, "")

        // Other standard constants
        .replace(/^\s*const\s+MODULE_SEQUENCE\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+CANVAS_SEQUENCE\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+sampleRate\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+fftSize\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+SpectrumAverageLevel\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+SpectrumAttackLevel\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+SpectrumDecayLevel\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MPXmode\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+ExtStereoDecoder\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MPXStereoDecoder\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MPXInputCard\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+LockVolumeSlider\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+EnableSpectrumOnLoad\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+EnableAnalyzerAdminMode\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MeterColorSafe\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MeterColorWarning\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+MeterColorDanger\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+PeakMode\s*=.*;[^\n]*\n?/gm, "")
        .replace(/^\s*const\s+PeakColorFixed\s*=.*;[^\n]*\n?/gm, "");

        out = out.replace(
        /^\s*\/\/\s*Do not touch - this value is automatically updated via the config file\s*$/gm,
        ""
        );

        return out;
    }

    function insertAfterIIFE(code) {
        const cleaned = removeOldConstants(code);
        // Find the start of the Immediately Invoked Function Expression
        const iifePattern = /(\(\s*\)\s*=>\s*\{)[ \t]*\n?/;

        if (!iifePattern.test(cleaned)) {
            return cleaned;
        }

        return cleaned.replace(
        iifePattern,
        (_, prefix) => `${prefix}\n${buildHeaderBlock()}`
        );
    }

    // ====================================================================================
    //  CLIENT PATCH: METERS DEBUG LOGGING + MPX/RDS HANDLING
    // ====================================================================================
    function patchMetersClient(code) {
        let out = code;

        // 1) Inject debug helpers once (search marker: mm_meters_debug)
        if (!out.includes("mm_meters_debug")) {
        const debugBlock = `
    // ============================
    // DEBUG LOGGING (CLIENT)  // mm_meters_debug
    // Enable:
    //   localStorage.setItem("mm_meters_debug","1");   // throttled
    //   localStorage.setItem("mm_meters_debug","all"); // EVERY WS message
    // Disable:
    //   localStorage.removeItem("mm_meters_debug");
    // Also supported: URL param ?mmMetersDebug=1
    // ============================
    const MM_METERS_DEBUG_MODE =
      (localStorage.getItem("mm_meters_debug") ||
        (typeof location !== "undefined" && /(?:\\?|&)mmMetersDebug=1\\b/.test(location.search) ? "1" : ""));

    const MM_METERS_DEBUG_ALL = (MM_METERS_DEBUG_MODE === "all");
    const MM_METERS_DEBUG_ON  = !!MM_METERS_DEBUG_MODE;

    let _mmMetersLastLogMs = 0;

    function mmMetersLog(tag, data, throttleMs = 500) {
      if (!MM_METERS_DEBUG_ON) return;
      if (!MM_METERS_DEBUG_ALL) {
        const now = Date.now();
        if ((now - _mmMetersLastLogMs) < throttleMs) return;
        _mmMetersLastLogMs = now;
      }
      try { console.log("[MM Meters] " + tag, data); } catch {}
    }
`;
        const reVals = new RegExp(
            "(let\\s+valMpx\\s*=\\s*0;\\s*\\n\\s*let\\s+valPilot\\s*=\\s*0;\\s*\\n\\s*let\\s+valRds\\s*=\\s*0;\\s*\\n)"
        );
        out = out.replace(reVals, "$1" + debugBlock + "\n");
        }

        // 2) Fix early return that kills MPX/RDS updates
        const reEarlyReturn = new RegExp(
        "^\\s*//\\s*Ignore spectrum array[^\\n]*\\n\\s*if\\s*\\(\\s*Array\\.isArray\\(message\\.value\\)\\s*\\)\\s*\\{\\s*return;\\s*\\}\\s*\\n",
        "m"
        );
        out = out.replace(
        reEarlyReturn,
        "        // NOTE: The server always sends 'value' as spectrum array alongside peak/pilotKHz/rdsKHz.\n" +
        "        // Do NOT return here. Only ignore spectrum-only packets that lack 'peak'.\n" +
        "        if (typeof message.peak !== \"number\" && Array.isArray(message.value)) { return; }\n\n"
        );

        // 3) Add detailed logging to handleMpxMessage (log complete MPX payload + extracted values)
        const reHandleHead = new RegExp(
        "(function\\s+handleMpxMessage\\s*\\(message\\)\\s*\\{\\s*\\n\\s*if\\s*\\(!message\\s*\\|\\|\\s*typeof\\s+message\\s*!==\\s*[\"']object[\"']\\)\\s*return;\\s*\\n)"
        );
        out = out.replace(
        reHandleHead,
        "$1" +
        "        try {\n" +
        "          const safe = Object.assign({}, message);\n" +
        "          if (Array.isArray(safe.value)) {\n" +
        "            safe.valueLen = safe.value.length;\n" +
        "            safe.valuePreview = safe.value.slice(0, 12);\n" +
        "            delete safe.value;\n" +
        "          }\n" +
        "          mmMetersLog(\"RX MPX (full)\", safe, 0);\n" +
        "          mmMetersLog(\"RX MPX VALUES\", {\n" +
        "            peak: message.peak,\n" +
        "            pilotKHz: message.pilotKHz,\n" +
        "            rdsKHz: message.rdsKHz,\n" +
        "            pilotRaw: message.pilot,\n" +
        "            rdsRaw: message.rds,\n" +
        "            noise: message.noise,\n" +
        "            snr: message.snr\n" +
        "          }, 0);\n" +
        "        } catch {}\n"
        );

        // 4) Expand WS onmessage logging (RAW + PARSED)
        const reWsCore = new RegExp(
        "const\\s+msg\\s*=\\s*JSON\\.parse\\(event\\.data\\);\\s*\\n\\s*//\\s*Safety:\\s*Don't process bare arrays[^\\n]*\\n\\s*if\\s*\\(Array\\.isArray\\(msg\\)\\)\\s*return;\\s*\\n\\s*\\n\\s*if\\s*\\(msg\\.type\\s*===\\s*[\"']MPX[\"']\\)\\s*handleMpxMessage\\(msg\\);",
        "m"
        );
        out = out.replace(
        reWsCore,
        "mmMetersLog(\"WS RAW\", event.data, 0);\n" +
        "          const msg = JSON.parse(event.data);\n" +
        "          if (Array.isArray(msg)) {\n" +
        "            mmMetersLog(\"WS PARSED (array)\", { len: msg.length, preview: msg.slice(0, 12) }, 0);\n" +
        "            return;\n" +
        "          }\n" +
        "          try {\n" +
        "            const safe = Object.assign({}, msg);\n" +
        "            if (Array.isArray(safe.value)) {\n" +
        "              safe.valueLen = safe.value.length;\n" +
        "              safe.valuePreview = safe.value.slice(0, 12);\n" +
        "              delete safe.value;\n" +
        "            }\n" +
        "            mmMetersLog(\"WS PARSED (object)\", safe, 0);\n" +
        "          } catch {}\n" +
        "          if (msg.type === \"MPX\") handleMpxMessage(msg);"
        );

        return out;
    }

    function updateClientFile(filePath, label, modifyFn) {
        try {
            const data = fs.readFileSync(filePath, "utf8");
            const updated = modifyFn(data);
            fs.writeFileSync(filePath, updated, "utf8");
            logInfo(`[MPX Config] Successfully updated client file: ${path.basename(filePath)}`);
        } catch (err) {
            logError(`[MPX] Error updating ${label}:`, err);
        }
    }


    // Update specific files
    updateClientFile(MetricsMonitorClientFile, "metricsmonitor.js", (code) => {
        let updated = code;
        const moduleSeqRegex = /^\s*const\s+MODULE_SEQUENCE\s*=.*;[^\n]*$/m;

        if (moduleSeqRegex.test(updated)) {
        updated = updated.replace(
            moduleSeqRegex,
            `const MODULE_SEQUENCE = ${MODULE_SEQUENCE_JS};    // Do not touch - this value is automatically updated via the config file`
        );
        } else {
        updated =
            `const MODULE_SEQUENCE = ${MODULE_SEQUENCE_JS};    // Do not touch - this value is automatically updated via the config file\n` +
            updated;
        }
        return insertAfterIIFE(updated);
    });

    updateClientFile(
        MetricsMonitorClientAnalyzerFile,
        "metricsmonitor-analyzer.js",
        insertAfterIIFE
    );
    updateClientFile(
        MetricsMonitorClientAudioMeterFile,
        "metricsmonitor-audiometer.js",
        insertAfterIIFE
    );
    updateClientFile(
        MetricsMonitorClientHeaderFile,
        "metricsmonitor-header.js",
        insertAfterIIFE
    );
    updateClientFile(
        MetricsMonitorClientMetersFile,
        "metricsmonitor-meters.js",
        (code) => patchMetersClient(insertAfterIIFE(code))
    );
    updateClientFile(
        MetricsMonitorClientSignalMeterFile,
        "metricsmonitor-signalmeter.js",
        insertAfterIIFE
    );
    updateClientFile(
        MetricsMonitorClientSignalAnalyzerFile,
        "metricsmonitor-signal-analyzer.js",
        insertAfterIIFE
    );
}

/**
 * DEPLOY ALL CLIENT FILES (for initial startup)
 * Copies all necessary client-side files (JS, CSS, images) from the plugin 
 * directory to the Webserver's public `web` folder.
 */
function copyAllClientFiles() {
  if (process.platform === "win32") {
    logInfo("[MPX] Windows detected  skipping client file copy.");
    return;
  }

  const srcDir = __dirname;
  const destDir = path.join(__dirname, "../../web/js/plugins/MetricsMonitor");

  logInfo("[MPX] Deploying all client files to web directory:", destDir);

  try {
    // Ensure the root destination directory exists
    fs.mkdirSync(destDir, { recursive: true });
    fs.chmodSync(destDir, 0o775);
  } catch (e) {
    logError("[MPX] Failed to create destination directory:", e.message);
    return;
  }

  // --- 1. Copy subdirectory content (js, css, images) ---
  const subdirectories = ["js", "css", "images"];

  subdirectories.forEach((folder) => {
    const folderSrc = path.join(srcDir, folder);
    const folderDest = path.join(destDir, folder);

    if (fs.existsSync(folderSrc)) {
      try {
        fs.mkdirSync(folderDest, { recursive: true });
        fs.chmodSync(folderDest, 0o775);
      } catch (err) {
        logError(`[MPX] Failed to create subdirectory ${folderDest}:`, err.message);
        return;
      }

      const files = fs.readdirSync(folderSrc);
      files.forEach((file) => {
        const s = path.join(folderSrc, file);
        const d = path.join(folderDest, file);
        try {
          fs.copyFileSync(s, d);
          fs.chmodSync(d, 0o664);
        } catch (err) {
          logError(`[MPX] Error copying file (${folder}/${file}):`, err.message);
        }
      });
    }
  });

  // --- 2. Copy specific root files (metricsmonitor.js) ---
  const rootFiles = ["metricsmonitor.js"];
  rootFiles.forEach((file) => {
    const s = path.join(srcDir, file);
    const d = path.join(destDir, file);
    if (fs.existsSync(s)) {
      try {
        fs.copyFileSync(s, d);
        fs.chmodSync(d, 0o664);
      } catch (err) {
        logError(`[MPX] Failed to copy root file '${file}':`, err.message);
      }
    }
  });
  logInfo("[MPX] Full client file deployment finished.");
}


/**
 * DEPLOY ONLY JS CLIENT FILES (for config updates)
 * Copies only the regenerated .js files to the web deployment directory.
 */
function copyOnlyJsFiles() {
    if (process.platform === "win32") return;

    const srcDir = __dirname;
    const destDir = path.join(__dirname, "../../web/js/plugins/MetricsMonitor");

    logInfo("[MPX] Deploying updated JavaScript files to web directory...");

    // --- 1. Copy JS subdirectory content ---
    const jsFolderSrc = path.join(srcDir, "js");
    const jsFolderDest = path.join(destDir, "js");

    if (fs.existsSync(jsFolderSrc)) {
        try {
            fs.mkdirSync(jsFolderDest, { recursive: true });
            fs.chmodSync(jsFolderDest, 0o775);
        } catch (err) {
            logError(`[MPX] Failed to create subdirectory ${jsFolderDest}:`, err.message);
            return;
        }

        const jsFiles = fs.readdirSync(jsFolderSrc).filter(f => f.endsWith('.js'));
        jsFiles.forEach((file) => {
            const s = path.join(jsFolderSrc, file);
            const d = path.join(jsFolderDest, file);
            try {
                fs.copyFileSync(s, d);
                fs.chmodSync(d, 0o664);
            } catch (err) {
                logError(`[MPX] Error copying JS file (js/${file}):`, err.message);
            }
        });
    }

    // --- 2. Copy root metricsmonitor.js file ---
    const rootJsFile = "metricsmonitor.js";
    const s = path.join(srcDir, rootJsFile);
    const d = path.join(destDir, rootJsFile);
    if (fs.existsSync(s)) {
        try {
            fs.copyFileSync(s, d);
            fs.chmodSync(d, 0o664);
        } catch (err) {
            logError(`[MPX] Failed to copy root file '${rootJsFile}':`, err.message);
        }
    }
    logInfo("[MPX] JavaScript file deployment finished.");
}

/**
 * Orchestrates the full update and deployment of client files.
 */
function updateAllClientFiles() {
    logInfo("[MPX Config] Starting initial client file update and deployment...");
    updateSettings();
    copyAllClientFiles(); // Use the full copy function here
    logInfo("[MPX Config] Initial client file deployment process finished.");
}

// ====================================================================================
//  REAL-TIME CONFIGURATION WATCHER
// ====================================================================================

let watcher = null; // Variable to hold the watcher instance
let isUpdating = false; // Flag to prevent re-triggering during an update

/**
 * Reloads configuration, updates all variables, regenerates client files,
 * and deploys ONLY the changed JS files to the web directory.
 */
function handleFileChange() {
    if (isUpdating) {
        return; // Exit if an update is already in progress
    }
    
    isUpdating = true; // Set lock
    logInfo(`[MPX Config] File change detected. Starting update process...`);

    // Temporarily stop watching to prevent loops
    if (watcher) {
        watcher.close();
    }

    setTimeout(() => {
        try {
            reloadAndApplyConfig();   // Reloads and applies server-side variables
            updateSettings();         // Rewrites client-side JS files with new config
            copyOnlyJsFiles();        // Deploys only the changed JS files
            logInfo("[MPX Config] Update process completed successfully.");
        } catch (error) {
            logError("[MPX Config] An error occurred during the update process:", error);
        } finally {
            // IMPORTANT: Re-enable the watcher after the update is complete
            setupFileWatcher();

            // Release lock after a short delay to allow file system to settle
            setTimeout(() => {
                isUpdating = false;
            }, 1000);
        }
    }, 500);
}

/**
 * Sets up a file watcher on the configuration file to enable real-time updates.
 */
function setupFileWatcher() {
    // Ensure any old watcher is closed before starting a new one
    if (watcher) {
        watcher.close();
    }
    logInfo(`[MPX Config] Setting up file watcher for: ${path.basename(configFilePath)}`);
    // Use 'fs.watch' for better cross-platform compatibility and stability
    watcher = fs.watch(configFilePath, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
            handleFileChange();
        }
    });
}

// ====================================================================================
//  INITIAL SETUP
// ====================================================================================

// 1. Initial load of the configuration
reloadAndApplyConfig();

// 2. Initial update and copy of client files
updateAllClientFiles();

// 3. Setup the file watcher for real-time updates
setupFileWatcher();

// ====================================================================================
//  MAIN SERVER LOGIC START
//  This is where the actual signal processing loop begins.
// ====================================================================================

if (!ENABLE_MPX && MPX_INPUT_CARD === ""){
  logInfo(
    `[MPX] MODULE_SEQUENCE = ${MODULE_SEQUENCE} ? ` +
    "MPX capture & server-side MPX processing are disabled."
  );
} else {

  // Apply patches
  patchHelpersForLocalhostBypass();

  let SAMPLE_RATE = CONFIG_SAMPLE_RATE;
  
  let SERVER_PORT = 8080;
  try {
    if (mainConfig?.webserver?.webserverPort) {
      SERVER_PORT = parseInt(mainConfig.webserver.webserverPort, 10);
      if (isNaN(SERVER_PORT)) SERVER_PORT = 8080;
    }
  } catch (e) {
    SERVER_PORT = 8080;
  }

  logInfo(`[MPX] Using webserver port from config.json ? ${SERVER_PORT}`);
  logInfo(
    `[MPX] sampleRate from metricsmonitor.json ? ${CONFIG_SAMPLE_RATE} Hz`
  );
  logInfo(`[MPX] FFT_SIZE from metricsmonitor.json ? ${FFT_SIZE} points`);
  logInfo(`[MPX] Analyzer enabled? ? ${ENABLE_ANALYZER}`);
  logInfo(
    `[MPX] SpectrumSendInterval from metricsmonitor.json ? ${SPECTRUM_SEND_INTERVAL} ms`
  );
  logInfo(`[MPX] MPXmode from metricsmonitor.json ? ${MPX_MODE}`);
  logInfo(`[MPX] MPXChannel from metricsmonitor.json ? ${MPX_CHANNEL}`);
  logInfo(
    `[MPX] MPXStereoDecoder from metricsmonitor.json ? ${MPX_STEREO_DECODER}`
  );
  
  // Separate Calibration Logs
  logInfo(`[MPX] MeterInputCalibration (Meters) ? ${METER_INPUT_CALIBRATION_DB} dB (Factor: ${METER_GAIN_FACTOR.toFixed(3)})`);
  logInfo(`[MPX] MPXTiltCalibration (Input Tilt) ? ${MPX_TILT_CALIBRATION.toFixed(1)} us`);
  logInfo(`[MPX] SpectrumInputCalibration (Spectrum) ? ${SPECTRUM_INPUT_CALIBRATION_DB} dB (Factor: ${SPECTRUM_GAIN_FACTOR.toFixed(3)})`);

  if (MPX_INPUT_CARD !== "") {
    logInfo(`[MPX] MPXInputCard from metricsmonitor.json ? "${MPX_INPUT_CARD}"`);
  }

  // ====================================================================================
  //  BINARY SELECTION LOGIC
  //  Selects the correct MPXCapture binary based on OS/Arch.
  // ====================================================================================
  const osPlatform = process.platform;
  const osArch = process.arch;

  let runtimeFolder = null;
  let binaryName = null;

  if (osPlatform === "win32") {
    const archEnv = process.env.PROCESSOR_ARCHITECTURE || "";
    const archWow = process.env.PROCESSOR_ARCHITEW6432 || "";
    const is64BitOS =
      archEnv.toUpperCase() === "AMD64" || archWow.toUpperCase() === "AMD64";

    runtimeFolder = is64BitOS ? "win-x64" : "win-x86";
    binaryName = "MPXCapture.exe";
  } else if (osPlatform === "linux") {
    if (osArch === "arm" || osArch === "armhf") {
      runtimeFolder = "linux-arm";
    } else if (osArch === "arm64") {
      runtimeFolder = "linux-arm64";
    } else {
      runtimeFolder = "linux-x64";
    }
    binaryName = "MPXCapture";
  } else if (osPlatform === "darwin") {
    runtimeFolder = osArch === "arm64" ? "osx-arm64" : "osx-x64";
    binaryName = "MPXCapture";
  } else {
    logError(
      `[MPX] Unsupported platform ${osPlatform}/${osArch}  MPXCapture will not be started.`
    );
  }

  let MPX_EXE_PATH = null;

  if (!runtimeFolder || !binaryName) {
    logWarn(
      "[MPX] No runtimeFolder/binaryName detected  MPXCapture disabled."
    );
  } else {
    MPX_EXE_PATH = path.join(__dirname, "bin", runtimeFolder, binaryName);
    MPX_EXE_PATH = MPX_EXE_PATH.replace(/^['\"]+|['\"]+$/g, "");

    // -----------------------------------------------------------------------
    // NEW: Check and fix execution permissions for Linux/Mac
    // -----------------------------------------------------------------------
    if (osPlatform !== "win32" && MPX_EXE_PATH && fs.existsSync(MPX_EXE_PATH)) {
        try {
            // Check if file is executable (X_OK)
            fs.accessSync(MPX_EXE_PATH, fs.constants.X_OK);
        } catch (e) {
            logInfo(`[MPX] Binary lacks execution permission. Setting 755 for: ${path.basename(MPX_EXE_PATH)}`);
            try {
                // Apply rwxr-xr-x (755)
                fs.chmodSync(MPX_EXE_PATH, 0o755);
                logInfo("[MPX] Permissions updated successfully.");
            } catch (chmodErr) {
                logError(`[MPX] Failed to set permissions for binary: ${chmodErr.message}`);
            }
        }
    }

    logInfo(
      `[MPX] Using MPXCapture binary for ${osPlatform}/${osArch} ? ${runtimeFolder}/${binaryName}`
    );
  }

  const MAX_WS_BACKLOG_BYTES = 512 * 1024;
  
  // -----------------------------------------------------------------------
  // UDP Setup for Communication with C# binary
  // (Required for UDP_CONTROL_PORT reference in startMPXCapture)
  // -----------------------------------------------------------------------
  const udpClient = dgram.createSocket("udp4");
  const UDP_CONTROL_PORT = 60001; // Port on which C# process will listen

  logInfo(
    "[MPX] MPX server started (Fast & Smooth v2.1, Peak/Pilot/RDS Time Domain, Tilt Correction, Server Visual Sync)."
  );

  // ====================================================================================
  //  WEBSOCKET SERVER
  //  Handles data distribution to clients.
  // ====================================================================================
  
  let dataPluginsWs = null;
  let reconnectTimer = null;
  let backpressureHits = 0;
  const MAX_BACKPRESSURE_HITS = 200;
  
  // Heartbeat tracking for Spectrum & Scope Calculation
  let lastSpectrumHeartbeat = 0;
  let spectrumIsActive = false;
  let lastScopeHeartbeat = 0;
  let scopeIsActive = false;
  let lastScopeState = false;
  

  function connectDataPluginsWs() {
    const url = `ws://127.0.0.1:${SERVER_PORT}/data_plugins`;

    if (
      dataPluginsWs &&
      (dataPluginsWs.readyState === WebSocket.OPEN ||
        dataPluginsWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    logInfo("[MPX] Connecting to /data_plugins:", url);

    dataPluginsWs = new WebSocket(url);
    backpressureHits = 0;

    dataPluginsWs.on("open", () => {
      logInfo("[MPX] Connected to /data_plugins WebSocket.");
      backpressureHits = 0;
    });

    dataPluginsWs.on("close", () => {
      logInfo("[MPX] /data_plugins WebSocket closed  retrying in 5 seconds.");
      dataPluginsWs = null;

      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectDataPluginsWs();
        }, 5000);
      }
    });

    dataPluginsWs.on("error", (err) => {
      logError("[MPX] /data_plugins WebSocket error:", err);
    });

    // Listen for client messages (Heartbeats from Spectrum AND Scope)
    dataPluginsWs.on("message", (raw) => {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === "MPX") {
                // Spectrum heartbeat
                if (msg.cmd === "spectrum_heartbeat") {
                    lastSpectrumHeartbeat = Date.now();
                }
                // Scope heartbeat
                if (msg.cmd === "scope_heartbeat") {
                    lastScopeHeartbeat = Date.now();
                }
            }
        } catch(e) {}
    });
  }

  connectDataPluginsWs();

  // ====================================================================================
  //  INPUT HANDLERS (Dual Mode Support)
  // ====================================================================================

  let currentPilotPeak = 0;
  let currentRdsPeak = 0;
  let currentMaxPeak = 0;
  let currentNoiseFloor = 0;
  
  let latestMpxFrame = null;   // Spectrum (s)
  let latestScopeFrame = null; // Oscilloscope (o)

  function setupJsonReader(childProcess) {
      if (!childProcess || !childProcess.stdout) return;

      const rl = readline.createInterface({ 
          input: childProcess.stdout, 
          crlfDelay: Infinity 
      });

      rl.on('line', (line) => {
          try {
              const trimmed = line.trim();
              if (!trimmed.startsWith('{')) return;
              
              const data = JSON.parse(trimmed);
              
              if (typeof data.p === 'number') currentPilotPeak = data.p;
              if (typeof data.r === 'number') currentRdsPeak = data.r;
              if (typeof data.m === 'number') currentMaxPeak = data.m;
              
              // Process Spectrum Data (s)
              if (Array.isArray(data.s)) {
                  latestMpxFrame = data.s;
              }
              
              // Process Oscilloscope Data (o)
              if (Array.isArray(data.o)) {
                  latestScopeFrame = data.o;
              }

          } catch (e) { }
      });
  }

  // ====================================================================================
  //  INPUT STARTUP (LOGIC FIXED FOR OFF/ON/AUTO)
  // ====================================================================================
  let rec = null;
  let targetDevice = "";

  /* ============================
     RECONNECT / RETRY STATE
     ============================ */
  let resetTimeout = null;
  let retryTimeout = null;
  let retryAttempts = 0;
  const RECONNECT_MAX_RETRIES = 30;
  const RECONNECT_RETRY_DELAY = 15;

  function attemptReconnect() {
      if (retryAttempts >= RECONNECT_MAX_RETRIES) {
          logError("[MPX] Maximum retry attempts reached. MPXCapture will not restart.");
          return;
      }

      retryAttempts += 1;

      logInfo(
          `[MPX] Waiting for ${RECONNECT_RETRY_DELAY} seconds before attempting to reconnect...`
      );

      if (retryTimeout) clearTimeout(retryTimeout);
      if (resetTimeout) clearTimeout(resetTimeout);

      retryTimeout = setTimeout(() => {
          startMPXCapture();

          resetTimeout = setTimeout(() => {
              retryAttempts = 0;
          }, (RECONNECT_RETRY_DELAY * 1000) + (30 * 1000));
      }, RECONNECT_RETRY_DELAY * 1000);
  }

  function startMPXCapture() {

      logInfo(`[MPX] Attempt #${retryAttempts + 1} to start MPXCapture...`);

      // Determine Device
      if (MPX_INPUT_CARD && MPX_INPUT_CARD !== "") {
          targetDevice = MPX_INPUT_CARD;
      } else if (mainConfig && mainConfig.audio && mainConfig.audio.audioDevice) {
          targetDevice = mainConfig.audio.audioDevice;
      } else {
          targetDevice = "Default";
      }

      if (MPX_MODE !== "off" || (MPX_MODE === "off" && MPX_INPUT_CARD !== "")) {
        
        logInfo(`[MPX] Starting MPXCapture (Hybrid Mode)`);

        if (osPlatform === "win32") {

            
            const absConfigPath = path.resolve(configFilePath);
            const safeDevice = (targetDevice && targetDevice.length > 0) ? targetDevice : "Default";

            logInfo(`[MPX] Spawning Native C Binary (WASAPI Mode) | Dev="${safeDevice}"`);

            rec = spawn(
                MPX_EXE_PATH,
                [
                    String(SAMPLE_RATE),
                    safeDevice,      // Wird an InitWASAPI übergeben
                    String(FFT_SIZE),
                    absConfigPath,
                    String(UDP_CONTROL_PORT)
                ],
                {
                    cwd: path.resolve(__dirname, "../../"),
                    env: process.env
                }
            );

        /* =====================================================
           LINUX: Pipe via Arecord -> Stdin
           ===================================================== */
} else {

  const escapedConfigPath = configFilePath.replace(/"/g, '\\"');

  let safeDevice =
    (targetDevice && String(targetDevice).trim().length > 0 && String(targetDevice).trim() !== "Default")
      ? String(targetDevice).trim()
      : "hw:3,0";

  const AREC_BUFFER_SIZE = 262144;
  const AREC_PERIOD_SIZE = 65536;
  const USE_MMAP = true;

  const CPU_ARECORD = 2;
  const CPU_MPXCAP  = 3;

  logInfo(
    `[MPX] Spawning Linux Binary (Pipe Mode) | Dev="${safeDevice}" | fmt=S32_LE SR=${SAMPLE_RATE} FFT=${FFT_SIZE} ` +
    `B=${AREC_BUFFER_SIZE} P=${AREC_PERIOD_SIZE} mmap=${USE_MMAP ? "on" : "off"} ` +
    `pin arecord@cpu${CPU_ARECORD} MPX@cpu${CPU_MPXCAP}`
  );

  rec = spawn("bash", ["-c", `
    taskset -c ${CPU_ARECORD} arecord -D "${safeDevice}" \
      -c2 -r ${SAMPLE_RATE} -f S32_LE \
      -t raw -q \
      ${USE_MMAP ? "--mmap" : ""} \
      --buffer-size ${AREC_BUFFER_SIZE} --period-size ${AREC_PERIOD_SIZE} \
    | taskset -c ${CPU_MPXCAP} "${MPX_EXE_PATH}" \
      ${SAMPLE_RATE} "s32" ${FFT_SIZE} "${escapedConfigPath}" ${UDP_CONTROL_PORT}
  `], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ALSA_CARD: "sndrpihifiberry" }
  });

}




        /* =====================================================
           STDERR & STDOUT Handling
           ===================================================== */
        rec.stderr.on("data", (d) => {
            const msg = d.toString().trim();
            if (msg.length) logInfo("[MPXCapture]", msg);
        });

        setupJsonReader(rec);

        rec.on("close", (code) => {
            logInfo("[MPX] MPXCapture exited with code:", code);
            attemptReconnect();
        });
    }
  }

  // Initial start
  startMPXCapture();

  // ====================================================================================
  //  Spectrum Activity Watchdog (Optimized CPU) - UDP VERSION
  // ====================================================================================
setInterval(() => {
     const now = Date.now();
     
     // Spectrum: Active if heartbeat received within last 4 seconds
     const isSpectrumActive = (now - lastSpectrumHeartbeat < 4000);
     
     // Scope: Active if heartbeat received within last 4 seconds
     const isScopeActive = (now - lastScopeHeartbeat < 4000);

     // Sync variables
     spectrumIsActive = isSpectrumActive;
     scopeIsActive = isScopeActive;

     // Force send commands every second to ensure C process is in sync (e.g. after restart)
     const specCmd = spectrumIsActive ? "SPECTRUM=1" : "SPECTRUM=0";
     udpClient.send(Buffer.from(specCmd), UDP_CONTROL_PORT, '127.0.0.1', () => {});

     const scopeCmd = isScopeActive ? "SCOPE=1" : "SCOPE=0";
     udpClient.send(Buffer.from(scopeCmd), UDP_CONTROL_PORT, '127.0.0.1', () => {});
     
}, 1000);

// ====================================================================================
//  MAIN BROADCAST LOOP (V2.5 - Dynamic Scaling + Visual Delay Buffer)
// ====================================================================================

if (typeof global.mpxPeakState === 'undefined') {
  global.mpxPeakState = 0;
  global.pilotFastAvg = 0;
  global.rdsStableValue = 0;
  global.mpxDisplayPeak = 0;
  global.logThrottle = 0;
}

// Global queue to buffer WebSocket messages for audio-visual synchronization
const wsMessageQueue = [];

setInterval(() => {
    // 1. Check WebSocket connection
    if (!dataPluginsWs || dataPluginsWs.readyState !== WebSocket.OPEN) {
        // Clear the queue to prevent a massive backlog burst upon reconnection
        wsMessageQueue.length = 0; 
        return;
    }
    
    // 2. Check Backpressure
    if (dataPluginsWs.bufferedAmount > MAX_WS_BACKLOG_BYTES) {
        if (++backpressureHits >= MAX_BACKPRESSURE_HITS) {
            try { dataPluginsWs.terminate(); } catch {}
            dataPluginsWs = null;
        }
        return;
    }
    backpressureHits = 0;

    // -----------------------------------------------------------------------
    // PREPARE DATA
    // -----------------------------------------------------------------------
    // We trust that the C-Script (MPXCapture) has already applied the SCALING
    // based on the config file. We receive values in kHz.
    
    const valP = currentPilotPeak; // Already scaled in kHz (from C)
    const valR = currentRdsPeak;   // Already scaled in kHz (from C)
    const valM = currentMaxPeak;   // Already scaled in kHz (from C)
    const valN = (currentNoiseFloor || 1e-6);

    // -----------------------------------------------------------------------
    // 1. PILOT
    // -----------------------------------------------------------------------
    // Smooth the input from C
    global.pilotFastAvg = (global.pilotFastAvg * 0.9) + (valP * 0.1);
    
    // Apply Calibration Offset (Calibration is +/- kHz)
    let out_pilot = global.pilotFastAvg;
    if (out_pilot > 0.5) {
        out_pilot += METER_PILOT_CALIBRATION;
    }
    if (out_pilot < 0) out_pilot = 0;

    // -----------------------------------------------------------------------
    // 2. RDS
    // -----------------------------------------------------------------------
    // Smooth the input from C
    const smoothingFactor = 0.1;
    global.rdsStableValue = (global.rdsStableValue * (1 - smoothingFactor)) + (valR * smoothingFactor);
    
    // Apply Calibration Offset
    let out_rds = global.rdsStableValue;
    if (out_rds > 0.1) {
        out_rds += METER_RDS_CALIBRATION;
    }
    
    // Limits
    if (out_rds < 0) out_rds = 0;

    // -----------------------------------------------------------------------
    // 3. MPX
    // -----------------------------------------------------------------------
    let rawMpxKHz = valM; 

    // Apply Calibration Offset
    // Only apply if signal is present (> 1.0 kHz) to avoid DC offset issues
        rawMpxKHz += METER_MPX_CALIBRATION;

    // Display Smoothing (Visual Only)
    let target = rawMpxKHz;
    const displayAttack = 0.3;
    const displayDecay = 0.1;

    if (target > global.mpxDisplayPeak) {
        global.mpxDisplayPeak = (global.mpxDisplayPeak * (1 - displayAttack)) + (target * displayAttack);
    } else {
        global.mpxDisplayPeak = (global.mpxDisplayPeak * (1 - displayDecay)) + (target * displayDecay);
    }
    
    let out_mpx = global.mpxDisplayPeak;
    
    // Safety Clamps
    if (out_mpx < 0) out_mpx = 0;

    // -----------------------------------------------------------------------
    // LOGGING (Restored Format)
    // -----------------------------------------------------------------------
    if (ENABLE_EXTENDED_LOGGING) {
        if (++global.logThrottle >= 33) {
             global.logThrottle = 0;
             // Logging Format: RAW (from C, Scaled) -> OUT (Smoothed + Calibrated)
             logInfo(`[MPX] RAW [P:${valP.toFixed(4)} M:${valM.toFixed(4)} R:${valR.toFixed(4)}] -> OUT [Pilot:${out_pilot.toFixed(1)}k MPX:${out_mpx.toFixed(1)}k RDS:${out_rds.toFixed(1)}k]`);
        }
    }

    // -----------------------------------------------------------------------
    // BUILD PAYLOAD
    // -----------------------------------------------------------------------
    // Send both Spectrum (value) and Scope (scope) arrays
    // Note: These might be empty arrays if spectrumIsActive is false
    let finalSpectrum = (latestMpxFrame && latestMpxFrame.length > 0) ? latestMpxFrame : [];
    let finalScope = (latestScopeFrame && latestScopeFrame.length > 0) ? latestScopeFrame : [];

    const payload = JSON.stringify({
      type: "MPX", 
      value: finalSpectrum, // 's' data from C#
      scope: finalScope,    // 'o' data from C#
      peak: out_mpx, 
      pilotKHz: out_pilot, 
      rdsKHz: out_rds,
      pilot: valP, 
      rds: valR, 
      noise: valN, 
      snr: (valN > 1e-6) ? (valP / valN) : 0
    });

    // -----------------------------------------------------------------------
    // SERVER-SIDE AUDIO-VISUAL SYNCHRONIZATION QUEUE
    // -----------------------------------------------------------------------
    const now = Date.now();
    wsMessageQueue.push({ time: now, payload: payload });

    // Process the queue and send out payloads that have surpassed the specified VisualDelayMs
    while (wsMessageQueue.length > 0 && (now - wsMessageQueue[0].time) >= VISUAL_DELAY_MS) {
        const item = wsMessageQueue.shift();
        
        // Final safety check just in case the connection state changed during the loop
        if (dataPluginsWs && dataPluginsWs.readyState === WebSocket.OPEN) {
            dataPluginsWs.send(item.payload, () => {});
        }
    }

}, SPECTRUM_SEND_INTERVAL);
  
}