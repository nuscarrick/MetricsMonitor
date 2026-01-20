///////////////////////////////////////////////////////////////
//                                                           //
//  metricsmonitor-meters.js                        (V2.2)   //
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

    // Configuration constants (auto-updated by the server)
    // ==========================================================
    // DEBUG CONFIGURATION
    // ==========================================================
    const ENABLE_DEBUG = false;
    const DEBUG_INTERVAL_MS = 2000;
    let lastDebugTime = 0;

    // Sample rate dependent flags
    const RDS_ENABLED = (sampleRate === 192000);
    const PILOT_ENABLED = (sampleRate !== 48000);
    const MPX_ENABLED = (sampleRate === 192000);

    // Global Levels State
    const levels = {
        left: 0,
        right: 0,
        hf: 0,
        hfBase: 0,
        hfValue: 0,
        stereoPilot: 0,
        rds: 0,
        mpxTotal: 0
    };

    // This flag is set externally by the main RDS decoder when it has a valid lock
    let websocketRdsActive = false;

    // --- NEW: Client-side gate delay for MPX meter ---
    let mpxGateDelayTimer = 0;
    const MPX_GATE_CONFIRMATION_FRAMES = 5; // Approx. 150ms delay (5 frames * 30ms/frame)

    // Config for Peak Indicators (2 Seconds Hold)
    const PEAK_CONFIG = {
        smoothing: 0.85,
        holdMs: 2000
    };

    // Peaks state for all channels including MPX
    const peaks = {
        left: { value: 0, lastUpdate: Date.now() },
        right: { value: 0, lastUpdate: Date.now() },
        mpx: { value: 0, lastUpdate: Date.now() }
    };

    // MPX Spectrum data processing variables
    let mpxSpectrum = [];
    let mpxSmoothSpectrum = [];

    // Raw values from the server
    let mpxPeakVal = 0;
    let pilotPeakVal = 0;
    let rdsPeakVal = 0;

    const MPX_DB_MIN = -90;
    const MPX_DB_MAX = 0;
    const MPX_FMAX = 96000;
    const MPX_AVG = 6;

    // Smoothed values for display
    let mpxDisplayValue = 0;
    let rdsDisplayValue = 0;
    let pilotDisplayValue = 0;

    // RF Unit handling
    let hfUnit = "dbf";
    let hfUnitListenerAttached = false;

    if (window.MetricsMonitor && typeof window.MetricsMonitor.getSignalUnit === "function") {
        const u = window.MetricsMonitor.getSignalUnit();
        if (u) {
            hfUnit = u.toLowerCase();
        }
    }

    // ==========================================================
    // COLOR HELPER FUNCTIONS
    // ==========================================================
    function parseRgb(rgbStr) {
        const match = rgbStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (match) {
            return { r: parseInt(match[1]), g: parseInt(match[2]), b: parseInt(match[3]) };
        }
        return { r: 0, g: 255, b: 0 }; // Default fallback to Green
    }

    function applyIntensity(colorObj, intensity) {
        // Apply intensity scaling to RGB values
        const r = Math.min(255, Math.round(colorObj.r * intensity));
        const g = Math.min(255, Math.round(colorObj.g * intensity));
        const b = Math.min(255, Math.round(colorObj.b * intensity));
        return `rgb(${r},${g},${b})`;
    }

    // Alias for readability
    const getScaledColor = applyIntensity;

    // -------------------------------------------------------
    // Unit Conversion Helpers
    // -------------------------------------------------------
    function hfBaseToDisplay(baseHF) {
        const v = Number(baseHF);
        if (!isFinite(v)) return 0;
        const ssu = (hfUnit || "").toLowerCase();

        if (ssu === "dbuv" || ssu === "dbµv" || ssu === "dbμv") {
            return v - 10.875;
        } else if (ssu === "dbm") {
            return v - 119.75;
        } else if (ssu === "dbf") {
            return v;
        }
        return v;
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
                const dBf = v + 10.875
                const rounded = round10(dBf);
                return idx === lastIndex ? `${rounded} dBf` : `${rounded}`;
            });
        }

        return baseScale_dBuV.map((v, idx) => {
            const rounded = round10(v);
            return idx === lastIndex ? `${rounded} dBµV` : `${rounded}`;
        });
    }

    // Stereo audio context variables
    let stereoAudioContext = null;
    let stereoSourceNode = null;
    let stereoSplitter = null;
    let stereoAnalyserL = null;
    let stereoAnalyserR = null;
    let stereoDataL = null;
    let stereoDataR = null;
    let stereoAnimationId = null;
    let stereoSetupIntervalId = null;

    // ==========================================================
    // METER COLOR LOGIC
    // ==========================================================

    // Helper to calculate color for Stereo Meters (L/R)
    function getStereoColorForPercent(p, totalSegments = 30) {
        const i = Math.max(
            0,
            Math.min(totalSegments - 1, Math.round((p / 100) * totalSegments) - 1)
        );
        const topBandStart = totalSegments - 5;

        const cDanger = parseRgb(MeterColorDanger);
        const cSafe = parseRgb(MeterColorSafe);

        if (i >= topBandStart) {
            // Red/Danger Zone
            const intensity = 0.8 + (0.2 * (i / totalSegments));
            return getScaledColor(cDanger, intensity);
        } else {
            // Green/Safe Zone
            const intensity = 0.6 + ((i / totalSegments) * 0.4);
            return getScaledColor(cSafe, intensity);
        }
    }

    // Helper to calculate color for MPX Meter
    function getMpxColorForIndex(i, totalSegments) {
        const kHzMax = 120;
        const idxGreenMax = Math.round((72.9 / kHzMax) * totalSegments);
        const idxYellowMax = Math.round((75.1 / kHzMax) * totalSegments);

        const cSafe = parseRgb(MeterColorSafe);
        const cWarning = parseRgb(MeterColorWarning);
        const cDanger = parseRgb(MeterColorDanger);

        if (i < idxGreenMax) {
            // Safe Zone (Green)
            const intensity = 0.4 + ((i / Math.max(1, idxGreenMax - 1)) * 0.4);
            return applyIntensity(cSafe, intensity);

        } else if (i < idxYellowMax) {
            // Warning Zone (Yellow)
            const pos = (i - idxGreenMax) / Math.max(1, idxYellowMax - idxGreenMax);
            const intensity = 1.2 + (0.2 * pos);
            return applyIntensity(cWarning, intensity);

        } else {
            // Danger Zone (Red)
            const pos = (i - idxYellowMax) / Math.max(1, totalSegments - idxYellowMax);
            const intensity = 0.8 + (0.2 * pos);
            return applyIntensity(cDanger, intensity);
        }
    }

    // Scale Labels
    const scales = {
        left: ["+5 dB", "0", "-5", "-10", "-15", "-20", "-25", "-30", "-35 dB"],
        right: [],
        stereoPilot: ["16", "14", "12", "10", "8", "6", "4", "2", "0 kHz"],
        hf: [],
        rds: ["16", "14", "12", "10", "8", "6", "4", "2", "0 kHz"],
        mpx: ["120", "105", "90", "75", "60", "45", "30", "15", "0 kHz"]
    };

    // Generic Peak Updater
    function updatePeakValue(channel, current) {
        if (!peaks[channel]) peaks[channel] = { value: 0, lastUpdate: Date.now() };

        const p = peaks[channel];
        const now = Date.now();

        if (current >= p.value) {
            // New peak: update immediately
            p.value = current;
            p.lastUpdate = now;
        } else {
            // Drop: check hold time
            if (now - p.lastUpdate > PEAK_CONFIG.holdMs) {
                // Decay (drop slowly)
                p.value = Math.max(current, p.value - 1.0); // Linearly drop
            }
        }
    }

    // ==========================================================
    // PEAK SEGMENT RENDERING
    // ==========================================================
    function setPeakSegment(meterEl, peakPercent, meterId) {
        const segments = meterEl.querySelectorAll(".segment");
        if (!segments.length) return;

        // Remove old peak flag
        const prev = meterEl.querySelector(".segment.peak-flag");
        if (prev) {
            prev.classList.remove("peak-flag");
            prev.style.backgroundColor = "";
            prev.style.boxShadow = "";
            prev.style.opacity = "";
        }

        // Calculate index for the peak
        const idx = Math.max(
            0,
            Math.min(segments.length - 1, Math.round((peakPercent / 100) * segments.length) - 1)
        );
        const seg = segments[idx];
        if (!seg) return;

        // Add peak class
        seg.classList.add("peak-flag");

        // Determine color
        let peakColor = "";

        if (meterId && (meterId.includes("left") || meterId.includes("right"))) {
            if (PeakMode === "fixed") {
                peakColor = PeakColorFixed;
            } else {
                peakColor = getStereoColorForPercent(peakPercent, segments.length);
            }
        } else if (meterId && meterId.includes("mpx")) {
            // MPX always dynamic, ignores PeakMode "fixed" setting
            peakColor = getMpxColorForIndex(idx, segments.length);
        }

        // Apply Color Forcefully
        if (peakColor) {
            seg.style.setProperty("background-color", peakColor, "important");
        }
    }

    // -------------------------------------------------------
    // DOM Creation: createLevelMeter
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

        if (id.includes("left") || id.includes("right") || id.includes("mpx")) {
            const marker = document.createElement("div");
            marker.className = "peak-marker";
            meterBar.appendChild(marker);
        }

        const labelElement = document.createElement("div");
        labelElement.classList.add("label");
        labelElement.innerText = label;

        const meterWrapper = document.createElement("div");
        meterWrapper.classList.add("meter-wrapper");

        const valueDisplay = document.createElement("div");
        valueDisplay.classList.add("value-display");
        valueDisplay.innerText = "0.0";
        meterWrapper.appendChild(valueDisplay);

        if (id.includes("left")) labelElement.classList.add("label-left");
        if (id.includes("right")) labelElement.classList.add("label-right");

        meterWrapper.appendChild(meterBar);
        meterWrapper.appendChild(labelElement);

        if (scaleValues && scaleValues.length > 0) {
            const scale = document.createElement("div");
            scale.classList.add("meter-scale");
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

    // ==========================================================
    // MAIN UPDATE FUNCTION: updateMeter
    // ==========================================================
    function updateMeter(meterId, level, rawValueOverride = null) {
        const baseId = meterId;
        const targets = [];
        const el1 = document.getElementById(baseId);
        if (el1) targets.push(el1);
        const el2 = document.getElementById(`mm-combo-${baseId}`);
        if (el2 && el2 !== el1) targets.push(el2);
        if (!targets.length) return;

        // Parse Config Colors
        const cDanger = parseRgb(MeterColorDanger);
        const cSafe = parseRgb(MeterColorSafe);
        const cWarning = parseRgb(MeterColorWarning);

        targets.forEach((meter) => {
            const meterId = baseId;

            const isRds = meterId.includes("rds");
            const isPilot = meterId.includes("stereo-pilot");
            const isMpx = meterId.includes("mpx");
            const isHf = meterId.includes("hf");

            const rdsDisabled = isRds && !RDS_ENABLED;
            const pilotDisabled = isPilot && !PILOT_ENABLED;
            const mpxDisabled = isMpx && !MPX_ENABLED;

            const safeLevel = Math.max(0, Math.min(100, Number(level) || 0));
            const segments = meter.querySelectorAll(".segment");
            const activeCount = Math.round((safeLevel / 100) * segments.length);

            segments.forEach((seg, i) => {
                // If disabled, gray out
                if (rdsDisabled || pilotDisabled || mpxDisabled) {
                    seg.style.setProperty("background-color", "#333", "important");
                    return;
                }

                // Skip the peak flag, we handle it later
                if (seg.classList.contains("peak-flag")) return;

                let finalColor = "#333";

                if (i < activeCount) {

                    // --- Stereo Meters (L/R) ---
                    if (meterId.includes("left") || meterId.includes("right")) {
                        if (i >= segments.length - 5) {
                            finalColor = getScaledColor(cDanger, 1.0);
                        } else {
                            const intensity = 0.4 + ((i / segments.length) * 0.4);
                            finalColor = getScaledColor(cSafe, intensity);
                        }

                        // --- Pilot Meter ---
                    } else if (isPilot) {
                        if (i < segments.length * 0.5) {
                            const intensity = 0.4 + (i / (segments.length * 0.5)) * 0.4;
                            finalColor = applyIntensity(cSafe, intensity);
                        } else {
                            const pos = (i - segments.length * 0.5) / (segments.length * 0.5);
                            const intensity = 0.6 + (0.4 * pos);
                            finalColor = applyIntensity(cDanger, intensity);
                        }

                        // --- RDS Meter ---
                    } else if (isRds) {
                        const rdsThresholdIndex1 = Math.round((2.5 / 16) * segments.length);
                        const rdsThresholdIndex2 = Math.round((3.5 / 16) * segments.length);

                        if (i < rdsThresholdIndex1) {
                            const intensity = 0.4 + (i / rdsThresholdIndex1) * 0.4;
                            finalColor = applyIntensity(cSafe, intensity);
                        } else if (i >= rdsThresholdIndex1 && i <= rdsThresholdIndex2) {
                            finalColor = applyIntensity(cWarning, 1.0);
                        } else {
                            const pos = (i - rdsThresholdIndex2) / (segments.length - rdsThresholdIndex2);
                            const intensity = 0.6 + (0.4 * pos);
                            finalColor = applyIntensity(cDanger, intensity);
                        }

                        // --- MPX Meter ---
                    } else if (isMpx) {
                        finalColor = getMpxColorForIndex(i, segments.length);

                        // --- HF / RF Meter ---
                    } else if (isHf) {
                        const hfThresholdIndex = Math.round((20 / 90) * segments.length);

                        if (i < hfThresholdIndex) {
                            const pos = i / hfThresholdIndex;
                            const intensity = 0.6 + (0.4 * pos);
                            finalColor = applyIntensity(cDanger, intensity);
                        } else {
                            const intensity = 0.4 + ((i / segments.length) * 0.4);
                            finalColor = applyIntensity(cSafe, intensity);
                        }

                        // --- Default Fallback ---
                    } else {
                        if (i < segments.length * 0.6) {
                            finalColor = applyIntensity(cSafe, 1.0);
                        } else if (i < segments.length * 0.8) {
                            finalColor = applyIntensity(cWarning, 1.0);
                        } else {
                            finalColor = applyIntensity(cDanger, 1.0);
                        }
                    }
                }

                seg.style.setProperty("background-color", finalColor, "important");
            });

            // Update Peak Indicators
            if (meterId.includes("left") || meterId.includes("right")) {
                const channel = meterId.includes("left") ? "left" : "right";
                updatePeakValue(channel, safeLevel);
                setPeakSegment(meter, peaks[channel].value, meterId);
            } else if (isMpx) {
                updatePeakValue("mpx", safeLevel);
                setPeakSegment(meter, peaks.mpx.value, meterId);
            }

            // --- TEXT VALUE DISPLAY UPDATE ---
            const wrapper = meter.closest('.meter-wrapper');
            if (wrapper) {
                const valDisp = wrapper.querySelector('.value-display');
                if (valDisp) {
                    let text = "";

                    if (meterId.includes("left") || meterId.includes("right")) {
                        const channel = meterId.includes("left") ? "left" : "right";
                        const peakVal = peaks[channel].value;
                        const dB = (peakVal / 100) * 40 - 35;
                        text = dB.toFixed(1);

                    } else if (isHf) {
                        const dBuV_from_percent = (safeLevel / 100) * 90;
                        let baseHF = dBuV_from_percent + 10.875;
                        let displayValue = hfBaseToDisplay(baseHF);
                        text = displayValue.toFixed(1);

                    } else if (isPilot && rawValueOverride !== null) {
                        text = rawValueOverride.toFixed(1);
                    } else if (isPilot) {
                        const khz = (safeLevel / 100) * 16.0;
                        text = khz.toFixed(1);

                    } else if (isRds && rawValueOverride !== null) {
                        text = rawValueOverride.toFixed(1);
                    } else if (isRds) {
                        const khz = (safeLevel / 100) * 16.0;
                        text = khz.toFixed(1);

                    } else if (isMpx && rawValueOverride !== null) {
                        text = rawValueOverride.toFixed(1);
                    } else if (isMpx) {
                        const khz = (safeLevel / 100) * 120.0;
                        text = khz.toFixed(1);

                    } else {
                        text = safeLevel.toFixed(1);
                    }

                    if (rdsDisabled || pilotDisabled || mpxDisabled) {
                        text = "-";
                    }

                    const now = Date.now();
                    let updateInterval = 50;

                    if (isRds || isMpx || isPilot) {
                        updateInterval = 1000;
                    }

                    const lastUpdate = parseInt(valDisp.getAttribute("data-last-update") || "0");

                    if (now - lastUpdate > updateInterval) {
                        valDisp.innerText = text;
                        valDisp.setAttribute("data-last-update", now);
                    }
                }
            }
        });
    }

    // ==========================================================
    // MPX DATA HANDLING
    // ==========================================================
    function handleMpxArray(data) {
        if (!data || (!Array.isArray(data) && !(data instanceof Float32Array) && !(data instanceof Uint8Array))) {
            return;
        }

        const mags = [];
        const dataLen = data.length;

        for (let i = 0; i < dataLen; i++) {
            const item = data[i];
            let mag = 0;

            if (typeof item === "number") {
                mag = item;
            } else if (item && typeof item === "object") {
                if (typeof item.m === "number") mag = item.m;
                else if (typeof item.mag === "number") mag = item.mag;
                else if (Array.isArray(item) && typeof item[0] === "number") {
                    const re = item[0],
                        im = item[1];
                    mag = Math.sqrt(re * re + im * im);
                }
            }

            if (!isFinite(mag) || mag < 0) mag = 0;
            mags.push(mag);
        }

        const arr = [];
        for (let i = 0; i < mags.length; i++) {
            let db = 20 * Math.log10(mags[i] + 1e-15);
            if (db < MPX_DB_MIN) db = MPX_DB_MIN;
            if (db > MPX_DB_MAX) db = MPX_DB_MAX;
            arr.push(db);
        }

        if (mpxSmoothSpectrum.length === 0) {
            mpxSmoothSpectrum = arr.slice();
        } else {
            const len = Math.min(arr.length, mpxSmoothSpectrum.length);
            for (let i = 0; i < len; i++) {
                mpxSmoothSpectrum[i] =
                    (mpxSmoothSpectrum[i] * (MPX_AVG - 1) + arr[i]) / MPX_AVG;
            }
            if (arr.length > len) {
                for (let i = len; i < arr.length; i++) {
                    mpxSmoothSpectrum[i] = arr[i];
                }
            }
        }

        mpxSpectrum = mpxSmoothSpectrum.slice();

        updatePilotFromSpectrum();
        updateRdsFromSpectrum();
        updateMpxTotalFromSpectrum();
    }

    // ---------------------------------------------------------------
    // RDS Logic
    // ---------------------------------------------------------------
    function updateRdsFromSpectrum() {
        if (!RDS_ENABLED) {
            updateMeter("rds-meter", 0, 0);
            levels.rds = 0;
            rdsDisplayValue = 0;
            return;
        }

        // Only use the deviation value if the main decoder says RDS is active.
        let devKHz = websocketRdsActive ? rdsPeakVal : 0;
        if (devKHz < 0) devKHz = 0;

        // Smooth the display value
        rdsDisplayValue = rdsDisplayValue * 0.8 + devKHz * 0.2;
        if (rdsDisplayValue < 0.1) rdsDisplayValue = 0;

        const RDS_SCALE_MAX_KHZ = 16.0;
        let percent = Math.max(0, Math.min(100, (rdsDisplayValue / RDS_SCALE_MAX_KHZ) * 100));

        updateMeter("rds-meter", percent, rdsDisplayValue);
        levels.rds = percent;
    }

    // ---------------------------------------------------------------
    // Pilot Logic
    // ---------------------------------------------------------------
    function updatePilotFromSpectrum() {
        if (!PILOT_ENABLED) {
            pilotDisplayValue = 0;
            levels.stereoPilot = 0;
            updateMeter("stereo-pilot-meter", 0, 0);
            return;
        }

        let devKHz = pilotPeakVal;
        if (devKHz < 0) devKHz = 0;

        // Smooth the display value
        pilotDisplayValue = pilotDisplayValue * 0.8 + devKHz * 0.2;
        if (pilotDisplayValue < 0.1) pilotDisplayValue = 0;

        const PILOT_SCALE_MAX_KHZ = 16.0;
        let percent = (pilotDisplayValue / PILOT_SCALE_MAX_KHZ) * 100;
        if (percent > 100) percent = 100;
        if (percent < 0) percent = 0;

        levels.stereoPilot = percent;
        updateMeter("stereo-pilot-meter", percent, pilotDisplayValue);
    }

    // ---------------------------------------------------------------
    // MPX Total Logic (with NEW Gate Delay)
    // ---------------------------------------------------------------
    function updateMpxTotalFromSpectrum() {
        if (!MPX_ENABLED) {
            mpxDisplayValue = 0;
            levels.mpxTotal = 0;
            updateMeter("mpx-meter", 0, 0);
            return;
        }

        // --- MPX GATE DELAY LOGIC ---
        // Condition: Is a valid signal (Pilot or RDS) currently detected?
        const isSignalConditionMet = pilotDisplayValue > 6.0 || websocketRdsActive;

        if (isSignalConditionMet) {
            // If the condition is met, increment the confirmation timer.
            if (mpxGateDelayTimer < MPX_GATE_CONFIRMATION_FRAMES) {
                mpxGateDelayTimer++;
            }
        } else {
            // If the signal is lost, reset the timer immediately.
            mpxGateDelayTimer = 0;
        }

        // The gate is considered "open" only after the signal has been stable for the required number of frames.
        const isGateOpen = mpxGateDelayTimer >= MPX_GATE_CONFIRMATION_FRAMES;

        let currentMpxValue;
        if (isGateOpen) {
            // Gate is open: Use the actual measured value from the server.
            currentMpxValue = mpxPeakVal;
        } else {
            // Gate is closed: Force the value to 0 to suppress noise spikes.
            currentMpxValue = 0;
        }

        // Apply smoothing for fluid animation.
        mpxDisplayValue = mpxDisplayValue * 0.8 + currentMpxValue * 0.2;
        if (mpxDisplayValue < 0.1) mpxDisplayValue = 0; // Snap to zero when very low.

        const percent = Math.min(100, Math.max(0, (mpxDisplayValue / 120) * 100));
        levels.mpxTotal = percent;

        updateMeter("mpx-meter", percent, mpxDisplayValue);
    }

    // ---------------------------------------------------------------
    // Audio Setup & Init
    // ---------------------------------------------------------------
    function setupAudioMeters() {
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

        if (!sourceNode || !sourceNode.context) {
            return;
        }

        try {
            const ctx = sourceNode.context;

            if (stereoAudioContext !== ctx) {
                stereoAudioContext = ctx;
                stereoSourceNode = null;
                stereoSplitter = null;
                stereoAnalyserL = null;
                stereoAnalyserR = null;
                stereoDataL = null;
                stereoDataR = null;
            }

            if (stereoSplitter && stereoAnalyserL && stereoAnalyserR) {
                if (!stereoAnimationId) {
                    startStereoAnimation();
                }
                return;
            }

            stereoSourceNode = sourceNode;

            // Re-create nodes if missing
            stereoSplitter = stereoAudioContext.createChannelSplitter(2);
            stereoAnalyserL = stereoAudioContext.createAnalyser();
            stereoAnalyserR = stereoAudioContext.createAnalyser();

            stereoAnalyserL.fftSize = 2048;
            stereoAnalyserR.fftSize = 2048;

            stereoDataL = new Uint8Array(stereoAnalyserL.frequencyBinCount);
            stereoDataR = new Uint8Array(stereoAnalyserR.frequencyBinCount);

            try {
                stereoSourceNode.connect(stereoSplitter);
                stereoSplitter.connect(stereoAnalyserL, 0);
                stereoSplitter.connect(stereoAnalyserR, 1);
            } catch (e) {}

            if (!stereoAnimationId) {
                startStereoAnimation();
            }
        } catch (e) {
            console.error("[MetricsMeters] Error", e);
        }
    }

    function startStereoAnimation() {
        if (stereoAnimationId) cancelAnimationFrame(stereoAnimationId);

        const loop = () => {
            if (!stereoAnalyserL || !stereoAnalyserR || !stereoDataL || !stereoDataR) {
                stereoAnimationId = requestAnimationFrame(loop);
                return;
            }

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

            updateMeter("left-meter", levelL);
            updateMeter("right-meter", levelR);

            stereoAnimationId = requestAnimationFrame(loop);
        };

        stereoAnimationId = requestAnimationFrame(loop);
    }

    // Global socket variable to handle disconnects
    let mpxSocket = null;

    function setupMetricsWebSocket() {
        const currentURL = window.location;
        const webserverPort = currentURL.port || (currentURL.protocol === "https:" ? "443" : "80");
        const protocol = currentURL.protocol === "https:" ? "wss:" : "ws:";
        const webserverURL = currentURL.hostname;
        const websocketURL = `${protocol}//${webserverURL}:${webserverPort}/data_plugins`;

        if (mpxSocket && (mpxSocket.readyState === WebSocket.OPEN || mpxSocket.readyState === WebSocket.CONNECTING)) {
            return;
        }

        if (mpxSocket) {
            try {
                mpxSocket.close();
            } catch (e) {}
            mpxSocket = null;
        }

        const socket = new WebSocket(websocketURL);
        mpxSocket = socket;

        socket.onmessage = (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;
            }

            if (Array.isArray(message)) {
                handleMpxArray(message);
                return;
            }

            if (!message || typeof message !== "object") return;
            const type = message.type ? String(message.type).toLowerCase() : "";

            if (type === "mpx") {
                if (typeof message.peak === "number") {
                    mpxPeakVal = message.peak;
                    pilotPeakVal = (typeof message.pilotKHz === "number") ? message.pilotKHz : 0;
                    rdsPeakVal = (typeof message.rdsKHz === "number") ? message.rdsKHz : 0;
                }

                handleMpxArray(message.value);
                return;
            }
        };

        socket.onclose = () => {
            mpxSocket = null;
        };
    }

    function closeMetricsWebSocket() {
        if (mpxSocket) {
            try {
                mpxSocket.close();
            } catch (e) {
                console.error("[MetricsMeters] Error closing WebSocket:", e);
            }
            mpxSocket = null;
        }
    }

    function initMeters(levelMeterContainer) {
        if (window.MetricsMeters && typeof window.MetricsMeters.resetValues === "function") {
            window.MetricsMeters.resetValues();
        }

        const container = levelMeterContainer;
        if (!container) return;

        container.innerHTML = "";

        const stereoGroup = document.createElement("div");
        stereoGroup.classList.add("stereo-group");

        createLevelMeter("left-meter", "LEFT", stereoGroup, scales.left);
        createLevelMeter("right-meter", "RIGHT", stereoGroup, scales.right);

        container.appendChild(stereoGroup);

        const hfScale = buildHFScale(hfUnit);
        createLevelMeter("hf-meter", "RF", container, hfScale);

        const hfLevelMeter = container.querySelector("#hf-meter")?.closest(".level-meter");
        if (hfLevelMeter) {
            hfLevelMeter.style.transform = "translateX(0px)";
        }

        createLevelMeter("stereo-pilot-meter", "PILOT", container, scales.stereoPilot);
        createLevelMeter("mpx-meter", "MPX", container, scales.mpx);
        createLevelMeter("rds-meter", "RDS", container, scales.rds);

        const pilotMeterEl = container.querySelector("#stereo-pilot-meter")?.closest(".level-meter");
        if (pilotMeterEl && !PILOT_ENABLED) {
            pilotMeterEl.style.opacity = "0.4";
        }

        const rdsMeterEl = container.querySelector("#rds-meter")?.closest(".level-meter");
        if (rdsMeterEl && !RDS_ENABLED) {
            rdsMeterEl.style.opacity = "0.4";
        }

        const mpxMeterEl = container.querySelector("#mpx-meter")?.closest(".level-meter");
        if (mpxMeterEl && !MPX_ENABLED) {
            mpxMeterEl.style.opacity = "0.4";
        }

        updateMeter("left-meter", levels.left || 0);
        updateMeter("right-meter", levels.right || 0);
        updateMeter("hf-meter", levels.hf || 0);
        updateMeter("stereo-pilot-meter", levels.stereoPilot || 0);
        updateMeter("mpx-meter", levels.mpxTotal || 0);
        updateMeter("rds-meter", levels.rds || 0);

        setupMetricsWebSocket();
        setupAudioMeters();
        if (!stereoSetupIntervalId) {
            stereoSetupIntervalId = setInterval(setupAudioMeters, 3000);
        }

        if (!hfUnitListenerAttached &&
            window.MetricsMonitor &&
            typeof window.MetricsMonitor.onSignalUnitChange === "function") {

            hfUnitListenerAttached = true;

            window.MetricsMonitor.onSignalUnitChange((unit) => {
                if (window.MetricsMeters && typeof window.MetricsMeters.setHFUnit === "function") {
                    window.MetricsMeters.setHFUnit(unit);
                }
            });
        }
    }

    window.MetricsMeters = {
        levels,
        updateMeter,
        initMeters,
        cleanup: closeMetricsWebSocket,
        createWebSocket: setupMetricsWebSocket,

        resetValues() {
            mpxDisplayValue = 0;
            rdsDisplayValue = 0;
            pilotDisplayValue = 0;

            levels.mpxTotal = 0;
            levels.stereoPilot = 0;
            levels.rds = 0;

            mpxPeakVal = 0;
            pilotPeakVal = 0;
            rdsPeakVal = 0;
            
            mpxGateDelayTimer = 0; // Reset the gate timer

            peaks.mpx.value = 0;
            peaks.left.value = 0;
            peaks.right.value = 0;
        },

        // This function is called by the main framework when RDS status changes
        setRdsStatus(isActive) {
            websocketRdsActive = !!isActive;
        },

        getStereoBoost() { return StereoBoost; },
        setStereoBoost(value) {},
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
            const scaleEl = levelMeter.querySelector(".meter-scale");
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
        }
    };
})();