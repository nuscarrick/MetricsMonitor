/*
 * MPXCapture.c    High-Performance MPX Analyzer Tool (v2.4a)
 * 
 * Features:
 * - Asynchronous Input Thread (Ringbuffer) - Decouples Audio Input from DSP
 * - ON-DEMAND FFT: Only calculated when spectrum client is active
 * - ON-DEMAND Oscilloscope: Only calculated when scope client is active
 * - DSP chain (19 kHz PLL locked)
 * - Precision Pilot Measurement (IQ demod + RMS)
 * - Precision RDS Measurement (IQ demod + RMS) with Dual-Mode reference
 * - Real-time resource optimization via UDP control (Instant ON/OFF)
 * - Dynamic Config Reload
 * - MPX TruePeak (Catmull-Rom 4x/8x)
 * - DC Blocker (Robust High-pass, < 1Hz) 
 * - ITU-R BS.412 MPX Power Measurement (60s Integration)
 * - Tilt Correction (Stabilized Linear Gain Method)
 * - Manual/Auto MPX Channel Selection
 * - Dynamic Scope Amplitude Calibration
 * - Double-Buffered Trigger Engine with 128-Sample Pre-Trigger Shift
 *
 * Compile Linux: gcc MPXCapture.c -O3 -ffast-math -lm -pthread -static -o MPXCapture
 */

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>
#include <ctype.h>
#include <unistd.h>
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>

// Input stream format coming from stdin (arecord pipe)
typedef enum { INPUT_FLOAT32 = 0, INPUT_S32_LE = 1 } input_mode_t;
static input_mode_t g_input_mode = INPUT_FLOAT32;

// Channel selection mode
typedef enum { CH_AUTO = -1, CH_LEFT = 0, CH_RIGHT = 1 } channel_mode_t;
static channel_mode_t g_channel_mode = CH_AUTO;

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
   RINGBUFFER FOR ASYNCHRONOUS INPUT
   ============================================================ */

#define RINGBUFFER_CAPACITY 384000
typedef struct {
    float *buffer;
    size_t capacity;
    _Atomic(size_t) write_pos;
    _Atomic(size_t) read_pos;
    pthread_mutex_t lock;
    pthread_cond_t not_empty;
    pthread_cond_t not_full;
    volatile int shutdown;
} RingBuffer;

static RingBuffer *global_ringbuffer = NULL;

static RingBuffer* ringbuffer_create(size_t capacity) {
    RingBuffer *rb = (RingBuffer*)malloc(sizeof(RingBuffer));
    if (!rb) return NULL;
    
    rb->buffer = (float*)malloc(capacity * sizeof(float));
    if (!rb->buffer) {
        free(rb);
        return NULL;
    }
    
    rb->capacity = capacity;
    atomic_store(&rb->write_pos, 0);
    atomic_store(&rb->read_pos, 0);
    rb->shutdown = 0;
    
    pthread_mutex_init(&rb->lock, NULL);
    pthread_cond_init(&rb->not_empty, NULL);
    pthread_cond_init(&rb->not_full, NULL);
    
    return rb;
}

static void ringbuffer_destroy(RingBuffer *rb) {
    if (!rb) return;
    pthread_mutex_destroy(&rb->lock);
    pthread_cond_destroy(&rb->not_empty);
    pthread_cond_destroy(&rb->not_full);
    free(rb->buffer);
    free(rb);
}

static size_t ringbuffer_available_write(RingBuffer *rb) {
    size_t w = atomic_load(&rb->write_pos);
    size_t r = atomic_load(&rb->read_pos);
    if (w >= r) {
        return rb->capacity - (w - r) - 1;
    } else {
        return r - w - 1;
    }
}

static size_t ringbuffer_available_read(RingBuffer *rb) {
    size_t w = atomic_load(&rb->write_pos);
    size_t r = atomic_load(&rb->read_pos);
    if (w >= r) {
        return w - r;
    } else {
        return rb->capacity - (r - w);
    }
}

static int ringbuffer_write(RingBuffer *rb, const float *data, size_t count) {
    if (rb->shutdown) return -1;
    if (count > rb->capacity - 1) return -1;
    
    pthread_mutex_lock(&rb->lock);
    
    while (ringbuffer_available_write(rb) < count && !rb->shutdown) {
        pthread_cond_wait(&rb->not_full, &rb->lock);
    }
    
    if (rb->shutdown) {
        pthread_mutex_unlock(&rb->lock);
        return -1;
    }
    
    size_t w = atomic_load(&rb->write_pos);
    size_t space_until_wrap = rb->capacity - w;
    
    if (space_until_wrap >= count) {
        memcpy(&rb->buffer[w], data, count * sizeof(float));
        atomic_store(&rb->write_pos, (w + count) % rb->capacity);
    } else {
        memcpy(&rb->buffer[w], data, space_until_wrap * sizeof(float));
        memcpy(&rb->buffer[0], &data[space_until_wrap], (count - space_until_wrap) * sizeof(float));
        atomic_store(&rb->write_pos, count - space_until_wrap);
    }
    
    pthread_cond_signal(&rb->not_empty);
    pthread_mutex_unlock(&rb->lock);
    return 0;
}

static int ringbuffer_read(RingBuffer *rb, float *data, size_t count) {
    pthread_mutex_lock(&rb->lock);
    
    while (ringbuffer_available_read(rb) < count && !rb->shutdown) {
        pthread_cond_wait(&rb->not_empty, &rb->lock);
    }
    
    if (ringbuffer_available_read(rb) < count && rb->shutdown) {
        pthread_mutex_unlock(&rb->lock);
        return -1;
    }
    
    size_t r = atomic_load(&rb->read_pos);
    size_t space_until_wrap = rb->capacity - r;
    
    if (space_until_wrap >= count) {
        memcpy(data, &rb->buffer[r], count * sizeof(float));
        atomic_store(&rb->read_pos, (r + count) % rb->capacity);
    } else {
        memcpy(data, &rb->buffer[r], space_until_wrap * sizeof(float));
        memcpy(&data[space_until_wrap], &rb->buffer[0], (count - space_until_wrap) * sizeof(float));
        atomic_store(&rb->read_pos, count - space_until_wrap);
    }
    
    pthread_cond_signal(&rb->not_full);
    pthread_mutex_unlock(&rb->lock);
    return 0;
}

/* ============================================================
   INPUT THREAD
   ============================================================ */

static void* input_thread_func(void *arg) {
    float buf[2048 * 2];
    
    fprintf(stderr, "[MPX] Input thread started\n");
    
    while (!global_ringbuffer->shutdown) {
        size_t read_count = 0;
        if (g_input_mode == INPUT_S32_LE) {
            int32_t ibuf[2048 * 2];
            read_count = fread(ibuf, sizeof(int32_t), 2048 * 2, stdin);
            if (read_count > 0) {
                const float inv = 1.0f / 2147483648.0f;
                for (size_t i = 0; i < read_count; i++) buf[i] = (float)ibuf[i] * inv;
            }
        } else {
            read_count = fread(buf, sizeof(float), 2048 * 2, stdin);
        }
        
        if (read_count == 0) {
            if (feof(stdin)) {
                fprintf(stderr, "[MPX] Input EOF reached\n");
                global_ringbuffer->shutdown = 1;
            } else {
                fprintf(stderr, "[MPX] Input read error\n");
                global_ringbuffer->shutdown = 1;
            }
            break;
        }
        
        if (ringbuffer_write(global_ringbuffer, buf, read_count) < 0) {
            global_ringbuffer->shutdown = 1;
            break;
        }
    }
    
    pthread_cond_broadcast(&global_ringbuffer->not_empty);
    fprintf(stderr, "[MPX] Input thread stopped\n");
    return NULL;
}

/* ============================================================
   FEATURE CONTROL FLAGS (UDP-driven)
   ============================================================ */

_Atomic(int) G_EnableSpectrum = 0;
_Atomic(int) G_EnableScope = 0;

/* ============================================================
   GLOBALS FOR DYNAMIC CONFIG
   ============================================================ */
float G_MeterInputCalibrationDB = 0.0f;
float G_MPXTiltCalibrationUs = 0.0f; 
float G_SpectrumInputCalibrationDB = 0.0f;
float G_ScopeInputCalibrationDB = 0.0f;
float G_MeterGain = 1.0f;
float G_SpectrumGain = 1.0f;
float G_ScopeGain = 1.0f;

float G_MeterPilotScale = 1.0f;
float G_MeterMPXScale = 100.0f;
float G_MeterRDSScale = 1.0f;

float G_SpectrumAttack = 0.25f;
float G_SpectrumDecay = 0.15f;
int G_SpectrumSendInterval = 30;

int G_TruePeakFactor = 8;
int G_EnableMpxLpf = 1;

SOCKET G_UdpSocket = INVALID_SOCKET;

#define BASE_PREAMP 3.0f
#define SCOPE_DECIMATION 5.19 

char G_ConfigPath[1024] = {0};
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

#ifdef _WIN32
    u_long mode = 1;
    ioctlsocket(G_UdpSocket, FIONBIO, &mode);
#else
    int flags = fcntl(G_UdpSocket, F_GETFL, 0);
    fcntl(G_UdpSocket, F_SETFL, flags | O_NONBLOCK);
#endif

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

    fprintf(stderr, "[MPX] UDP Listener on 127.0.0.1:%d - Commands: SPECTRUM=1/0, SCOPE=1/0\n", port);
}

void check_udp_messages() {
    if (G_UdpSocket == INVALID_SOCKET) return;

    char buffer[128];
    struct sockaddr_in senderAddr;
    socklen_t senderLen = sizeof(senderAddr);

    while (1) {
        int len = recvfrom(G_UdpSocket, buffer, sizeof(buffer) - 1, 0, (struct sockaddr*)&senderAddr, &senderLen);
        
        if (len > 0) {
            buffer[len] = '\0';
            
            if (strstr(buffer, "SPECTRUM=1")) {
                if (!atomic_load(&G_EnableSpectrum)) {
                    atomic_store(&G_EnableSpectrum, 1);
                    fprintf(stderr, "[MPX] Spectrum ENABLED\n");
                }
            } 
            else if (strstr(buffer, "SPECTRUM=0")) {
                if (atomic_load(&G_EnableSpectrum)) {
                    atomic_store(&G_EnableSpectrum, 0);
                    fprintf(stderr, "[MPX] Spectrum DISABLED\n");
                }
            }
            
            if (strstr(buffer, "SCOPE=1")) {
                if (!atomic_load(&G_EnableScope)) {
                    atomic_store(&G_EnableScope, 1);
                    fprintf(stderr, "[MPX] Scope ENABLED\n");
                }
            }
            else if (strstr(buffer, "SCOPE=0")) {
                if (atomic_load(&G_EnableScope)) {
                    atomic_store(&G_EnableScope, 0);
                    fprintf(stderr, "[MPX] Scope DISABLED\n");
                }
            }
        } else {
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

    t->yIntegrator += x * t->gain;

    const float dcAlpha = 1e-5f;
    t->yIntegrator -= t->yIntegrator * dcAlpha;

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

static void get_json_channel_mode(const char* json) {
    if (!json) return;
    const char* key = "\"MPXChannel\"";
    char* pos = strstr((char*)json, key);
    if (!pos) return; 
    
    pos += strlen(key);
    while (*pos && (isspace((unsigned char)*pos) || *pos == ':')) pos++;
    
    if (strncasecmp(pos, "\"left\"", 6) == 0) g_channel_mode = CH_LEFT;
    else if (strncasecmp(pos, "\"right\"", 7) == 0) g_channel_mode = CH_RIGHT;
    else if (strncasecmp(pos, "\"auto\"", 6) == 0) g_channel_mode = CH_AUTO;
}

static int update_config(void) {
    if (strlen(G_ConfigPath) == 0) return 0;

    struct stat attr;
    if (stat(G_ConfigPath, &attr) != 0) return 0;

    if (G_LastConfigModTime != 0 && attr.st_mtime == G_LastConfigModTime) return 0;
    G_LastConfigModTime = attr.st_mtime;

    char *string = NULL;
    for (int attempts = 0; attempts < 5; attempts++) {
        string = read_file_content(G_ConfigPath);
        if (string && strlen(string) > 10 && strchr(string, '{')) break;
        if (string) { free(string); string = NULL; }
        sleep_ms(50);
    }
    if (!string) return 0;

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

    float scopeGainDB = get_json_float(string, "ScopeInputCalibration", -9999.0f);
    if (scopeGainDB > -9000.0f) {
        G_ScopeInputCalibrationDB = scopeGainDB;
        G_ScopeGain = powf(10.0f, G_ScopeInputCalibrationDB / 20.0f);
    }

    G_MeterPilotScale = get_json_float(string, "MeterPilotScale", G_MeterPilotScale);
    G_MeterMPXScale = get_json_float(string, "MeterMPXScale", G_MeterMPXScale);
    G_MeterRDSScale = get_json_float(string, "MeterRDSScale", G_MeterRDSScale);

    float att = get_json_float(string, "SpectrumAttackLevel", -9999.0f);
    if (att > -9000.0f) G_SpectrumAttack = att * 0.1f;

    float dec = get_json_float(string, "SpectrumDecayLevel", -9999.0f);
    if (dec > -9000.0f) G_SpectrumDecay = dec * 0.01f;

    float interval = get_json_float(string, "SpectrumSendInterval", -9999.0f);
    if (interval > 0.0f) G_SpectrumSendInterval = (int)interval;

    int tpf = get_json_int(string, "TruePeakFactor", G_TruePeakFactor);
    if (tpf == 8 || tpf == 4) G_TruePeakFactor = tpf;

    G_EnableMpxLpf = get_json_int(string, "MPX_LPF_100kHz", G_EnableMpxLpf) ? 1 : 0;
    
    channel_mode_t oldMode = g_channel_mode;
    get_json_channel_mode(string);
    int modeChanged = (oldMode != g_channel_mode);

    if (G_SpectrumAttack > 1.0f) G_SpectrumAttack = 1.0f; 
    if (G_SpectrumAttack < 0.01f) G_SpectrumAttack = 0.01f;
    if (G_SpectrumDecay > 1.0f) G_SpectrumDecay = 1.0f; 
    if (G_SpectrumDecay < 0.01f) G_SpectrumDecay = 0.01f;

    free(string);
    return modeChanged;
}

/* ============================================================
   DSP UTILS
   ============================================================ */
typedef struct { float a1, a2, b0, b1, b2, x1, x2, y1, y2; } BiQuadFilter;
static void BiQuad_Init(BiQuadFilter *f) { memset(f, 0, sizeof(BiQuadFilter)); }
static void BiQuad_BandPass(BiQuadFilter *f, float sampleRate, float frequency, float q) {
    BiQuad_Init(f); 
    float w0 = 2.0f * (float)M_PI * frequency / sampleRate; 
    float alpha = sinf(w0) / (2.0f * q);
    float b0 = alpha, b1 = 0.0f, b2 = -alpha, a0 = 1.0f + alpha, a1 = -2.0f * cosf(w0), a2 = 1.0f - alpha;
    f->b0 = b0/a0; f->b1 = b1/a0; f->b2 = b2/a0; f->a1 = a1/a0; f->a2 = a2/a0;
}
static void BiQuad_LowPass(BiQuadFilter *f, float sampleRate, float frequency, float q) {
    BiQuad_Init(f); 
    float w0 = 2.0f * (float)M_PI * frequency / sampleRate; 
    float alpha = sinf(w0) / (2.0f * q); 
    float cosW0 = cosf(w0);
    float b0 = (1.0f-cosW0)*0.5f, b1 = 1.0f-cosW0, b2 = (1.0f-cosW0)*0.5f, a0 = 1.0f+alpha, a1 = -2.0f*cosW0, a2 = 1.0f-alpha;
    f->b0 = b0/a0; f->b1 = b1/a0; f->b2 = b2/a0; f->a1 = a1/a0; f->a2 = a2/a0;
}
static float BiQuad_Process(BiQuadFilter *f, float x) {
    if (isnan(x) || isinf(x)) x = 0.0f;
    float y = f->b0*x + f->b1*f->x1 + f->b2*f->x2 - f->a1*f->y1 - f->a2*f->y2;
    if (isnan(y) || isinf(y)) { f->x1=0; f->x2=0; f->y1=0; f->y2=0; return 0.0f; }
    f->x2 = f->x1; f->x1 = x; f->y2 = f->y1; f->y1 = y; 
    return y;
}

typedef struct { float x1, y1, R; } DCBlocker;
static void DCBlocker_Init(DCBlocker *d) { d->x1=0; d->y1=0; d->R=0.99995f; }
static float DCBlocker_Process(DCBlocker *d, float x) {
    if (isnan(x) || isinf(x)) return 0.0f;
    float y = x - d->x1 + d->R * d->y1;
    if (isnan(y)) { d->x1=0; d->y1=0; return 0.0f; }
    d->x1=x; d->y1=y; 
    return y;
}

static float clampf(float x, float lo, float hi) { 
    return (x < lo) ? lo : (x > hi) ? hi : x; 
}
static float exp_alpha_from_tau(float sampleRate, float tauSeconds) {
    if (tauSeconds <= 0.0f) return 1.0f; 
    return 1.0f - expf(-(1.0f/sampleRate) / tauSeconds);
}

typedef struct { float x0, x1, x2, x3; int warm; } TruePeakN;
static void TruePeakN_Init(TruePeakN *tp) { memset(tp, 0, sizeof(TruePeakN)); }
static float catmull_rom(float p0, float p1, float p2, float p3, float t) {
    float t2 = t*t; 
    float t3 = t2*t;
    return 0.5f * ((2.0f*p1) + (-p0+p2)*t + (2.0f*p0 - 5.0f*p1 + 4.0f*p2 - p3)*t2 + (-p0 + 3.0f*p1 - 3.0f*p2 + p3)*t3);
}
static float TruePeakN_Process(TruePeakN *tp, float x, int factor) {
    if (factor != 8) factor = 4;
    if (tp->warm < 4) {
        if (tp->warm == 0) { tp->x0=x; tp->x1=x; tp->x2=x; tp->x3=x; }
        else if (tp->warm == 1) { tp->x1=x; tp->x2=x; tp->x3=x; }
        else if (tp->warm == 2) { tp->x2=x; tp->x3=x; } 
        else { tp->x3=x; }
        tp->warm++; 
        return fabsf(x);
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

typedef struct { 
    int holdSamples, holdCounter; 
    float releaseCoef, value; 
} PeakHoldRelease;

static void PeakHoldRelease_Init(PeakHoldRelease *e, int sr, float holdMs, float releaseMs) {
    memset(e, 0, sizeof(PeakHoldRelease));
    e->holdSamples = (int)fmaxf(1.0f, (float)sr * (holdMs/1000.0f));
    e->releaseCoef = expf(-1.0f / ((float)sr * (fmaxf(0.001f, releaseMs/1000.0f))));
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

static void PLL_ComputeGains(float sampleRate, float loopBwHz, float zeta, float *outKp, float *outKi) {
    float T = 1.0f / sampleRate; 
    const float Kd = 0.5f; 
    const float K0 = 1.0f;
    float theta = (loopBwHz * T) / (zeta + (0.25f / zeta)); 
    float d = 1.0f + 2.0f * zeta * theta + theta * theta;
    *outKp = ((4.0f * zeta * theta) / d) / (Kd * K0);
    *outKi = ((4.0f * theta * theta) / d) / (Kd * K0);
}

/* ============================================================
   MPX DEMODULATOR
   ============================================================ */
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

static void MpxDemod_Reset(MpxDemodulator *d) { 
    d->p_integrator=0; 
    d->p_errLP=0; 
    d->r_integrator=0; 
    d->r_errLP=0; 
}

static void MpxDemod_Init(MpxDemodulator *d, int sr) {
    memset(d, 0, sizeof(MpxDemodulator)); 
    d->sampleRate = sr;
    BiQuad_BandPass(&d->bpf19, (float)sr, 19000.0f, 20.0f); 
    BiQuad_BandPass(&d->bpf57, (float)sr, 57000.0f, 20.0f);
    BiQuad_LowPass(&d->lpfI_Pilot, (float)sr, 50.0f, 0.707f); 
    BiQuad_LowPass(&d->lpfQ_Pilot, (float)sr, 50.0f, 0.707f);
    BiQuad_LowPass(&d->lpfI_Rds, (float)sr, 2400.0f, 0.707f); 
    BiQuad_LowPass(&d->lpfQ_Rds, (float)sr, 2400.0f, 0.707f);
    d->p_w0Rad = 2.0f*M_PI*19000.0f/sr; 
    d->r_w0Rad = 2.0f*M_PI*57000.0f/sr;
    PLL_ComputeGains((float)sr, 2.0f, 0.707f, &d->p_kp, &d->p_ki); 
    PLL_ComputeGains((float)sr, 2.0f, 0.707f, &d->r_kp, &d->r_ki);
    d->pilotPowAlpha = exp_alpha_from_tau((float)sr, 0.050f); 
    d->mpxPowAlpha = exp_alpha_from_tau((float)sr, 0.100f);
    d->rdsPowAlpha = exp_alpha_from_tau((float)sr, 0.050f);
    d->p_errAlpha = d->r_errAlpha = exp_alpha_from_tau((float)sr, 0.010f);
    d->rmsAlpha = exp_alpha_from_tau((float)sr, 0.100f); 
    d->blendAlpha = exp_alpha_from_tau((float)sr, 0.050f);
    d->pilotPow = 1e-6f; 
    d->mpxPow = 1e-6f; 
    d->rdsPow = 1e-6f; 
    d->rdsRefBlend = 1.0f;
}

static void MpxDemod_Process(MpxDemodulator *d, float rawSample) {
    if (isnan(rawSample)) rawSample = 0.0f;
    d->mpxPow += (rawSample * rawSample - d->mpxPow) * d->mpxPowAlpha;
    float mpxRms = sqrtf(fmaxf(d->mpxPow, 1e-12f));
    float pilotFiltered = BiQuad_Process(&d->bpf19, rawSample);
    d->pilotPow += (pilotFiltered * pilotFiltered - d->pilotPow) * d->pilotPowAlpha;
    float pilotRms = sqrtf(fmaxf(d->pilotPow, 1e-12f));

    int presentNow = (mpxRms > 1e-9f) && ((pilotRms / (mpxRms + 1e-9f)) > 0.01f);
    if (presentNow) { 
        d->presentCount++; 
        d->absentCount=0; 
        if (!d->pilotPresent && d->presentCount > 2000) { 
            d->pilotPresent=1; 
            MpxDemod_Reset(d); 
            d->r_phaseRad = fmodf(3.0f*d->p_phaseRad, 2.0f*M_PI); 
        } 
    }
    else { 
        d->absentCount++; 
        d->presentCount=0; 
        if (d->pilotPresent && d->absentCount > 8000) { 
            d->pilotPresent=0; 
            MpxDemod_Reset(d); 
        } 
    }

    float p_err = pilotFiltered * (-sinf(d->p_phaseRad));
    d->p_errLP += ((p_err / (pilotRms + 1e-9f)) - d->p_errLP) * d->p_errAlpha;
    if (d->pilotPresent) {
        d->p_integrator += d->p_ki * d->p_errLP; 
        d->p_integrator = clampf(d->p_integrator, -50.0f*(2.0f*M_PI/d->sampleRate), 50.0f*(2.0f*M_PI/d->sampleRate));
        d->p_phaseRad += d->p_w0Rad + (d->p_kp * d->p_errLP + d->p_integrator);
    } else { 
        d->p_phaseRad += d->p_w0Rad; 
        d->meanSqPilot *= 0.9995f; 
    }
    if (d->p_phaseRad >= 2.0f*M_PI) d->p_phaseRad -= 2.0f*M_PI; 
    if (d->p_phaseRad < 0) d->p_phaseRad += 2.0f*M_PI;
    
    float I_P = BiQuad_Process(&d->lpfI_Pilot, rawSample * cosf(d->p_phaseRad));
    float Q_P = BiQuad_Process(&d->lpfQ_Pilot, rawSample * sinf(d->p_phaseRad));
    d->meanSqPilot += ((I_P*I_P + Q_P*Q_P) - d->meanSqPilot) * d->rmsAlpha;
    
    d->pilotMag = d->pilotPresent ? (2.0f * sqrtf(fmaxf(d->meanSqPilot, 0.0f))) : 0.0f;

    d->rdsRefBlend += ((d->pilotPresent ? 1.0f : 0.0f) - d->rdsRefBlend) * d->blendAlpha;
    float phase57_pilot = fmodf(3.0f * d->p_phaseRad, 2.0f*M_PI);
    float rdsFiltered = BiQuad_Process(&d->bpf57, rawSample);
    d->rdsPow += (rdsFiltered*rdsFiltered - d->rdsPow) * d->rdsPowAlpha;
    
    if (!d->pilotPresent) {
        float r_err = rdsFiltered * (-sinf(d->r_phaseRad));
        d->r_errLP += ((r_err / (sqrtf(d->rdsPow)+1e-9f)) - d->r_errLP) * d->r_errAlpha;
        d->r_integrator += d->r_ki * d->r_errLP; 
        d->r_integrator = clampf(d->r_integrator, -100.0f*(2.0f*M_PI/d->sampleRate), 100.0f*(2.0f*M_PI/d->sampleRate));
        d->r_phaseRad += d->r_w0Rad + (d->r_kp * d->r_errLP + d->r_integrator);
    } else { 
        d->r_phaseRad = phase57_pilot; 
        d->r_integrator=0; 
        d->r_errLP=0; 
    }
    if (d->r_phaseRad >= 2.0f*M_PI) d->r_phaseRad -= 2.0f*M_PI; 
    if (d->r_phaseRad < 0) d->r_phaseRad += 2.0f*M_PI;

    float b = d->rdsRefBlend;
    float c57 = b * cosf(phase57_pilot) + (1.0f-b) * cosf(d->r_phaseRad);
    float s57 = b * sinf(phase57_pilot) + (1.0f-b) * sinf(d->r_phaseRad);
    float I_R = BiQuad_Process(&d->lpfI_Rds, rawSample * c57);
    float Q_R = BiQuad_Process(&d->lpfQ_Rds, rawSample * s57);
    d->meanSqRds += ((I_R*I_R + Q_R*Q_R) - d->meanSqRds) * d->rmsAlpha;
    
    d->rdsMag = 2.0f * 1.4142f * sqrtf(fmaxf(d->meanSqRds, 0.0f));
}

/* ============================================================
   FFT
   ============================================================ */
typedef struct { float r, i; } Complex;
static void QuickFFT(Complex *data, int n) {
    int i, j, k, n1, n2; 
    Complex c, t;
    j = 0; 
    n2 = n/2; 
    for (i=1; i<n-1; i++) { 
        n1=n2; 
        while (j>=n1) { 
            j-=n1; 
            n1>>=1; 
        } 
        j+=n1; 
        if (i<j) { 
            t=data[i]; 
            data[i]=data[j]; 
            data[j]=t; 
        } 
    }
    n1=0; 
    n2=1; 
    int stages = (int)log2((double)n);
    for (i=0; i<stages; i++) { 
        n1=n2; 
        n2<<=1; 
        double a=0, step=-M_PI/n1; 
        for (j=0; j<n1; j++) { 
            c.r=cos(a); 
            c.i=sin(a); 
            a+=step; 
            for (k=j; k<n; k+=n2) { 
                t.r=c.r*data[k+n1].r-c.i*data[k+n1].i; 
                t.i=c.r*data[k+n1].i+c.i*data[k+n1].r; 
                data[k+n1].r=data[k].r-t.r; 
                data[k+n1].i=data[k].i-t.i; 
                data[k].r+=t.r; 
                data[k].i+=t.i; 
            } 
        } 
    }
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
    
    if (devName) {
        if (!strcasecmp(devName, "s32") || !strcasecmp(devName, "s32_le") || !strcasecmp(devName, "s32le")) {
            g_input_mode = INPUT_S32_LE;
        } else if (!strcasecmp(devName, "float") || !strcasecmp(devName, "float_le") || !strcasecmp(devName, "f32")) {
            g_input_mode = INPUT_FLOAT32;
        }
    }

    if (argc >= 4) fftSize = atoi(argv[3]);
    if (!is_power_of_two(fftSize) || fftSize < 512) fftSize = 4096;

    if (argc >= 5) {
        strncpy(G_ConfigPath, argv[4], 1023);
        update_config();
    }
    
    int udpPort = 60001;
    if (argc >= 6) udpPort = atoi(argv[5]);

    init_udp_listener(udpPort);

#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY); 
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    setvbuf(stdout, NULL, _IONBF, 0);

    fprintf(stderr, "[MPX] ON-DEMAND DSP Mode | SR:%d FFT:%d UDP:%d | Features: Shifted Pre-Trigger Scope (Instant Off)\n", sr, fftSize, udpPort);

    global_ringbuffer = ringbuffer_create(RINGBUFFER_CAPACITY);
    if (!global_ringbuffer) {
        fprintf(stderr, "[MPX] Failed to create ringbuffer\n");
        return 1;
    }

    pthread_t input_thread_id;
    if (pthread_create(&input_thread_id, NULL, input_thread_func, NULL) != 0) {
        fprintf(stderr, "[MPX] Failed to create input thread\n");
        ringbuffer_destroy(global_ringbuffer);
        return 1;
    }

    float   *window          = (float*)malloc(sizeof(float) * fftSize);
    Complex *fftBuf          = (Complex*)malloc(sizeof(Complex) * fftSize);
    float   *smoothBuf       = (float*)calloc(fftSize / 2, sizeof(float));
    float   *in              = (float*)malloc(sizeof(float) * 2048 * 2);

    // Double-Buffered Scope State Machine with Pre-Trigger Shift
    float scopeRollingBuf[2048];
    float scopeRollingRaw[2048];
    float scopeOutputBuf[1024];
    uint32_t scopeRollIdx = 0;
    int scopeCaptureCount = 0;
    int scopeTrigger = 0;
    double scopeDecimator = 0.0;
    
    int triggerArmed = 0;
    int silenceSampleCount = 0;
    int isBurstMode = 0;
    
    int triggerHoldoffCounter = 0;
    long samplesSinceLastTrigger = 0;

    memset(scopeRollingBuf, 0, sizeof(scopeRollingBuf));
    memset(scopeRollingRaw, 0, sizeof(scopeRollingRaw));
    memset(scopeOutputBuf, 0, sizeof(scopeOutputBuf));

    if (!window || !fftBuf || !smoothBuf || !in) {
        fprintf(stderr, "[MPX] Memory allocation failed\n");
        return 1;
    }

    for (int i = 0; i < fftSize; i++) 
        window[i] = 0.5f * (1.0f - cosf(2.0f * M_PI * i / (fftSize - 1)));

    DCBlocker dcBlocker; DCBlocker_Init(&dcBlocker);
    TiltCorrector tilt; Tilt_Init(&tilt, (float)sr); 
    MpxDemodulator demod; MpxDemod_Init(&demod, sr);
    
    BiQuadFilter mpxPeakLpf; BiQuad_Init(&mpxPeakLpf);
    float cutoff = 100000.0f; 
    if (cutoff > 0.45f*sr) cutoff = 0.45f*sr;
    BiQuad_LowPass(&mpxPeakLpf, (float)sr, cutoff, 0.707f);
    
    TruePeakN tpN; TruePeakN_Init(&tpN);
    PeakHoldRelease mpxEnv; PeakHoldRelease_Init(&mpxEnv, sr, 200.0f, 1500.0f);

    float bs412_power = 0.0f;
    float bs412_alpha = exp_alpha_from_tau((float)sr, 60.0f);
    const float BS412_REF_POWER = 180.5f;

    int active_channel = 0, channel_locked = 0;
    double energyL = 0, energyR = 0; 
    int energy_samples = 0;

    float smoothP = 0.0f, smoothR = 0.0f, smoothB = -99.0f;

    int counter = 0;
    int configCheckCounter = 0;
    int outputSampleThreshold = (sr * G_SpectrumSendInterval) / 1000;
    int maxBin = fftSize / 2;
    int fftIndex = 0;

    fprintf(stderr, "[MPX] Waiting for audio stream...\n");

    while (ringbuffer_read(global_ringbuffer, in, 2048 * 2) == 0) {

        check_udp_messages();
        int spectrumEnabled = atomic_load(&G_EnableSpectrum);
        int scopeEnabled = atomic_load(&G_EnableScope);

        configCheckCounter++;
        if (configCheckCounter > 50) {
            int modeChanged = update_config();
            if (modeChanged) {
                 channel_locked = 0; energy_samples = 0; energyL = 0; energyR = 0;
            }
            Tilt_Update(&tilt, G_MPXTiltCalibrationUs);
            outputSampleThreshold = (sr * G_SpectrumSendInterval) / 1000;
            configCheckCounter = 0;
        }

        for (int i = 0; i < 2048; i++) {
            float vL = in[i*2], vR = in[i*2+1];

            if (g_channel_mode == CH_LEFT) {
                active_channel = 0; channel_locked = 1;
            } else if (g_channel_mode == CH_RIGHT) {
                active_channel = 1; channel_locked = 1;
            } else {
                if (!channel_locked) {
                    energyL += vL*vL; energyR += vR*vR; energy_samples++;
                    if (energy_samples >= 4096) { 
                        active_channel = (energyR > energyL * 1.5) ? 1 : 0; 
                        channel_locked = 1; 
                    }
                }
            }

            float vRaw = (active_channel == 0 ? vL : vR) * BASE_PREAMP;
            float vNoDc = DCBlocker_Process(&dcBlocker, vRaw);
            float vTilt = Tilt_Process(&tilt, vNoDc);

            float vMeters = vTilt * G_MeterGain;
            float vSpec = vTilt * G_SpectrumGain;

            // === SPECTRUM ===
            if (spectrumEnabled) {
                if (fftIndex < fftSize) {
                    fftBuf[fftIndex].r = vSpec * window[fftIndex]; 
                    fftBuf[fftIndex].i = 0.0f; 
                    fftIndex++;
                }
            }

            // === DOUBLE-BUFFERED SHIFTED SCOPE STATE MACHINE ===
            if (scopeEnabled) {
                if (scopeDecimator >= SCOPE_DECIMATION) {
                    scopeDecimator -= SCOPE_DECIMATION;
                    
                    float decSample = vTilt * G_ScopeGain;
                    float decRaw = vRaw;
                    
                    scopeRollingBuf[scopeRollIdx & 2047] = decSample;
                    scopeRollingRaw[scopeRollIdx & 2047] = decRaw;
                    scopeRollIdx++;
                    
                    if (fabsf(decRaw) < 0.05f) {
                        if (silenceSampleCount < 500) silenceSampleCount++;
                        if (silenceSampleCount >= 400) isBurstMode = 1;
                    } else {
                        silenceSampleCount = 0;
                    }
                    
                    if (scopeTrigger) {
                        scopeCaptureCount++;
                        // 128 samples Pre-Trigger shift
                        if (scopeCaptureCount >= (1024 - 128)) {
                            uint32_t startIdx = scopeRollIdx - 1024;
                            for (int k = 0; k < 1024; k++) {
                                scopeOutputBuf[k] = scopeRollingBuf[(startIdx + k) & 2047];
                            }
                            scopeTrigger = 0;
                            triggerHoldoffCounter = 740;
                        }
                    } else if (triggerHoldoffCounter > 0) {
                        triggerHoldoffCounter--;
                    } else {
                        samplesSinceLastTrigger++;
                        int fire = 0;
                        
                        if (samplesSinceLastTrigger > 5500) {
                            fire = 1;
                        } else {
                            if (isBurstMode) {
                                if (!triggerArmed && decRaw > 0.15f) {
                                    fire = 1;
                                    isBurstMode = 0;
                                }
                            } else {
                                if (!triggerArmed && decRaw < -0.05f) {
                                    triggerArmed = 1;
                                } else if (triggerArmed && decRaw >= 0.0f) {
                                    float prevRaw = scopeRollingRaw[(scopeRollIdx - 2) & 2047];
                                    if (prevRaw < 0.0f) {
                                        fire = 1;
                                        triggerArmed = 0;
                                    }
                                }
                            }
                        }
                        
                        if (fire) {
                            scopeTrigger = 1;
                            scopeCaptureCount = 0;
                            samplesSinceLastTrigger = 0;
                            triggerArmed = 0;
                        }
                    }
                }
                scopeDecimator += 1.0;
            }

            float vScaled = vMeters * G_MeterMPXScale;
            bs412_power += ((vScaled*vScaled) - bs412_power) * bs412_alpha;
            float vPeak = vMeters;
            if (G_EnableMpxLpf) vPeak = BiQuad_Process(&mpxPeakLpf, vPeak);
            float tp = TruePeakN_Process(&tpN, vPeak, G_TruePeakFactor);
            float envPeak = PeakHoldRelease_Process(&mpxEnv, tp);
            MpxDemod_Process(&demod, vMeters);

            counter++;
            if (counter >= outputSampleThreshold) {
                float pScaled = demod.pilotMag * G_MeterPilotScale;
                float rScaled = demod.rdsMag * G_MeterRDSScale;

                smoothP = (smoothP == 0.0f) ? pScaled : (smoothP * 0.90f + pScaled * 0.10f);
                smoothR = (smoothR == 0.0f) ? rScaled : (smoothR * 0.90f + rScaled * 0.10f);
                
                float bs412_dBr = 10.0f * log10f((bs412_power + 1e-12f) / BS412_REF_POWER);
                if (smoothB < -90.0f) smoothB = bs412_dBr; 
                else smoothB = smoothB * 0.98f + bs412_dBr * 0.02f;

                float mFinal = envPeak * G_MeterMPXScale;

                printf("{");
                
                if (spectrumEnabled) {
                    if (fftIndex >= fftSize) {
                        QuickFFT(fftBuf, fftSize);
                        printf("\"s\":[");
                        for (int k = 0; k < maxBin; k++) {
                            float mag = hypotf(fftBuf[k].r, fftBuf[k].i);
                            float linearAmp = (mag * 2.0f) / (float)fftSize;
                            if (linearAmp > smoothBuf[k]) 
                                smoothBuf[k] = smoothBuf[k] * (1.0f - G_SpectrumAttack) + linearAmp * G_SpectrumAttack;
                            else 
                                smoothBuf[k] = smoothBuf[k] * (1.0f - G_SpectrumDecay) + linearAmp * G_SpectrumDecay;
                            printf("%.4f", smoothBuf[k] * 15.0f);
                            if (k < maxBin - 1) printf(",");
                        }
                        printf("],");
                        fftIndex = 0;
                    } else {
                        printf("\"s\":[],");
                    }
                } else {
                    printf("\"s\":[],");
                }
                
                if (scopeEnabled) {
                    printf("\"o\":[");
                    for (int k = 0; k < 1024; k++) {
                        printf("%.4f", scopeOutputBuf[k]);
                        if (k < 1023) printf(",");
                    }
                    printf("],");
                } else {
                    printf("\"o\":[],");
                }

                printf("\"p\":%.4f,\"r\":%.4f,\"m\":%.4f,\"b\":%.4f}\n", smoothP, smoothR, mFinal, smoothB);
                fflush(stdout);
                
                counter = 0;
            }
        }
    }

    fprintf(stderr, "[MPX] Shutting down...\n");
    pthread_join(input_thread_id, NULL);
    
    free(smoothBuf);
    free(window);
    free(fftBuf);
    free(in);
    ringbuffer_destroy(global_ringbuffer);
    
    if (G_UdpSocket != INVALID_SOCKET) close_socket(G_UdpSocket);
    
    fprintf(stderr, "[MPX] Shutdown complete\n");
    return 0;
}