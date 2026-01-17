/*
 * MPXCapture.c    High-Performance MPX Analyzer Tool
 * 
 * Features:
 * - DSP chain (19 kHz PLL locked)
 * - Precision Pilot Measurement (IQ demod + RMS)
 * - Precision RDS Measurement (IQ demod + RMS) with Dual-Mode reference
 * - Pilot-present gating
 * - Real-time FFT Spectrum
 * - Dynamic Config Reload
 * - MPX TruePeak (Catmull-Rom 4x/8x)
 * - DC Blocker (High-pass) 
 * - ITU-R BS.412 MPX Power Measurement (60s Integration)
 *
 * Compile Linux (static):              gcc MPXCapture.c -O3 -ffast-math -lm -static -o MPXCapture
 * Compile Linux (max compatibility):   gcc MPXCapture.c -O3 -ffast-math -fno-tree-vectorize -lm -static -o MPXCapture
 */

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <ctype.h>
#include <unistd.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#ifdef _WIN32
  #include <io.h>
  #include <fcntl.h>
  #include <windows.h>
  #define sleep_ms(x) Sleep(x)
#else
  #define sleep_ms(x) usleep((x)*1000)
#endif

/* ============================================================
   GLOBALS FOR DYNAMIC CONFIG
   ============================================================ */
float G_MeterInputCalibrationDB = 0.0f;
float G_SpectrumInputCalibrationDB = 0.0f;
float G_MeterGain = 1.0f;
float G_SpectrumGain = 1.0f;

// Calibration/display scaling
// NOTE: For BS.412 calculation to work correctly, G_MeterMPXScale
// must scale the input (0..1.0) to actual kHz deviation. 
// E.g. if 1.0 input = 100kHz deviation, this should be 100.0.
float G_MeterPilotScale = 1.0f;
float G_MeterMPXScale   = 100.0f;
float G_MeterRDSScale   = 1.0f;

// Spectrum
float G_SpectrumAttack = 0.25f;
float G_SpectrumDecay  = 0.15f;
int   G_SpectrumSendInterval = 30;

// Options
int   G_TruePeakFactor = 8;     // 4 or 8
int   G_EnableMpxLpf   = 1;     // "MPX_LPF_100kHz" 0/1

#define BASE_PREAMP 3.0f

char   G_ConfigPath[1024] = {0};
time_t G_LastConfigModTime = 0;

/* ============================================================
   JSON PARSER (simple key: float/int)
   ============================================================ */
static char* read_file_content(const char* filename) {
    FILE *f = fopen(filename, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long fsize = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (fsize <= 0) { fclose(f); return NULL; }
    char *string = (char*)malloc((size_t)fsize + 1);
    if (string) {
        size_t read_len = fread(string, 1, (size_t)fsize, f);
        string[read_len] = 0;
    }
    fclose(f);
    return string;
}

static float get_json_float(const char* json, const char* key, float currentVal) {
    if (!json || !key) return currentVal;
    char searchKey[128];
    snprintf(searchKey, sizeof(searchKey), "\"%s\"", key);
    char* pos = strstr((char*)json, searchKey);
    if (!pos) return currentVal;
    pos += strlen(searchKey);
    while (*pos && (isspace((unsigned char)*pos) || *pos == ':')) pos++;
    if (!*pos || (*pos != '-' && !isdigit((unsigned char)*pos))) return currentVal;
    char* endPtr;
    float val = strtof(pos, &endPtr);
    if (pos == endPtr) return currentVal;
    return val;
}

static int get_json_int(const char* json, const char* key, int currentVal) {
    float f = get_json_float(json, key, (float)currentVal);
    return (int)lroundf(f);
}

static void update_config(void) {
    if (strlen(G_ConfigPath) == 0) return;

    struct stat attr;
    if (stat(G_ConfigPath, &attr) != 0) return;

    if (G_LastConfigModTime != 0 && attr.st_mtime == G_LastConfigModTime) return;
    G_LastConfigModTime = attr.st_mtime;

    char *string = NULL;
    for (int attempts = 0; attempts < 5; attempts++) {
        string = read_file_content(G_ConfigPath);
        if (string && strlen(string) > 10 && strchr(string, '{')) break;
        if (string) { free(string); string = NULL; }
        sleep_ms(50);
    }
    if (!string) return;

    float mGain = get_json_float(string, "MeterInputCalibration", -9999.0f);
    if (mGain > -9000.0f) {
        G_MeterInputCalibrationDB = mGain;
        G_MeterGain = powf(10.0f, G_MeterInputCalibrationDB / 20.0f);
    }

    float sGain = get_json_float(string, "SpectrumInputCalibration", -9999.0f);
    if (sGain > -9000.0f) {
        G_SpectrumInputCalibrationDB = sGain;
        G_SpectrumGain = powf(10.0f, G_SpectrumInputCalibrationDB / 20.0f);
    }

    G_MeterPilotScale = get_json_float(string, "MeterPilotScale", G_MeterPilotScale);
    G_MeterMPXScale   = get_json_float(string, "MeterMPXScale",   G_MeterMPXScale);
    G_MeterRDSScale   = get_json_float(string, "MeterRDSScale",   G_MeterRDSScale);

    float att = get_json_float(string, "SpectrumAttackLevel", -9999.0f);
    if (att > -9000.0f) G_SpectrumAttack = att * 0.1f;

    float dec = get_json_float(string, "SpectrumDecayLevel", -9999.0f);
    if (dec > -9000.0f) G_SpectrumDecay = dec * 0.01f;

    float interval = get_json_float(string, "SpectrumSendInterval", -9999.0f);
    if (interval > 0.0f) G_SpectrumSendInterval = (int)interval;

    // New optional keys
    int tpf = get_json_int(string, "TruePeakFactor", G_TruePeakFactor);
    if (tpf == 8 || tpf == 4) G_TruePeakFactor = tpf;

    G_EnableMpxLpf = get_json_int(string, "MPX_LPF_100kHz", G_EnableMpxLpf) ? 1 : 0;

    // Clamp spectrum smoothing
    if (G_SpectrumAttack > 1.0f) G_SpectrumAttack = 1.0f; if (G_SpectrumAttack < 0.01f) G_SpectrumAttack = 0.01f;
    if (G_SpectrumDecay  > 1.0f) G_SpectrumDecay  = 1.0f; if (G_SpectrumDecay  < 0.01f) G_SpectrumDecay  = 0.01f;

    fprintf(stderr, "[MPX-C] Config Update (%s):\n", G_ConfigPath);
    fprintf(stderr, "   MeterGain: %.2f dB (x%.6f)\n", G_MeterInputCalibrationDB, G_MeterGain);
    fprintf(stderr, "   Scales:    Pilot=%.6f, MPX=%.6f, RDS=%.6f\n", G_MeterPilotScale, G_MeterMPXScale, G_MeterRDSScale);
    fprintf(stderr, "   Spectrum:  Attack=%.3f Decay=%.3f Interval=%dms\n", G_SpectrumAttack, G_SpectrumDecay, G_SpectrumSendInterval);
    fprintf(stderr, "   MPX Peak:  TruePeakFactor=%d, MPX_LPF_100kHz=%d\n", G_TruePeakFactor, G_EnableMpxLpf);

    free(string);
}

/* ============================================================
   DSP UTILS (BiQuad)
   ============================================================ */
typedef struct {
    float a1, a2;
    float b0, b1, b2;
    float x1, x2;
    float y1, y2;
} BiQuadFilter;

static void BiQuad_Init(BiQuadFilter *f) { memset(f, 0, sizeof(BiQuadFilter)); }

static void BiQuad_BandPass(BiQuadFilter *f, float sampleRate, float frequency, float q) {
    BiQuad_Init(f);
    float w0 = 2.0f * (float)M_PI * frequency / sampleRate;
    float alpha = sinf(w0) / (2.0f * q);

    float b0 = alpha, b1 = 0.0f, b2 = -alpha;
    float a0 = 1.0f + alpha;
    float a1 = -2.0f * cosf(w0);
    float a2 = 1.0f - alpha;

    f->b0 = b0 / a0; f->b1 = b1 / a0; f->b2 = b2 / a0;
    f->a1 = a1 / a0; f->a2 = a2 / a0;
}

static void BiQuad_LowPass(BiQuadFilter *f, float sampleRate, float frequency, float q) {
    BiQuad_Init(f);
    float w0 = 2.0f * (float)M_PI * frequency / sampleRate;
    float alpha = sinf(w0) / (2.0f * q);
    float cosW0 = cosf(w0);

    float b0 = (1.0f - cosW0) * 0.5f;
    float b1 = 1.0f - cosW0;
    float b2 = (1.0f - cosW0) * 0.5f;
    float a0 = 1.0f + alpha;
    float a1 = -2.0f * cosW0;
    float a2 = 1.0f - alpha;

    f->b0 = b0 / a0; f->b1 = b1 / a0; f->b2 = b2 / a0;
    f->a1 = a1 / a0; f->a2 = a2 / a0;
}

static float BiQuad_Process(BiQuadFilter *f, float x) {
    float y = f->b0 * x + f->b1 * f->x1 + f->b2 * f->x2
            - f->a1 * f->y1 - f->a2 * f->y2;
    f->x2 = f->x1; f->x1 = x;
    f->y2 = f->y1; f->y1 = y;
    return y;
}

/* ============================================================
   DC BLOCKER
   ============================================================ */
typedef struct {
    float x1;
    float y1;
    float R;
} DCBlocker;

static void DCBlocker_Init(DCBlocker *d) {
    d->x1 = 0.0f;
    d->y1 = 0.0f;
    // R = 0.9995 creates a HPF cutoff < 5 Hz at standard rates
    // y[n] = x[n] - x[n-1] + R * y[n-1]
    d->R  = 0.9995f; 
}

static float DCBlocker_Process(DCBlocker *d, float x) {
    float y = x - d->x1 + d->R * d->y1;
    d->x1 = x;
    d->y1 = y;
    return y;
}

/* ============================================================
   SMALL HELPERS
   ============================================================ */
static float clampf(float x, float lo, float hi) {
    return (x < lo) ? lo : (x > hi) ? hi : x;
}

static float exp_alpha_from_tau(float sampleRate, float tauSeconds) {
    if (tauSeconds <= 0.0f) return 1.0f;
    float dt = 1.0f / sampleRate;
    return 1.0f - expf(-(dt / tauSeconds));
}

/* ============================================================
   TRUE PEAK (Factor 4/8) via Catmull-Rom interpolation
   ============================================================ */
typedef struct { float x0, x1, x2, x3; int warm; } TruePeakN;

static void TruePeakN_Init(TruePeakN *tp) { memset(tp, 0, sizeof(TruePeakN)); }

static float catmull_rom(float p0, float p1, float p2, float p3, float t) {
    float t2 = t * t;
    float t3 = t2 * t;
    return 0.5f * (
        (2.0f * p1) +
        (-p0 + p2) * t +
        (2.0f * p0 - 5.0f * p1 + 4.0f * p2 - p3) * t2 +
        (-p0 + 3.0f * p1 - 3.0f * p2 + p3) * t3
    );
}

static float TruePeakN_Process(TruePeakN *tp, float x, int factor) {
    if (factor != 8) factor = 4;

    if (tp->warm < 4) {
        if (tp->warm == 0) { tp->x0 = x; tp->x1 = x; tp->x2 = x; tp->x3 = x; }
        else if (tp->warm == 1) { tp->x1 = x; tp->x2 = x; tp->x3 = x; }
        else if (tp->warm == 2) { tp->x2 = x; tp->x3 = x; }
        else { tp->x3 = x; }
        tp->warm++;
        return fabsf(x);
    }

    tp->x0 = tp->x1;
    tp->x1 = tp->x2;
    tp->x2 = tp->x3;
    tp->x3 = x;

    float p0 = tp->x0, p1 = tp->x1, p2 = tp->x2, p3 = tp->x3;

    float maxAbs = 0.0f;
    for (int k = 0; k <= factor; k++) {
        float t = (float)k / (float)factor;
        float y = catmull_rom(p0, p1, p2, p3, t);
        float a = fabsf(y);
        if (a > maxAbs) maxAbs = a;
    }
    return maxAbs;
}

/* ============================================================
   DEVA-LIKE PEAK HOLD / RELEASE
   ============================================================ */
typedef struct {
    int holdSamples;
    int holdCounter;
    float releaseCoef;
    float value;
} PeakHoldRelease;

static void PeakHoldRelease_Init(PeakHoldRelease *e, int sampleRate, float holdMs, float releaseMs) {
    memset(e, 0, sizeof(PeakHoldRelease));
    e->holdSamples = (int)fmaxf(1.0f, (float)sampleRate * (holdMs / 1000.0f));
    float tau = fmaxf(0.001f, releaseMs / 1000.0f);
    e->releaseCoef = expf(-1.0f / ((float)sampleRate * tau));
    e->value = 0.0f;
    e->holdCounter = 0;
}

static float PeakHoldRelease_Process(PeakHoldRelease *e, float x) {
    if (x >= e->value) {
        e->value = x;
        e->holdCounter = e->holdSamples;
        return e->value;
    }
    if (e->holdCounter > 0) {
        e->holdCounter--;
        return e->value;
    }
    e->value *= e->releaseCoef;
    if (x > e->value) {
        e->value = x;
        e->holdCounter = e->holdSamples;
    }
    return e->value;
}

/* ============================================================
   PLL GAINS (Type-II, 2nd order)
   ============================================================ */
static void PLL_ComputeGains(float sampleRate, float loopBwHz, float zeta, float *outKp, float *outKi) {
    float T = 1.0f / sampleRate;
    const float Kd = 0.5f; // approx with normalized multiplier PD
    const float K0 = 1.0f;

    float theta = (loopBwHz * T) / (zeta + (0.25f / zeta));
    float d = 1.0f + 2.0f * zeta * theta + theta * theta;

    float kp = (4.0f * zeta * theta) / d;
    float ki = (4.0f * theta * theta) / d;

    kp /= (Kd * K0);
    ki /= (Kd * K0);

    *outKp = kp;
    *outKi = ki;
}

/* ============================================================
   MPX DEMODULATOR (Pilot PLL + RDS Dual-Mode Ref)
   ============================================================ */
typedef struct {
    int sampleRate;

    // Filters
    BiQuadFilter bpf19;
    BiQuadFilter bpf57;

    // Pilot IQ LPF
    BiQuadFilter lpfI_Pilot;
    BiQuadFilter lpfQ_Pilot;

    // RDS IQ LPF
    BiQuadFilter lpfI_Rds;
    BiQuadFilter lpfQ_Rds;

    // Pilot PLL
    float p_phaseRad;
    float p_w0Rad;
    float p_integrator;
    float p_kp, p_ki;
    float p_errLP, p_errAlpha;

    // 57k fallback PLL (locks directly to 57k when pilot absent)
    float r_phaseRad;
    float r_w0Rad;
    float r_integrator;
    float r_kp, r_ki;
    float r_errLP, r_errAlpha;

    // Power estimators
    float pilotPow, pilotPowAlpha;
    float mpxPow,   mpxPowAlpha;
    float rdsPow,   rdsPowAlpha;

    // RMS smoothing (mag^2)
    float meanSqPilot;
    float meanSqRds;
    float rmsAlpha;

    // Pilot presence gate
    int pilotPresent;
    int presentCount;
    int absentCount;

    // RDS reference blend: 1.0 = pilot-derived (3x), 0.0 = 57-PLL
    float rdsRefBlend;
    float blendAlpha;

    // Outputs
    float pilotMag;
    float rdsMag;

} MpxDemodulator;

static void MpxDemod_ResetPilotPLL(MpxDemodulator *d) {
    d->p_integrator = 0.0f;
    d->p_errLP = 0.0f;
}
static void MpxDemod_ResetRdsPLL(MpxDemodulator *d) {
    d->r_integrator = 0.0f;
    d->r_errLP = 0.0f;
}

static void MpxDemod_Init(MpxDemodulator *d, int sampleRate) {
    memset(d, 0, sizeof(MpxDemodulator));
    d->sampleRate = sampleRate;

    BiQuad_BandPass(&d->bpf19, (float)sampleRate, 19000.0f, 20.0f);
    BiQuad_BandPass(&d->bpf57, (float)sampleRate, 57000.0f, 20.0f);

    BiQuad_LowPass(&d->lpfI_Pilot, (float)sampleRate, 50.0f,   0.707f);
    BiQuad_LowPass(&d->lpfQ_Pilot, (float)sampleRate, 50.0f,   0.707f);

    BiQuad_LowPass(&d->lpfI_Rds,   (float)sampleRate, 2400.0f, 0.707f);
    BiQuad_LowPass(&d->lpfQ_Rds,   (float)sampleRate, 2400.0f, 0.707f);

    d->p_w0Rad = 2.0f * (float)M_PI * 19000.0f / (float)sampleRate;
    d->r_w0Rad = 2.0f * (float)M_PI * 57000.0f / (float)sampleRate;

    // PLL design targets
    const float LOOP_BW_PILOT = 2.0f; // 1..5 Hz typical
    const float LOOP_BW_RDS   = 2.0f; // keep narrow, stable
    const float ZETA = 0.707f;

    PLL_ComputeGains((float)sampleRate, LOOP_BW_PILOT, ZETA, &d->p_kp, &d->p_ki);
    PLL_ComputeGains((float)sampleRate, LOOP_BW_RDS,   ZETA, &d->r_kp, &d->r_ki);

    // Power + smoothing
    d->pilotPowAlpha = exp_alpha_from_tau((float)sampleRate, 0.050f);
    d->mpxPowAlpha   = exp_alpha_from_tau((float)sampleRate, 0.100f);
    d->rdsPowAlpha   = exp_alpha_from_tau((float)sampleRate, 0.050f);

    d->p_errAlpha    = exp_alpha_from_tau((float)sampleRate, 0.010f);
    d->r_errAlpha    = exp_alpha_from_tau((float)sampleRate, 0.010f);

    d->rmsAlpha      = exp_alpha_from_tau((float)sampleRate, 0.100f);

    // Blend time (how quickly we switch references)
    d->blendAlpha    = exp_alpha_from_tau((float)sampleRate, 0.050f); // 50ms

    d->pilotPow = 1e-6f;
    d->mpxPow   = 1e-6f;
    d->rdsPow   = 1e-6f;

    d->rdsRefBlend = 1.0f; // start with pilot-ref
    d->pilotPresent = 0;

    fprintf(stderr, "[PLL] Pilot: BL=%.2fHz -> Kp=%.10f Ki=%.10f\n", LOOP_BW_PILOT, d->p_kp, d->p_ki);
    fprintf(stderr, "[PLL] RDS57: BL=%.2fHz -> Kp=%.10f Ki=%.10f\n", LOOP_BW_RDS,   d->r_kp, d->r_ki);
    fprintf(stderr, "[RDS] Dual-Mode ref enabled (pilot->3x when present, 57PLL when absent). Blend tau ~50ms.\n");
}

static void MpxDemod_Process(MpxDemodulator *d, float rawSample) {
    // Broadband MPX RMS for pilot presence gating
    d->mpxPow += (rawSample * rawSample - d->mpxPow) * d->mpxPowAlpha;
    float mpxRms = sqrtf(fmaxf(d->mpxPow, 1e-12f));

    // Pilot filter for PLL input + pilotRms estimate
    float pilotFiltered = BiQuad_Process(&d->bpf19, rawSample);
    d->pilotPow += (pilotFiltered * pilotFiltered - d->pilotPow) * d->pilotPowAlpha;
    float pilotRms = sqrtf(fmaxf(d->pilotPow, 1e-12f));

    // Gate: pilotRms must be a fraction of broadband MPX RMS
    const float PILOT_REL_THRESH = 0.01f;
    const int PRESENT_HOLD_SAMPLES = 2000;
    const int ABSENT_HOLD_SAMPLES  = 8000;

    int presentNow = (mpxRms > 1e-9f) && ((pilotRms / (mpxRms + 1e-9f)) > PILOT_REL_THRESH);

    if (presentNow) {
        d->presentCount++;
        d->absentCount = 0;
        if (!d->pilotPresent && d->presentCount > PRESENT_HOLD_SAMPLES) {
            d->pilotPresent = 1;
            MpxDemod_ResetPilotPLL(d);
            // Align the 57 PLL to pilot-derived phase to avoid jumps
            d->r_phaseRad = fmodf(3.0f * d->p_phaseRad, 2.0f * (float)M_PI);
            MpxDemod_ResetRdsPLL(d);
        }
    } else {
        d->absentCount++;
        d->presentCount = 0;
        if (d->pilotPresent && d->absentCount > ABSENT_HOLD_SAMPLES) {
            d->pilotPresent = 0;
            MpxDemod_ResetPilotPLL(d);
            // keep 57PLL running / reset it for clean lock
            MpxDemod_ResetRdsPLL(d);
        }
    }

    // --- PILOT PLL UPDATE (always free-run nominal; only correct when pilotPresent) ---
    float p_s = sinf(d->p_phaseRad);
    float p_err = pilotFiltered * (-p_s);
    float p_errNorm = p_err / (pilotRms + 1e-9f);

    d->p_errLP += (p_errNorm - d->p_errLP) * d->p_errAlpha;
    float pe = d->p_errLP;

    if (d->pilotPresent) {
        d->p_integrator += d->p_ki * pe;

        float radPerHz = (2.0f * (float)M_PI) / (float)d->sampleRate;
        float maxPull = 50.0f * radPerHz;
        d->p_integrator = clampf(d->p_integrator, -maxPull, +maxPull);

        float freqOffset = d->p_kp * pe + d->p_integrator;
        d->p_phaseRad += d->p_w0Rad + freqOffset;
    } else {
        d->p_phaseRad += d->p_w0Rad;
        d->meanSqPilot *= 0.9995f;
    }

    float twoPi = 2.0f * (float)M_PI;
    if (d->p_phaseRad >= twoPi) d->p_phaseRad -= twoPi;
    if (d->p_phaseRad < 0.0f)  d->p_phaseRad += twoPi;

    // --- PILOT IQ AMPLITUDE on RAW MPX (uses pilot phase) ---
    float p_c = cosf(d->p_phaseRad);
    float I_P = BiQuad_Process(&d->lpfI_Pilot, rawSample * p_c);
    float Q_P = BiQuad_Process(&d->lpfQ_Pilot, rawSample * sinf(d->p_phaseRad));
    float magSqPilot = (I_P * I_P + Q_P * Q_P);
    d->meanSqPilot += (magSqPilot - d->meanSqPilot) * d->rmsAlpha;
    d->pilotMag = d->pilotPresent ? sqrtf(fmaxf(d->meanSqPilot, 0.0f)) : 0.0f;

    // --- RDS REFERENCE: blend between pilot-derived 57 and fallback 57-PLL ---
    // Update blend factor
    float targetBlend = d->pilotPresent ? 1.0f : 0.0f;
    d->rdsRefBlend += (targetBlend - d->rdsRefBlend) * d->blendAlpha;

    // Always compute pilot-derived 57 phase
    float phase57_pilot = 3.0f * d->p_phaseRad;
    while (phase57_pilot >= twoPi) phase57_pilot -= twoPi;
    float c57_p = cosf(phase57_pilot);
    float s57_p = sinf(phase57_pilot);

    // --- 57k PLL (fallback): lock directly on 57k bandpass output ---
    float rdsFiltered57 = BiQuad_Process(&d->bpf57, rawSample);

    // RMS for normalization of 57 PLL detector
    d->rdsPow += (rdsFiltered57 * rdsFiltered57 - d->rdsPow) * d->rdsPowAlpha;
    float rdsRms = sqrtf(fmaxf(d->rdsPow, 1e-12f));

    // Run the 57PLL mainly when pilot is absent; when pilot present, keep it aligned (fast sync)
    if (!d->pilotPresent) {
        float r_s = sinf(d->r_phaseRad);
        float r_err = rdsFiltered57 * (-r_s);
        float r_errNorm = r_err / (rdsRms + 1e-9f);

        d->r_errLP += (r_errNorm - d->r_errLP) * d->r_errAlpha;
        float re = d->r_errLP;

        d->r_integrator += d->r_ki * re;

        float radPerHz = (2.0f * (float)M_PI) / (float)d->sampleRate;
        float maxPull = 100.0f * radPerHz; // a bit wider because 57k is higher
        d->r_integrator = clampf(d->r_integrator, -maxPull, +maxPull);

        float freqOffset = d->r_kp * re + d->r_integrator;
        d->r_phaseRad += d->r_w0Rad + freqOffset;
    } else {
        // lock it to pilot-derived phase while pilot is present (prevents jump at switchover)
        d->r_phaseRad = phase57_pilot;
        d->r_integrator = 0.0f;
        d->r_errLP = 0.0f;
    }

    if (d->r_phaseRad >= twoPi) d->r_phaseRad -= twoPi;
    if (d->r_phaseRad < 0.0f)  d->r_phaseRad += twoPi;

    float c57_r = cosf(d->r_phaseRad);
    float s57_r = sinf(d->r_phaseRad);

    // Blend carrier (smooth switching)
    float b = d->rdsRefBlend;
    float c57 = b * c57_p + (1.0f - b) * c57_r;
    float s57 = b * s57_p + (1.0f - b) * s57_r;

    // --- RDS IQ demodulation ---
    // Use RAW MPX for consistent calibration, or use rdsFiltered57 if you want extra cleanliness.
    float rdsIn = rawSample;

    float I_R = BiQuad_Process(&d->lpfI_Rds, rdsIn * c57);
    float Q_R = BiQuad_Process(&d->lpfQ_Rds, rdsIn * s57);

    float magSqRds = (I_R * I_R + Q_R * Q_R);
    d->meanSqRds += (magSqRds - d->meanSqRds) * d->rmsAlpha;
    d->rdsMag = sqrtf(fmaxf(d->meanSqRds, 0.0f));

    // If you *want* to force RDS=0 when pilot is absent, uncomment:
    // if (!d->pilotPresent) d->rdsMag = 0.0f;
}

/* ============================================================
   FFT (Spectrum)
   ============================================================ */
typedef struct { float r, i; } Complex;

static void QuickFFT(Complex *data, int n) {
    int i, j, k, n1, n2;
    Complex c, t;

    j = 0;
    n2 = n / 2;

    for (i = 1; i < n - 1; i++) {
        n1 = n2;
        while (j >= n1) { j -= n1; n1 >>= 1; }
        j += n1;
        if (i < j) { t = data[i]; data[i] = data[j]; data[j] = t; }
    }

    n1 = 0; n2 = 1;
    int stages = (int)log2((double)n);
    for (i = 0; i < stages; i++) {
        n1 = n2;
        n2 <<= 1;
        double a = 0.0;
        double step = -M_PI / (double)n1;

        for (j = 0; j < n1; j++) {
            c.r = (float)cos(a);
            c.i = (float)sin(a);
            a += step;

            for (k = j; k < n; k += n2) {
                t.r = c.r * data[k + n1].r - c.i * data[k + n1].i;
                t.i = c.r * data[k + n1].i + c.i * data[k + n1].r;

                data[k + n1].r = data[k].r - t.r;
                data[k + n1].i = data[k].i - t.i;

                data[k].r += t.r;
                data[k].i += t.i;
            }
        }
    }
}

static int is_power_of_two(int x) { return x > 0 && ((x & (x - 1)) == 0); }

/* ============================================================
   MAIN
   ============================================================ */
int main(int argc, char **argv)
{
    int sr = 192000;
    int fftSize = 4096;

    if (argc >= 2) sr = atoi(argv[1]);

    const char *devName = "Default";
    if (argc >= 3 && argv[2] && strlen(argv[2]) > 0) devName = argv[2];

    if (argc >= 4) fftSize = atoi(argv[3]);
    if (!is_power_of_two(fftSize) || fftSize < 512) fftSize = 4096;

    if (argc >= 5) {
        strncpy(G_ConfigPath, argv[4], 1023);
        G_ConfigPath[1023] = 0;
        update_config();
    }

#ifdef _WIN32
    _setmode(_fileno(stdin),  _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    setvbuf(stdout, NULL, _IONBF, 0);

    fprintf(stderr, "[MPX] Init SR:%d FFT:%d Dev:'%s' | MODE: DEVA-DSP (PLL+IQ, RDS dual-ref, truepeak)\n", sr, fftSize, devName);

    float   *window    = (float*)malloc(sizeof(float) * (size_t)fftSize);
    Complex *fftBuf    = (Complex*)malloc(sizeof(Complex) * (size_t)fftSize);
    float   *smoothBuf = (float*)calloc((size_t)fftSize / 2, sizeof(float));

    if (!window || !fftBuf || !smoothBuf) {
        fprintf(stderr, "[MPX] Memory allocation failed!\n");
        return 1;
    }

    for (int i = 0; i < fftSize; i++) {
        window[i] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * (float)i / (float)(fftSize - 1)));
    }

    // --- DC BLOCKER INIT ---
    DCBlocker dcBlocker;
    DCBlocker_Init(&dcBlocker);

    // --- BS.412 INIT ---
    // 60-second sliding window integration via 1-pole IIR
    float bs412_power = 0.0f;
    float bs412_alpha = exp_alpha_from_tau((float)sr, 60.0f);
    
    // Reference Power for 0 dBr:
    // Defined as power of a sinusoidal tone with +/- 19 kHz deviation.
    // This value (180.5) assumes that the input signal is scaled to kHz units before squaring.
    // Power = (Amp/sqrt(2))^2 = (19^2)/2 = 361/2 = 180.5
    const float BS412_REF_POWER = 180.5f;

    // Demod
    MpxDemodulator demod;
    MpxDemod_Init(&demod, sr);

    // Peak-path LPF (~100kHz, clamped)
    BiQuadFilter mpxPeakLpf;
    BiQuad_Init(&mpxPeakLpf);
    float cutoff = 100000.0f;
    float maxSafe = 0.45f * (float)sr;
    if (cutoff > maxSafe) cutoff = maxSafe;
    BiQuad_LowPass(&mpxPeakLpf, (float)sr, cutoff, 0.707f);
    fprintf(stderr, "[MPX] Peak-path LPF cutoff: %.1f Hz (requested 100kHz, clamped if needed)\n", cutoff);

    // MPX TruePeak + Envelope
    TruePeakN tpN;
    TruePeakN_Init(&tpN);

    PeakHoldRelease mpxEnv;
    PeakHoldRelease_Init(&mpxEnv, sr, 200.0f, 1500.0f);

    int fftIndex = 0;

    // Channel lock
    int active_channel = 0;
    int channel_locked = 0;
    double energyL = 0.0, energyR = 0.0;
    int energy_samples = 0;

    // Display smoothing
    float smoothP = 0.0f;
    float smoothR = 0.0f;
    float smoothB = -99.0f; // BS412 smooth display

    int counter = 0;
    int configCheckCounter = 0;
    int outputSampleThreshold = (sr * G_SpectrumSendInterval) / 1000;

    int maxBin = fftSize / 2;

    float in[2048 * 2];

    while (fread(in, sizeof(float), 2048 * 2, stdin) == (size_t)(2048 * 2)) {

        configCheckCounter++;
        if (configCheckCounter > 50) {
            update_config();
            outputSampleThreshold = (sr * G_SpectrumSendInterval) / 1000;
            configCheckCounter = 0;
        }

        for (int i = 0; i < 2048; i++) {

            float vL = in[i * 2];
            float vR = in[i * 2 + 1];

            if (!channel_locked) {
                energyL += (double)vL * (double)vL;
                energyR += (double)vR * (double)vR;
                energy_samples++;
                if (energy_samples >= 4096) {
                    active_channel = (energyR > energyL * 1.2) ? 1 : 0;
                    channel_locked = 1;
                    fprintf(stderr, "[MPX] Channel locked: %s\n", active_channel ? "RIGHT" : "LEFT");
                }
            }

            float vRaw = (active_channel == 0 ? vL : vR) * BASE_PREAMP;

            // --- DC BLOCKER (Before gain/calibration) ---
            float v = DCBlocker_Process(&dcBlocker, vRaw);

            float vMeters = v * G_MeterGain;
            float vSpec   = v * G_SpectrumGain;

            // --- BS.412 MPX POWER MEASUREMENT ---
            // Calculate using the SCALED value (assuming G_MeterMPXScale maps 1.0 to 100 kHz)
            // If the signal is not scaled to kHz, the result will be wrong.
            float vScaledForPower = vMeters * G_MeterMPXScale;
            float pwrInst = vScaledForPower * vScaledForPower;
            bs412_power += (pwrInst - bs412_power) * bs412_alpha;

            // --- MPX PEAK PATH ONLY ---
            float vPeak = vMeters;
            if (G_EnableMpxLpf) vPeak = BiQuad_Process(&mpxPeakLpf, vPeak);

            float tp = TruePeakN_Process(&tpN, vPeak, G_TruePeakFactor);
            float envPeak = PeakHoldRelease_Process(&mpxEnv, tp);

            // Demod (Pilot+RDS)
            MpxDemod_Process(&demod, vMeters);

            // FFT
            if (fftIndex < fftSize) {
                fftBuf[fftIndex].r = vSpec * window[fftIndex];
                fftBuf[fftIndex].i = 0.0f;
                fftIndex++;
            }

            counter++;

            if (counter >= outputSampleThreshold) {

                float pScaled = demod.pilotMag * G_MeterPilotScale;
                float rScaled = demod.rdsMag   * G_MeterRDSScale;

                if (smoothP == 0.0f) smoothP = pScaled; else smoothP = smoothP * 0.90f + pScaled * 0.10f;
                if (smoothR == 0.0f) smoothR = rScaled; else smoothR = smoothR * 0.90f + rScaled * 0.10f;

                // BS.412 dBr calculation (relative to 19kHz sine power)
                float bs412_dBr = 10.0f * log10f((bs412_power + 1e-12f) / BS412_REF_POWER);
                
                // Slower smoothing for BS412 text display
                if (smoothB < -90.0f) smoothB = bs412_dBr; else smoothB = smoothB * 0.98f + bs412_dBr * 0.02f;

                float mFinal = envPeak * G_MeterMPXScale;

                if (fftIndex >= fftSize) {
                    QuickFFT(fftBuf, fftSize);

                    printf("{\"p\":%.4f,\"r\":%.4f,\"m\":%.4f,\"b\":%.4f,\"s\":[", smoothP, smoothR, mFinal, smoothB);

                    for (int k = 0; k < maxBin; k++) {
                        float mag = hypotf(fftBuf[k].r, fftBuf[k].i);
                        float linearAmp = (mag * 2.0f) / (float)fftSize;

                        if (linearAmp > smoothBuf[k]) {
                            smoothBuf[k] = smoothBuf[k] * (1.0f - G_SpectrumAttack) + linearAmp * G_SpectrumAttack;
                        } else {
                            smoothBuf[k] = smoothBuf[k] * (1.0f - G_SpectrumDecay)  + linearAmp * G_SpectrumDecay;
                        }

                        if (k) printf(",");
                        printf("%.4f", smoothBuf[k] * 15.0f);
                    }
                    printf("]}\n");
                    fftIndex = 0;
                }

                counter = 0;
            }
        }
    }

    free(smoothBuf);
    free(window);
    free(fftBuf);
    return 0;
}