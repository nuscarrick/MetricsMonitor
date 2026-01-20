/*
 * MPXCapture.c    High-Performance MPX Analyzer Tool (v2.2)
 * 
 * Features:
 * - DSP chain (19 kHz PLL locked)
 * - Precision Pilot Measurement (IQ demod + RMS)
 * - Precision RDS Measurement (IQ demod + RMS) with Dual-Mode reference
 * - Pilot-present gating
 * - Real-time FFT Spectrum AND Oscilloscope (Parallel Output)
 * - Dynamic Config Reload
 * - MPX TruePeak (Catmull-Rom 4x/8x)
 * - DC Blocker (Robust High-pass, < 1Hz) 
 * - ITU-R BS.412 MPX Power Measurement (60s Integration)
 * - Tilt Correction (Stabilized Linear Gain Method)
 * - Decoupled Spectrum/Meter Calibration
 * - CPU Optimization: Spectrum/Scope calculation is gated via UDP commands
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
#include <errno.h>

// Networking Headers
#ifdef _WIN32
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <io.h>
  #include <fcntl.h>
  #include <windows.h>
  #define sleep_ms(x) Sleep(x)
  #define close_socket closesocket
  #pragma comment(lib, "ws2_32.lib")
#else
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <arpa/inet.h>
  #include <fcntl.h>
  #define sleep_ms(x) usleep((x)*1000)
  #define close_socket close
  #define SOCKET int
  #define INVALID_SOCKET -1
  #define SOCKET_ERROR -1
#endif

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ============================================================
   GLOBALS FOR DYNAMIC CONFIG & STATE
   ============================================================ */
float G_MeterInputCalibrationDB = 0.0f;
float G_MPXTiltCalibrationUs  = 0.0f; 
float G_SpectrumInputCalibrationDB = 0.0f;
float G_MeterGain = 1.0f;
float G_SpectrumGain = 1.0f;

float G_MeterPilotScale = 1.0f;
float G_MeterMPXScale   = 100.0f;
float G_MeterRDSScale   = 1.0f;

float G_SpectrumAttack = 0.25f;
float G_SpectrumDecay  = 0.15f;
int   G_SpectrumSendInterval = 30;

int   G_TruePeakFactor = 8;
int   G_EnableMpxLpf   = 1;

// State Control (controlled via UDP)
volatile int G_EnableSpectrum = 0;
SOCKET G_UdpSocket = INVALID_SOCKET;

#define BASE_PREAMP 3.0f
#define SCOPE_DECIMATION 5.19 

char   G_ConfigPath[1024] = {0};
time_t G_LastConfigModTime = 0;

/* ============================================================
   UDP NETWORK LOGIC
   ============================================================ */
void init_udp_listener(int port) {
#ifdef _WIN32
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);
#endif

    G_UdpSocket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (G_UdpSocket == INVALID_SOCKET) {
        fprintf(stderr, "[MPX] Error creating UDP socket\n");
        return;
    }

    // Set Non-Blocking
#ifdef _WIN32
    u_long mode = 1;
    ioctlsocket(G_UdpSocket, FIONBIO, &mode);
#else
    int flags = fcntl(G_UdpSocket, F_GETFL, 0);
    fcntl(G_UdpSocket, F_SETFL, flags | O_NONBLOCK);
#endif

    // Bind to 127.0.0.1 (Localhost only for security/consistency)
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");

    if (bind(G_UdpSocket, (struct sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR) {
        fprintf(stderr, "[MPX] Error binding UDP socket on port %d\n", port);
        close_socket(G_UdpSocket);
        G_UdpSocket = INVALID_SOCKET;
        return;
    }

    fprintf(stderr, "[MPX] UDP Listener started on 127.0.0.1:%d\n", port);
}

void check_udp_messages() {
    if (G_UdpSocket == INVALID_SOCKET) return;

    char buffer[128];
    struct sockaddr_in senderAddr;
    socklen_t senderLen = sizeof(senderAddr);

    // Read loop to clear backlog if multiple packets arrived
    while (1) {
        int len = recvfrom(G_UdpSocket, buffer, sizeof(buffer) - 1, 0, (struct sockaddr*)&senderAddr, &senderLen);
        
        if (len > 0) {
            buffer[len] = '\0';
            // Simple string matching
            if (strstr(buffer, "SPECTRUM=1")) {
                if (!G_EnableSpectrum) {
                    G_EnableSpectrum = 1;
                    // fprintf(stderr, "[MPX] Spectrum ENABLED via UDP\n");
                }
            } 
            else if (strstr(buffer, "SPECTRUM=0")) {
                if (G_EnableSpectrum) {
                    G_EnableSpectrum = 0;
                    // fprintf(stderr, "[MPX] Spectrum DISABLED via UDP\n");
                }
            }
        } else {
            // No more data (EWOULDBLOCK / EAGAIN) or Error
            break;
        }
    }
}

/* ============================================================
   TILT CORRECTOR
   ============================================================ */
typedef struct {
    float yIntegrator;
    float gain;
    float currentUs;
    float sampleRate;
} TiltCorrector;

static void Tilt_Init(TiltCorrector *t, float sampleRate) {
    memset(t, 0, sizeof(TiltCorrector));
    t->sampleRate = sampleRate;
    t->yIntegrator = 0.0f;
    t->gain = 0.0f;
    t->currentUs = 0.0f;
}

static void Tilt_Update(TiltCorrector *t, float us) {
    if (fabsf(us - t->currentUs) < 0.1f) return;
    t->currentUs = us;

    if (fabsf(us) < 1.0f) {
        t->gain = 0.0f;
        t->yIntegrator = 0.0f;
    } else {
        t->gain = us * 1.5e-6f; 
    }
    fprintf(stderr, "[Tilt] Updated to %.1f us (Gain: %.8f)\n", us, t->gain);
}

static float Tilt_Process(TiltCorrector *t, float x) {
    if (fabsf(t->currentUs) < 1.0f) return x;
    if (isnan(x) || isinf(x)) return 0.0f;
    
    t->yIntegrator = (t->yIntegrator * 0.999f) + (x * t->gain);
    
    if (t->yIntegrator > 2.0f) t->yIntegrator = 2.0f;
    else if (t->yIntegrator < -2.0f) t->yIntegrator = -2.0f;
    
    return x + t->yIntegrator;
}

/* ============================================================
   JSON PARSER
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

    G_MPXTiltCalibrationUs = get_json_float(string, "MPXTiltCalibration", G_MPXTiltCalibrationUs);

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

    int tpf = get_json_int(string, "TruePeakFactor", G_TruePeakFactor);
    if (tpf == 8 || tpf == 4) G_TruePeakFactor = tpf;

    G_EnableMpxLpf = get_json_int(string, "MPX_LPF_100kHz", G_EnableMpxLpf) ? 1 : 0;

    if (G_SpectrumAttack > 1.0f) G_SpectrumAttack = 1.0f; if (G_SpectrumAttack < 0.01f) G_SpectrumAttack = 0.01f;
    if (G_SpectrumDecay  > 1.0f) G_SpectrumDecay  = 1.0f; if (G_SpectrumDecay  < 0.01f) G_SpectrumDecay  = 0.01f;

    fprintf(stderr, "[MPX-C] Config Update (%s):\n", G_ConfigPath);
    free(string);
}

/* ============================================================
   DSP UTILS
   ============================================================ */
typedef struct { float a1, a2, b0, b1, b2, x1, x2, y1, y2; } BiQuadFilter;
static void BiQuad_Init(BiQuadFilter *f) { memset(f, 0, sizeof(BiQuadFilter)); }
static void BiQuad_BandPass(BiQuadFilter *f, float sampleRate, float frequency, float q) {
    BiQuad_Init(f); float w0 = 2.0f * (float)M_PI * frequency / sampleRate; float alpha = sinf(w0) / (2.0f * q);
    float b0 = alpha, b1 = 0.0f, b2 = -alpha, a0 = 1.0f + alpha, a1 = -2.0f * cosf(w0), a2 = 1.0f - alpha;
    f->b0 = b0/a0; f->b1 = b1/a0; f->b2 = b2/a0; f->a1 = a1/a0; f->a2 = a2/a0;
}
static void BiQuad_LowPass(BiQuadFilter *f, float sampleRate, float frequency, float q) {
    BiQuad_Init(f); float w0 = 2.0f * (float)M_PI * frequency / sampleRate; float alpha = sinf(w0) / (2.0f * q); float cosW0 = cosf(w0);
    float b0 = (1.0f-cosW0)*0.5f, b1 = 1.0f-cosW0, b2 = (1.0f-cosW0)*0.5f, a0 = 1.0f+alpha, a1 = -2.0f*cosW0, a2 = 1.0f-alpha;
    f->b0 = b0/a0; f->b1 = b1/a0; f->b2 = b2/a0; f->a1 = a1/a0; f->a2 = a2/a0;
}
static float BiQuad_Process(BiQuadFilter *f, float x) {
    if (isnan(x) || isinf(x)) x = 0.0f;
    float y = f->b0*x + f->b1*f->x1 + f->b2*f->x2 - f->a1*f->y1 - f->a2*f->y2;
    if (isnan(y) || isinf(y)) { f->x1=0; f->x2=0; f->y1=0; f->y2=0; return 0.0f; }
    f->x2 = f->x1; f->x1 = x; f->y2 = f->y1; f->y1 = y; return y;
}

// DC Blocker
typedef struct { float x1, y1, R; } DCBlocker;
static void DCBlocker_Init(DCBlocker *d) { d->x1=0; d->y1=0; d->R=0.9995f; }
static float DCBlocker_Process(DCBlocker *d, float x) {
    if (isnan(x) || isinf(x)) return 0.0f;
    float y = x - d->x1 + d->R * d->y1;
    if (isnan(y)) { d->x1=0; d->y1=0; return 0.0f; }
    d->x1=x; d->y1=y; return y;
}

// Helpers
static float clampf(float x, float lo, float hi) { return (x < lo) ? lo : (x > hi) ? hi : x; }
static float exp_alpha_from_tau(float sampleRate, float tauSeconds) {
    if (tauSeconds <= 0.0f) return 1.0f; return 1.0f - expf(-(1.0f/sampleRate) / tauSeconds);
}

// TruePeak (Catmull-Rom)
typedef struct { float x0, x1, x2, x3; int warm; } TruePeakN;
static void TruePeakN_Init(TruePeakN *tp) { memset(tp, 0, sizeof(TruePeakN)); }
static float catmull_rom(float p0, float p1, float p2, float p3, float t) {
    float t2 = t*t; float t3 = t2*t;
    return 0.5f * ((2.0f*p1) + (-p0+p2)*t + (2.0f*p0 - 5.0f*p1 + 4.0f*p2 - p3)*t2 + (-p0 + 3.0f*p1 - 3.0f*p2 + p3)*t3);
}
static float TruePeakN_Process(TruePeakN *tp, float x, int factor) {
    if (factor != 8) factor = 4;
    if (tp->warm < 4) {
        if (tp->warm == 0) { tp->x0=x; tp->x1=x; tp->x2=x; tp->x3=x; }
        else if (tp->warm == 1) { tp->x1=x; tp->x2=x; tp->x3=x; }
        else if (tp->warm == 2) { tp->x2=x; tp->x3=x; } else { tp->x3=x; }
        tp->warm++; return fabsf(x);
    }
    tp->x0 = tp->x1; tp->x1 = tp->x2; tp->x2 = tp->x3; tp->x3 = x;
    float p0=tp->x0, p1=tp->x1, p2=tp->x2, p3=tp->x3;
    float maxAbs = 0.0f;
    for (int k = 0; k <= factor; k++) {
        float t = (float)k / (float)factor;
        float y = catmull_rom(p0, p1, p2, p3, t);
        if (fabsf(y) > maxAbs) maxAbs = fabsf(y);
    }
    return maxAbs;
}

// Peak Hold Release
typedef struct { int holdSamples, holdCounter; float releaseCoef, value; } PeakHoldRelease;
static void PeakHoldRelease_Init(PeakHoldRelease *e, int sr, float holdMs, float releaseMs) {
    memset(e, 0, sizeof(PeakHoldRelease));
    e->holdSamples = (int)fmaxf(1.0f, (float)sr * (holdMs/1000.0f));
    e->releaseCoef = expf(-1.0f / ((float)sr * (fmaxf(0.001f, releaseMs/1000.0f))));
}
static float PeakHoldRelease_Process(PeakHoldRelease *e, float x) {
    if (x >= e->value) { e->value = x; e->holdCounter = e->holdSamples; return e->value; }
    if (e->holdCounter > 0) { e->holdCounter--; return e->value; }
    e->value *= e->releaseCoef;
    if (x > e->value) { e->value = x; e->holdCounter = e->holdSamples; }
    return e->value;
}

// PLL Gains
static void PLL_ComputeGains(float sampleRate, float loopBwHz, float zeta, float *outKp, float *outKi) {
    float T = 1.0f / sampleRate; const float Kd = 0.5f; const float K0 = 1.0f;
    float theta = (loopBwHz * T) / (zeta + (0.25f / zeta)); float d = 1.0f + 2.0f * zeta * theta + theta * theta;
    *outKp = ((4.0f * zeta * theta) / d) / (Kd * K0);
    *outKi = ((4.0f * theta * theta) / d) / (Kd * K0);
}

// MPX Demodulator
typedef struct {
    int sampleRate;
    BiQuadFilter bpf19, bpf57;
    BiQuadFilter lpfI_Pilot, lpfQ_Pilot, lpfI_Rds, lpfQ_Rds;
    float p_phaseRad, p_w0Rad, p_integrator, p_kp, p_ki, p_errLP, p_errAlpha;
    float r_phaseRad, r_w0Rad, r_integrator, r_kp, r_ki, r_errLP, r_errAlpha;
    float pilotPow, pilotPowAlpha, mpxPow, mpxPowAlpha, rdsPow, rdsPowAlpha;
    float meanSqPilot, meanSqRds, rmsAlpha;
    int pilotPresent, presentCount, absentCount;
    float rdsRefBlend, blendAlpha;
    float pilotMag, rdsMag;
} MpxDemodulator;

static void MpxDemod_Reset(MpxDemodulator *d) { d->p_integrator=0; d->p_errLP=0; d->r_integrator=0; d->r_errLP=0; }
static void MpxDemod_Init(MpxDemodulator *d, int sr) {
    memset(d, 0, sizeof(MpxDemodulator)); d->sampleRate = sr;
    BiQuad_BandPass(&d->bpf19, (float)sr, 19000.0f, 20.0f); BiQuad_BandPass(&d->bpf57, (float)sr, 57000.0f, 20.0f);
    BiQuad_LowPass(&d->lpfI_Pilot, (float)sr, 50.0f, 0.707f); BiQuad_LowPass(&d->lpfQ_Pilot, (float)sr, 50.0f, 0.707f);
    BiQuad_LowPass(&d->lpfI_Rds, (float)sr, 2400.0f, 0.707f); BiQuad_LowPass(&d->lpfQ_Rds, (float)sr, 2400.0f, 0.707f);
    d->p_w0Rad = 2.0f*M_PI*19000.0f/sr; d->r_w0Rad = 2.0f*M_PI*57000.0f/sr;
    PLL_ComputeGains((float)sr, 2.0f, 0.707f, &d->p_kp, &d->p_ki); PLL_ComputeGains((float)sr, 2.0f, 0.707f, &d->r_kp, &d->r_ki);
    d->pilotPowAlpha = exp_alpha_from_tau((float)sr, 0.050f); d->mpxPowAlpha = exp_alpha_from_tau((float)sr, 0.100f);
    d->rdsPowAlpha = exp_alpha_from_tau((float)sr, 0.050f);
    d->p_errAlpha = d->r_errAlpha = exp_alpha_from_tau((float)sr, 0.010f);
    d->rmsAlpha = exp_alpha_from_tau((float)sr, 0.100f); d->blendAlpha = exp_alpha_from_tau((float)sr, 0.050f);
    d->pilotPow = 1e-6f; d->mpxPow = 1e-6f; d->rdsPow = 1e-6f; d->rdsRefBlend = 1.0f;
}

static void MpxDemod_Process(MpxDemodulator *d, float rawSample) {
    if (isnan(rawSample)) rawSample = 0.0f;
    d->mpxPow += (rawSample * rawSample - d->mpxPow) * d->mpxPowAlpha;
    float mpxRms = sqrtf(fmaxf(d->mpxPow, 1e-12f));
    float pilotFiltered = BiQuad_Process(&d->bpf19, rawSample);
    d->pilotPow += (pilotFiltered * pilotFiltered - d->pilotPow) * d->pilotPowAlpha;
    float pilotRms = sqrtf(fmaxf(d->pilotPow, 1e-12f));

    int presentNow = (mpxRms > 1e-9f) && ((pilotRms / (mpxRms + 1e-9f)) > 0.01f);
    if (presentNow) { d->presentCount++; d->absentCount=0; if (!d->pilotPresent && d->presentCount > 2000) { d->pilotPresent=1; MpxDemod_Reset(d); d->r_phaseRad = fmodf(3.0f*d->p_phaseRad, 2.0f*M_PI); } }
    else { d->absentCount++; d->presentCount=0; if (d->pilotPresent && d->absentCount > 8000) { d->pilotPresent=0; MpxDemod_Reset(d); } }

    float p_err = pilotFiltered * (-sinf(d->p_phaseRad));
    d->p_errLP += ((p_err / (pilotRms + 1e-9f)) - d->p_errLP) * d->p_errAlpha;
    if (d->pilotPresent) {
        d->p_integrator += d->p_ki * d->p_errLP; d->p_integrator = clampf(d->p_integrator, -50.0f*(2.0f*M_PI/d->sampleRate), 50.0f*(2.0f*M_PI/d->sampleRate));
        d->p_phaseRad += d->p_w0Rad + (d->p_kp * d->p_errLP + d->p_integrator);
    } else { d->p_phaseRad += d->p_w0Rad; d->meanSqPilot *= 0.9995f; }
    if (d->p_phaseRad >= 2.0f*M_PI) d->p_phaseRad -= 2.0f*M_PI; if (d->p_phaseRad < 0) d->p_phaseRad += 2.0f*M_PI;
    
    float I_P = BiQuad_Process(&d->lpfI_Pilot, rawSample * cosf(d->p_phaseRad));
    float Q_P = BiQuad_Process(&d->lpfQ_Pilot, rawSample * sinf(d->p_phaseRad));
    d->meanSqPilot += ((I_P*I_P + Q_P*Q_P) - d->meanSqPilot) * d->rmsAlpha;
    d->pilotMag = d->pilotPresent ? sqrtf(fmaxf(d->meanSqPilot, 0.0f)) : 0.0f;

    d->rdsRefBlend += ((d->pilotPresent ? 1.0f : 0.0f) - d->rdsRefBlend) * d->blendAlpha;
    float phase57_pilot = fmodf(3.0f * d->p_phaseRad, 2.0f*M_PI);
    float rdsFiltered = BiQuad_Process(&d->bpf57, rawSample);
    d->rdsPow += (rdsFiltered*rdsFiltered - d->rdsPow) * d->rdsPowAlpha;
    
    if (!d->pilotPresent) {
        float r_err = rdsFiltered * (-sinf(d->r_phaseRad));
        d->r_errLP += ((r_err / (sqrtf(d->rdsPow)+1e-9f)) - d->r_errLP) * d->r_errAlpha;
        d->r_integrator += d->r_ki * d->r_errLP; d->r_integrator = clampf(d->r_integrator, -100.0f*(2.0f*M_PI/d->sampleRate), 100.0f*(2.0f*M_PI/d->sampleRate));
        d->r_phaseRad += d->r_w0Rad + (d->r_kp * d->r_errLP + d->r_integrator);
    } else { d->r_phaseRad = phase57_pilot; d->r_integrator=0; d->r_errLP=0; }
    if (d->r_phaseRad >= 2.0f*M_PI) d->r_phaseRad -= 2.0f*M_PI; if (d->r_phaseRad < 0) d->r_phaseRad += 2.0f*M_PI;

    float b = d->rdsRefBlend;
    float c57 = b * cosf(phase57_pilot) + (1.0f-b) * cosf(d->r_phaseRad);
    float s57 = b * sinf(phase57_pilot) + (1.0f-b) * sinf(d->r_phaseRad);
    float I_R = BiQuad_Process(&d->lpfI_Rds, rawSample * c57);
    float Q_R = BiQuad_Process(&d->lpfQ_Rds, rawSample * s57);
    d->meanSqRds += ((I_R*I_R + Q_R*Q_R) - d->meanSqRds) * d->rmsAlpha;
    d->rdsMag = sqrtf(fmaxf(d->meanSqRds, 0.0f));
}

// FFT
typedef struct { float r, i; } Complex;
static void QuickFFT(Complex *data, int n) {
    int i, j, k, n1, n2; Complex c, t;
    j = 0; n2 = n/2; for (i=1; i<n-1; i++) { n1=n2; while (j>=n1) { j-=n1; n1>>=1; } j+=n1; if (i<j) { t=data[i]; data[i]=data[j]; data[j]=t; } }
    n1=0; n2=1; int stages = (int)log2((double)n);
    for (i=0; i<stages; i++) { n1=n2; n2<<=1; double a=0, step=-M_PI/n1; for (j=0; j<n1; j++) { c.r=cos(a); c.i=sin(a); a+=step; for (k=j; k<n; k+=n2) { t.r=c.r*data[k+n1].r-c.i*data[k+n1].i; t.i=c.r*data[k+n1].i+c.i*data[k+n1].r; data[k+n1].r=data[k].r-t.r; data[k+n1].i=data[k].i-t.i; data[k].r+=t.r; data[k].i+=t.i; } } }
}
static int is_power_of_two(int x) { return x > 0 && ((x & (x - 1)) == 0); }

/* ============================================================
   MAIN PROGRAM
   ============================================================ */
int main(int argc, char **argv)
{
    int sr = 192000;
    int fftSize = 4096;

    if (argc >= 2) sr = atoi(argv[1]);
    const char *devName = (argc >= 3 && argv[2]) ? argv[2] : "Default";
    if (argc >= 4) fftSize = atoi(argv[3]);
    if (!is_power_of_two(fftSize) || fftSize < 512) fftSize = 4096;

    if (argc >= 5) {
        strncpy(G_ConfigPath, argv[4], 1023);
        update_config();
    }
    
    // UDP PORT PARSING
    int udpPort = 60001;
    if (argc >= 6) udpPort = atoi(argv[5]);

    init_udp_listener(udpPort);

#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
#endif
    setvbuf(stdout, NULL, _IONBF, 0);

    fprintf(stderr, "[MPX] High-End DSP Mode | SR:%d FFT:%d UDP:%d\n", sr, fftSize, udpPort);

    // Buffers
    float   *window    = (float*)malloc(sizeof(float) * fftSize);
    Complex *fftBuf    = (Complex*)malloc(sizeof(Complex) * fftSize);
    float   *smoothBuf = (float*)calloc(fftSize / 2, sizeof(float));
    float   *scopeBuf  = (float*)calloc(1024, sizeof(float)); 

    if (!window || !fftBuf || !smoothBuf || !scopeBuf) return 1;

    for (int i = 0; i < fftSize; i++) window[i] = 0.5f * (1.0f - cosf(2.0f * M_PI * i / (fftSize - 1)));

    // Init DSP Modules
    DCBlocker dcBlocker; DCBlocker_Init(&dcBlocker);
    TiltCorrector tilt; Tilt_Init(&tilt, (float)sr); 
    
    MpxDemodulator demod; MpxDemod_Init(&demod, sr);
    
    BiQuadFilter mpxPeakLpf; BiQuad_Init(&mpxPeakLpf);
    float cutoff = 100000.0f; if (cutoff > 0.45f*sr) cutoff = 0.45f*sr;
    BiQuad_LowPass(&mpxPeakLpf, (float)sr, cutoff, 0.707f);
    
    TruePeakN tpN; TruePeakN_Init(&tpN);
    PeakHoldRelease mpxEnv; PeakHoldRelease_Init(&mpxEnv, sr, 200.0f, 1500.0f);

    float bs412_power = 0.0f;
    float bs412_alpha = exp_alpha_from_tau((float)sr, 60.0f);
    const float BS412_REF_POWER = 180.5f;

    // --- OSCILLOSCOPE LOGIC ---
    int scopeIndex = 0;
    int scopeTrigger = 0;
    double scopeDecimator = 0.0;
    
    int triggerArmed = 0;
    int silenceSampleCount = 0;
    int isBurstMode = 0;
    const float SILENCE_THRES = 0.05f;
    const int MIN_SILENCE_SAMPLES = 2000;
    int triggerHoldoffCounter = 0;
    int triggerHoldoffLimit = (int)(sr * 0.020); // 20ms
    long samplesSinceLastTrigger = 0;
    long autoTriggerLimit = (long)(sr * 0.150); // 150ms

    // Channel lock
    int active_channel = 0, channel_locked = 0;
    double energyL = 0, energyR = 0; int energy_samples = 0;

    // Display smoothing
    float smoothP = 0.0f, smoothR = 0.0f, smoothB = -99.0f;

    int counter = 0;
    int configCheckCounter = 0;
    int outputSampleThreshold = (sr * G_SpectrumSendInterval) / 1000;
    int maxBin = fftSize / 2;
    int fftIndex = 0;

    float in[2048 * 2];

    while (fread(in, sizeof(float), 2048 * 2, stdin) == (size_t)(2048 * 2)) {

        // Check UDP commands every block
        check_udp_messages();
        int spectrumEnabled = G_EnableSpectrum;

        configCheckCounter++;
        if (configCheckCounter > 50) {
            update_config();
            Tilt_Update(&tilt, G_MPXTiltCalibrationUs);
            outputSampleThreshold = (sr * G_SpectrumSendInterval) / 1000;
            configCheckCounter = 0;
        }

        for (int i = 0; i < 2048; i++) {
            float vL = in[i*2], vR = in[i*2+1];

            if (!channel_locked) {
                energyL += vL*vL; energyR += vR*vR; energy_samples++;
                if (energy_samples >= 4096) { active_channel = (energyR > energyL * 1.5) ? 1 : 0; channel_locked = 1; }
            }

            float vRaw = (active_channel == 0 ? vL : vR) * BASE_PREAMP;

            // 1. DC Block 
            float vNoDc = DCBlocker_Process(&dcBlocker, vRaw);
            
            // 2. Tilt Correction
            float vTilt = Tilt_Process(&tilt, vNoDc);

            // 3. Gains
            float vMeters = vTilt * G_MeterGain;
            float vSpec   = vTilt * G_SpectrumGain;

            // --- OSCILLOSCOPE / FFT LOGIC ---
            if (spectrumEnabled) {
                // Trigger uses vRaw (uncalibrated) for stability
                if (fabsf(vRaw) < SILENCE_THRES) {
                    if (silenceSampleCount < MIN_SILENCE_SAMPLES + 100) silenceSampleCount++;
                    if (silenceSampleCount >= MIN_SILENCE_SAMPLES) isBurstMode = 1; 
                } else {
                    silenceSampleCount = 0;
                }

                if (triggerHoldoffCounter > 0) {
                    triggerHoldoffCounter--;
                } else if (!scopeTrigger) {
                    samplesSinceLastTrigger++;
                    int fire = 0;
                    if (samplesSinceLastTrigger > autoTriggerLimit) {
                        fire = 1;
                    } else {
                        if (isBurstMode) {
                            if (!triggerArmed && vRaw > 0.15f) { fire = 1; isBurstMode = 0; }
                        } else {
                            if (!triggerArmed) { if (vRaw > 0.2f) triggerArmed = 1; }
                            else { if (vRaw < 0.0f) { fire = 1; triggerArmed = 0; } }
                        }
                    }
                    if (fire) {
                        scopeTrigger = 1;
                        samplesSinceLastTrigger = 0;
                        scopeIndex = 0;
                        scopeDecimator = SCOPE_DECIMATION;
                        triggerArmed = 0; 
                    }
                }

                if (scopeTrigger) {
                    if (scopeIndex < 1024) {
                        if (scopeDecimator >= SCOPE_DECIMATION) {
                            scopeDecimator -= SCOPE_DECIMATION;
                            scopeBuf[scopeIndex++] = vTilt; 
                        }
                        scopeDecimator += 1.0;
                    } else {
                        scopeTrigger = 0;
                        triggerHoldoffCounter = triggerHoldoffLimit;
                    }
                }
                
                // --- FFT BUFFERING ---
                if (fftIndex < fftSize) {
                    fftBuf[fftIndex].r = vSpec * window[fftIndex]; fftBuf[fftIndex].i = 0.0f; fftIndex++;
                }
            }
            // --- END SCOPE/FFT LOGIC ---

            // --- BS.412 ---
            float vScaled = vMeters * G_MeterMPXScale;
            bs412_power += ((vScaled*vScaled) - bs412_power) * bs412_alpha;

            // --- TRUE PEAK ---
            float vPeak = vMeters;
            if (G_EnableMpxLpf) vPeak = BiQuad_Process(&mpxPeakLpf, vPeak);
            float tp = TruePeakN_Process(&tpN, vPeak, G_TruePeakFactor);
            float envPeak = PeakHoldRelease_Process(&mpxEnv, tp);

            // --- DEMOD ---
            MpxDemod_Process(&demod, vMeters);

            counter++;
            if (counter >= outputSampleThreshold) {
                float pScaled = demod.pilotMag * G_MeterPilotScale;
                float rScaled = demod.rdsMag   * G_MeterRDSScale;

                smoothP = (smoothP == 0.0f) ? pScaled : (smoothP * 0.90f + pScaled * 0.10f);
                smoothR = (smoothR == 0.0f) ? rScaled : (smoothR * 0.90f + rScaled * 0.10f);
                
                float bs412_dBr = 10.0f * log10f((bs412_power + 1e-12f) / BS412_REF_POWER);
                if (smoothB < -90.0f) smoothB = bs412_dBr; else smoothB = smoothB * 0.98f + bs412_dBr * 0.02f;

                float mFinal = envPeak * G_MeterMPXScale;

                printf("{");
                
                // Only Output Spectrum Arrays if enabled
                if (spectrumEnabled) {
                    if (fftIndex >= fftSize) {
                        QuickFFT(fftBuf, fftSize);
                        
                        printf("\"s\":[");
                        for (int k = 0; k < maxBin; k++) {
                            float mag = hypotf(fftBuf[k].r, fftBuf[k].i);
                            float linearAmp = (mag * 2.0f) / (float)fftSize;
                            if (linearAmp > smoothBuf[k]) smoothBuf[k] = smoothBuf[k] * (1.0f - G_SpectrumAttack) + linearAmp * G_SpectrumAttack;
                            else smoothBuf[k] = smoothBuf[k] * (1.0f - G_SpectrumDecay)  + linearAmp * G_SpectrumDecay;
                            
                            printf("%.4f", smoothBuf[k] * 15.0f);
                            if (k < maxBin - 1) printf(",");
                        }
                        
                        printf("],\"o\":[");
                        for (int k = 0; k < 1024; k++) {
                            printf("%.4f", scopeBuf[k]);
                            if (k < 1023) printf(",");
                        }
                        printf("],");
                        fftIndex = 0;
                    } else {
                         // Should not happen often if interval is synced, but safety empty
                         printf("\"s\":[],\"o\":[],");
                    }
                } else {
                     // Spectrum Disabled -> Empty Arrays
                     printf("\"s\":[],\"o\":[],");
                }

                printf("\"p\":%.4f,\"r\":%.4f,\"m\":%.4f,\"b\":%.4f}\n", smoothP, smoothR, mFinal, smoothB);
                fflush(stdout);
                
                counter = 0;
            }
        }
    }

    free(smoothBuf); free(scopeBuf); free(window); free(fftBuf);
    if (G_UdpSocket != INVALID_SOCKET) close_socket(G_UdpSocket);
    return 0;
}