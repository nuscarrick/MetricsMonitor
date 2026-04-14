/*
 * MPXCapture.cs   High-Performance MPX Analyzer Tool (v2.5a)
 *
 * Features:
 * - DSP chain (19 kHz PLL locked)
 * - Precision Pilot Measurement (IQ demod + RMS)
 * - Precision RDS Measurement (IQ demod + RMS) with Dual-Mode reference
 * - Pilot-present gating
 * - Real-time FFT Spectrum AND Oscilloscope (On-Demand via UDP)
 * - Dynamic Config Reload
 * - MPX TruePeak (Catmull-Rom 4x/8x)
 * - DC Blocker (Robust High-pass, < 1Hz) 
 * - ITU-R BS.412 MPX Power Measurement (60s Integration)
 * - Tilt Correction (Stabilized Linear Gain Method)
 * - Decoupled Spectrum/Meter Calibration
 * - Manual/Auto MPX Channel Selection
 * - Dynamic Scope Amplitude Calibration
 * - UDP Debounce / Watchdog (Prevents Zombie-Process Toggling, Instant OFF)
 * - Double-Buffered Trigger Engine with 128-Sample Pre-Trigger Shift
 *
 * Compile Windows (x64/x86):
 * dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true
 * dotnet publish -c Release -r win-x86 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true
 */

using System;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Globalization;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Text;
using System.Net;
using System.Net.Sockets;
using NAudio.CoreAudioApi;
using NAudio.Wave;

public static class Config
{
    public static volatile float MeterInputCalibrationDB = 0.0f;
    public static volatile float SpectrumInputCalibrationDB = 0.0f;
    public static volatile float ScopeInputCalibrationDB = 0.0f;
    public static volatile float MPXTiltCalibration = 0.0f; 
    
    public static volatile float MeterGain = 1.0f;
    public static volatile float SpectrumGain = 1.0f;
    public static volatile float ScopeGain = 1.0f;

    public static volatile float MeterPilotScale = 1.0f; 
    public static volatile float MeterMPXScale = 100.0f;
    public static volatile float MeterRDSScale = 1.0f;

    public static volatile float SpectrumAttack = 0.25f;
    public static volatile float SpectrumDecay = 0.15f;
    public static volatile int SpectrumSendInterval = 30; 

    public static volatile int TruePeakFactor = 8;
    public static volatile int MPX_LPF_100kHz = 1;
    
    public static volatile string MPXChannel = "auto";

    public static volatile bool EnableSpectrum = false; 
    public static volatile bool EnableScope = false;
    public static DateTime LastSpectrumHeartbeat = DateTime.MinValue;
    public static DateTime LastScopeHeartbeat = DateTime.MinValue;

    private static string _configPath = "metricsmonitor.json";
    private static DateTime _lastModTime;
    
    public static volatile bool ChannelConfigChanged = false;

    public static void Init(string path)
    {
        if (!string.IsNullOrWhiteSpace(path)) _configPath = path.Trim().Trim('"');
        LoadFromFile();
        Task.Run(async () => { while (true) { await Task.Delay(2000); LoadFromFile(); } });
    }

    private static void LoadFromFile()
    {
        if (!File.Exists(_configPath)) return;
        try {
            DateTime mod = File.GetLastWriteTime(_configPath);
            if (mod == _lastModTime) return;
            _lastModTime = mod;
            string jsonString = "";
            for (int i = 0; i < 5; i++) {
                try {
                    using (var fs = new FileStream(_configPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    using (var sr = new StreamReader(fs)) jsonString = sr.ReadToEnd();
                    if (!string.IsNullOrWhiteSpace(jsonString) && jsonString.Trim().Length > 2) break;
                } catch { Thread.Sleep(50); }
            }
            if (string.IsNullOrWhiteSpace(jsonString)) return;

            var options = new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
            using (JsonDocument doc = JsonDocument.Parse(jsonString, options)) {
                var root = doc.RootElement;
                float GetFloat(string k, float def) {
                    if (root.TryGetProperty(k, out var e)) {
                        if (e.ValueKind == JsonValueKind.Number && e.TryGetSingle(out float v)) return v;
                        if (e.ValueKind == JsonValueKind.String && float.TryParse(e.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out float vs)) return vs;
                    } return def;
                }
                int GetInt(string k, int def) => (int)MathF.Round(GetFloat(k, def));
                string GetString(string k, string def) {
                     if (root.TryGetProperty(k, out var e)) if (e.ValueKind == JsonValueKind.String) return e.GetString();
                     return def;
                }

                float mGainDB = GetFloat("MeterInputCalibration", -9999f);
                if (mGainDB > -9000f) { MeterInputCalibrationDB = mGainDB; MeterGain = (float)Math.Pow(10.0, mGainDB / 20.0); }
                float sGainDB = GetFloat("SpectrumInputCalibration", -9999f);
                if (sGainDB > -9000f) { SpectrumInputCalibrationDB = sGainDB; SpectrumGain = (float)Math.Pow(10.0, sGainDB / 20.0); }
                float scopeGainDB = GetFloat("ScopeInputCalibration", -9999f);
                if (scopeGainDB > -9000f) { ScopeInputCalibrationDB = scopeGainDB; ScopeGain = (float)Math.Pow(10.0, scopeGainDB / 20.0); }

                MPXTiltCalibration = GetFloat("MPXTiltCalibration", MPXTiltCalibration);
                MeterPilotScale = GetFloat("MeterPilotScale", MeterPilotScale);
                MeterMPXScale = GetFloat("MeterMPXScale", MeterMPXScale);
                MeterRDSScale = GetFloat("MeterRDSScale", MeterRDSScale);

                float att = GetFloat("SpectrumAttackLevel", -9999f);
                if (att > -9000f) SpectrumAttack = Math.Clamp(att * 0.1f, 0.01f, 1.0f);
                float dec = GetFloat("SpectrumDecayLevel", -9999f);
                if (dec > -9000f) SpectrumDecay = Math.Clamp(dec * 0.01f, 0.01f, 1.0f);
                float interval = GetFloat("SpectrumSendInterval", -9999f);
                if (interval > 0) SpectrumSendInterval = (int)interval;

                int tpf = GetInt("TruePeakFactor", TruePeakFactor);
                if (tpf == 4 || tpf == 8) TruePeakFactor = tpf;
                MPX_LPF_100kHz = GetInt("MPX_LPF_100kHz", MPX_LPF_100kHz) != 0 ? 1 : 0;
                
                string newChannel = GetString("MPXChannel", MPXChannel).ToLowerInvariant();
                if (newChannel != MPXChannel) { MPXChannel = newChannel; ChannelConfigChanged = true; }
            }
        } catch { }
    }
}

public static class DspUtils
{
    public static float ExpAlphaFromTau(float sampleRate, float tauSeconds) {
        if (tauSeconds <= 0f) return 1f;
        return 1f - MathF.Exp(-(1f / sampleRate) / tauSeconds);
    }
    public static float Clamp(float x, float lo, float hi) => (x < lo) ? lo : (x > hi) ? hi : x;
    public static bool IsValid(float x) => !float.IsNaN(x) && !float.IsInfinity(x);
}

public class TiltCorrector
{
    private float yIntegrator; private float gain; private float currentUs; private readonly float sampleRate;
    public TiltCorrector(float sr) { sampleRate = sr; yIntegrator = 0f; gain = 0f; currentUs = 0f; }
    public void Update(float us) {
        if (MathF.Abs(us - currentUs) < 0.1f) return;
        currentUs = us;
        if (MathF.Abs(us) < 1.0f) { gain = 0f; yIntegrator = 0f; } else gain = us * 1.5e-6f;
        yIntegrator = 0f; 
    }
    public float Process(float x) {
        if (MathF.Abs(currentUs) < 1.0f) return x;
        if (!DspUtils.IsValid(x)) return 0f;
        yIntegrator += x * gain;
        yIntegrator -= yIntegrator * 1e-5f;
        if (yIntegrator > 2.0f) yIntegrator = 2.0f; else if (yIntegrator < -2.0f) yIntegrator = -2.0f;
        return x + yIntegrator;
    }
}

public static class QuickFFT
{
    public static void Compute(Complex[] data) {
        int n = data.Length; int m = (int)Math.Log(n, 2); int j = 0; int n2 = n / 2;
        for (int i = 1; i < n - 1; i++) {
            int n1 = n2; while (j >= n1) { j -= n1; n1 >>= 1; }
            j += n1; if (i < j) (data[i], data[j]) = (data[j], data[i]);
        }
        int n1_ = 0; int n2_ = 1;
        for (int i = 0; i < m; i++) {
            n1_ = n2_; n2_ <<= 1; double a = 0.0; double step = -Math.PI / n1_;
            for (j = 0; j < n1_; j++) {
                Complex c = new Complex(Math.Cos(a), Math.Sin(a)); a += step;
                for (int k = j; k < n; k += n2_) {
                    Complex t = c * data[k + n1_]; data[k + n1_] = data[k] - t; data[k] = data[k] + t;
                }
            }
        }
    }
}

public class BiQuadFilter
{
    private float a1, a2, b0, b1, b2; private float x1, x2, y1, y2;
    public static BiQuadFilter BandPass(float sampleRate, float frequency, float q) {
        var f = new BiQuadFilter(); float w0 = 2f * MathF.PI * frequency / sampleRate; float alpha = MathF.Sin(w0) / (2f * q);
        float a0 = 1f + alpha; f.b0 = alpha / a0; f.b1 = 0f; f.b2 = -alpha / a0; f.a1 = (-2f * MathF.Cos(w0)) / a0; f.a2 = (1f - alpha) / a0; return f;
    }
    public static BiQuadFilter LowPass(float sampleRate, float frequency, float q) {
        var f = new BiQuadFilter(); float w0 = 2f * MathF.PI * frequency / sampleRate; float alpha = MathF.Sin(w0) / (2f * q);
        float cosW0 = MathF.Cos(w0); float a0 = 1f + alpha; f.b0 = ((1f - cosW0) * 0.5f) / a0; f.b1 = (1f - cosW0) / a0; f.b2 = ((1f - cosW0) * 0.5f) / a0;
        f.a1 = (-2f * cosW0) / a0; f.a2 = (1f - alpha) / a0; return f;
    }
    public float Process(float x) {
        if (!DspUtils.IsValid(x)) x = 0f;
        float y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        if (!DspUtils.IsValid(y)) { x1=0f; x2=0f; y1=0f; y2=0f; return 0f; }
        x2 = x1; x1 = x; y2 = y1; y1 = y; return y;
    }
}

public class DCBlocker {
    private float x1; private float y1; private readonly float R;
    public DCBlocker() { x1 = 0f; y1 = 0f; R = 0.99995f; }
    public float Process(float x) {
        if (!DspUtils.IsValid(x)) return 0f;
        float y = x - x1 + R * y1;
        if (!DspUtils.IsValid(y)) { x1 = 0f; y1 = 0f; return 0f; }
        x1 = x; y1 = y; return y;
    }
}

public class TruePeakN {
    private float x0, x1, x2, x3; private int warm;
    public void Reset() { x0=x1=x2=x3=0f; warm=0; }
    private static float CatmullRom(float p0, float p1, float p2, float p3, float t) {
        float t2 = t * t; float t3 = t2 * t;
        return 0.5f * ((2f * p1) + (-p0 + p2) * t + (2f * p0 - 5f * p1 + 4f * p2 - p3) * t2 + (-p0 + 3f * p1 - 3f * p2 + p3) * t3);
    }
    public float Process(float x, int factor) {
        if (factor != 8) factor = 4; if (!DspUtils.IsValid(x)) x = 0f;
        if (warm < 4) {
            if (warm == 0) x0=x1=x2=x3=x; else if (warm==1) x1=x2=x3=x; else if (warm==2) x2=x3=x; else x3=x;
            warm++; return MathF.Abs(x);
        }
        x0 = x1; x1 = x2; x2 = x3; x3 = x; float maxAbs = 0f;
        for (int k = 0; k <= factor; k++) {
            float y = CatmullRom(x0, x1, x2, x3, (float)k / factor);
            if (MathF.Abs(y) > maxAbs) maxAbs = MathF.Abs(y);
        } return maxAbs;
    }
}

public class PeakHoldRelease {
    private int holdSamples; private int holdCounter; private float releaseCoef; public float Value { get; private set; }
    public void Init(int sampleRate, float holdMs, float releaseMs) {
        holdSamples = (int)MathF.Max(1f, sampleRate * (holdMs / 1000f));
        releaseCoef = MathF.Exp(-1f / (sampleRate * MathF.Max(0.001f, releaseMs / 1000f))); Value = 0f;
    }
    public float Process(float x) {
        if (!DspUtils.IsValid(x)) x = 0f;
        if (x >= Value) { Value = x; holdCounter = holdSamples; return Value; }
        if (holdCounter > 0) { holdCounter--; return Value; }
        Value *= releaseCoef;
        if (x > Value) { Value = x; holdCounter = holdSamples; } return Value;
    }
}

public class MpxDemodulator {
    private readonly int sr;
    private readonly BiQuadFilter bpf19, bpf57, lpfI_Pilot, lpfQ_Pilot, lpfI_Rds, lpfQ_Rds;
    private float p_phaseRad, p_w0Rad, p_integrator, p_kp, p_ki, p_errLP, p_errAlpha;
    private float r_phaseRad, r_w0Rad, r_integrator, r_kp, r_ki, r_errLP, r_errAlpha;
    private float pilotPow, pilotPowAlpha, mpxPow, mpxPowAlpha, rdsPow, rdsPowAlpha;
    private float meanSqPilot, meanSqRds, rmsAlpha;
    private int pilotPresent, presentCount, absentCount;
    private float rdsRefBlend, blendAlpha;
    public float PilotMag { get; private set; } public float RdsMag { get; private set; }

    public MpxDemodulator(int sampleRate) {
        sr = sampleRate;
        bpf19 = BiQuadFilter.BandPass(sr, 19000f, 20f); bpf57 = BiQuadFilter.BandPass(sr, 57000f, 20f);
        lpfI_Pilot = BiQuadFilter.LowPass(sr, 50f, 0.707f); lpfQ_Pilot = BiQuadFilter.LowPass(sr, 50f, 0.707f);
        lpfI_Rds = BiQuadFilter.LowPass(sr, 2400f, 0.707f); lpfQ_Rds = BiQuadFilter.LowPass(sr, 2400f, 0.707f);
        p_w0Rad = 2f * MathF.PI * 19000f / sr; r_w0Rad = 2f * MathF.PI * 57000f / sr;
        ComputePllGains(sr, 2.0f, 0.707f, out p_kp, out p_ki); ComputePllGains(sr, 2.0f, 0.707f, out r_kp, out r_ki);
        pilotPowAlpha = DspUtils.ExpAlphaFromTau(sr, 0.050f); mpxPowAlpha = DspUtils.ExpAlphaFromTau(sr, 0.100f);
        rdsPowAlpha = DspUtils.ExpAlphaFromTau(sr, 0.050f); p_errAlpha = DspUtils.ExpAlphaFromTau(sr, 0.010f);
        r_errAlpha = DspUtils.ExpAlphaFromTau(sr, 0.010f); rmsAlpha = DspUtils.ExpAlphaFromTau(sr, 0.100f);
        blendAlpha = DspUtils.ExpAlphaFromTau(sr, 0.050f);
        pilotPow = 1e-6f; mpxPow = 1e-6f; rdsPow = 1e-6f; rdsRefBlend = 1.0f;
    }
    private static void ComputePllGains(float sampleRate, float loopBwHz, float zeta, out float kp, out float ki) {
        float T = 1f / sampleRate; float theta = (loopBwHz * T) / (zeta + (0.25f / zeta)); float d = 1f + 2f * zeta * theta + theta * theta;
        kp = ((4f * zeta * theta) / d) / 0.5f; ki = ((4f * theta * theta) / d) / 0.5f;
    }
    private void ResetPilotPll() { p_integrator = 0f; p_errLP = 0f; }
    private void ResetRdsPll()   { r_integrator = 0f; r_errLP = 0f; }

    public void Process(float rawSample) {
        if (!DspUtils.IsValid(rawSample)) rawSample = 0f;
        mpxPow += (rawSample * rawSample - mpxPow) * mpxPowAlpha; float mpxRms = MathF.Sqrt(MathF.Max(mpxPow, 1e-12f));
        float pilotFiltered = bpf19.Process(rawSample); pilotPow += (pilotFiltered * pilotFiltered - pilotPow) * pilotPowAlpha;
        float pilotRms = MathF.Sqrt(MathF.Max(pilotPow, 1e-12f));
        bool presentNow = (mpxRms > 1e-9f) && ((pilotRms / (mpxRms + 1e-9f)) > 0.01f);
        if (presentNow) { presentCount++; absentCount = 0; if (pilotPresent == 0 && presentCount > 2000) { pilotPresent = 1; ResetPilotPll(); r_phaseRad = Wrap2Pi(3f * p_phaseRad); ResetRdsPll(); } } 
        else { absentCount++; presentCount = 0; if (pilotPresent != 0 && absentCount > 8000) { pilotPresent = 0; ResetPilotPll(); ResetRdsPll(); } }
        float p_s = MathF.Sin(p_phaseRad); float p_errNorm = (pilotFiltered * (-p_s)) / (pilotRms + 1e-9f); p_errLP += (p_errNorm - p_errLP) * p_errAlpha;
        if (pilotPresent != 0) { p_integrator += p_ki * p_errLP; float maxPull = 50f * (2f * MathF.PI / sr); p_integrator = DspUtils.Clamp(p_integrator, -maxPull, +maxPull); p_phaseRad = Wrap2Pi(p_phaseRad + p_w0Rad + (p_kp * p_errLP + p_integrator)); } 
        else { p_phaseRad = Wrap2Pi(p_phaseRad + p_w0Rad); meanSqPilot *= 0.9995f; }
        float p_c = MathF.Cos(p_phaseRad); float I_P = lpfI_Pilot.Process(rawSample * p_c); float Q_P = lpfQ_Pilot.Process(rawSample * MathF.Sin(p_phaseRad));
        meanSqPilot += ((I_P * I_P + Q_P * Q_P) - meanSqPilot) * rmsAlpha; PilotMag = (pilotPresent != 0) ? (2.0f * MathF.Sqrt(MathF.Max(meanSqPilot, 0f))) : 0f;

        rdsRefBlend += ((pilotPresent != 0 ? 1f : 0f) - rdsRefBlend) * blendAlpha; float phase57_pilot = Wrap2Pi(3f * p_phaseRad);
        float rdsFiltered57 = bpf57.Process(rawSample); rdsPow += (rdsFiltered57 * rdsFiltered57 - rdsPow) * rdsPowAlpha; float rdsRms = MathF.Sqrt(MathF.Max(rdsPow, 1e-12f));
        if (pilotPresent == 0) { float r_errNorm = (rdsFiltered57 * (-MathF.Sin(r_phaseRad))) / (rdsRms + 1e-9f); r_errLP += (r_errNorm - r_errLP) * r_errAlpha; r_integrator += r_ki * r_errLP; float maxPull = 100f * (2f * MathF.PI / sr); r_integrator = DspUtils.Clamp(r_integrator, -maxPull, +maxPull); r_phaseRad = Wrap2Pi(r_phaseRad + r_w0Rad + (r_kp * r_errLP + r_integrator)); } 
        else { r_phaseRad = phase57_pilot; r_integrator = 0f; r_errLP = 0f; }
        float b = rdsRefBlend; float c57 = b * MathF.Cos(phase57_pilot) + (1f - b) * MathF.Cos(r_phaseRad); float s57 = b * MathF.Sin(phase57_pilot) + (1f - b) * MathF.Sin(r_phaseRad);
        float I_R = lpfI_Rds.Process(rawSample * c57); float Q_R = lpfQ_Rds.Process(rawSample * s57);
        meanSqRds += ((I_R * I_R + Q_R * Q_R) - meanSqRds) * rmsAlpha; RdsMag = 2.0f * 1.4142f * MathF.Sqrt(MathF.Max(meanSqRds, 0f));
    }
    private static float Wrap2Pi(float x) { float twoPi = 2f * MathF.PI; if (x >= twoPi) x -= twoPi; if (x < 0) x += twoPi; if (x >= twoPi || x < 0) x %= twoPi; if (x < 0) x += twoPi; return x; }
}

class Program
{
    const float BASE_PREAMP = 1.0f;
    const double SCOPE_DECIMATION = 5.19; 

    static void Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;

        int requestedSr = 192000;
        if (args.Length >= 1 && int.TryParse(args[0], out int s)) requestedSr = s;

        string devName = (args.Length >= 2 && args[1] != "Default") ? args[1].Trim('"') : "";

        int fftSize = 4096;
        if (args.Length >= 3 && int.TryParse(args[2], out int f)) fftSize = f;
        if ((fftSize & (fftSize - 1)) != 0 || fftSize < 512) fftSize = 4096;

        string cfgPath = (args.Length >= 4) ? args[3] : "metricsmonitor.json";
        Config.Init(cfgPath);

        int udpPort = 60001;
        if (args.Length >= 5 && int.TryParse(args[4], out int u)) udpPort = u;
        
        StartUdpListener(udpPort);

        Console.Error.WriteLine($"[MPX] C# Init RequestedSR:{requestedSr} FFT:{fftSize} Dev:'{devName}' UDP:{udpPort} (Optimized - Shifted Pre-Trigger Scope, Instant OFF)");

        var enumerator = new MMDeviceEnumerator();
        MMDevice device = null;

        if (string.IsNullOrEmpty(devName)) device = enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Multimedia);
        else device = enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active).FirstOrDefault(d => d.FriendlyName.Contains(devName, StringComparison.OrdinalIgnoreCase));

        if (device == null) { Console.Error.WriteLine("[MPX] ERROR: Audio device not found."); return; }

        try
        {
            var requestedFormat = WaveFormat.CreateIeeeFloatWaveFormat(requestedSr, 2);
            var capture = new WasapiCapture(device, false, 60); 

            try { capture.WaveFormat = requestedFormat; }
            catch { Console.Error.WriteLine($"[MPX] WARNING: Could not set {requestedSr} Hz; using device default."); }

            int actualSr = capture.WaveFormat.SampleRate;
            int channels = capture.WaveFormat.Channels;
            bool isFloat = (capture.WaveFormat.Encoding == WaveFormatEncoding.IeeeFloat);
            int bytesPerSample = capture.WaveFormat.BitsPerSample / 8;

            Console.Error.WriteLine($"[MPX] Format: {actualSr} Hz, {channels} ch, {(isFloat ? "Float32" : "PCM")} {capture.WaveFormat.BitsPerSample} bit");

            int sr = actualSr;
            
            Complex[] fftBuffer = new Complex[fftSize];
            float[] window = new float[fftSize];
            float[] smoothSpectrum = new float[fftSize / 2];
            int fftIndex = 0; 
            for (int i = 0; i < fftSize; i++) window[i] = (float)(0.5 * (1.0 - Math.Cos(2.0 * Math.PI * i / (fftSize - 1))));

            // DOUBLE-BUFFERED SHIFTED SCOPE STATE
            const int SCOPE_ROLL_SIZE = 2048;
            float[] scopeRollingBuf = new float[SCOPE_ROLL_SIZE]; 
            float[] scopeRollingRaw = new float[SCOPE_ROLL_SIZE]; 
            float[] scopeOutputBuf  = new float[1024];
            
            long scopeRollIdx = 0;
            int scopeCaptureCount = 0;
            bool scopeTrigger = false;
            double scopeDecimator = 0.0;
            
            bool triggerArmed = false; 
            int silenceSampleCount = 0;
            bool isBurstMode = false;       

            int triggerHoldoffCounter = 0;
            long samplesSinceLastTrigger = 0;
            
            // Flag to track if we have a fresh frame to send
            bool scopeDataUpdated = false;

            var dcBlocker = new DCBlocker();
            var tiltCorrector = new TiltCorrector((float)sr);
            
            const float BS412_REF_POWER = 180.5f;
            float bs412_power = 0.0f;
            float bs412_alpha = DspUtils.ExpAlphaFromTau(sr, 60.0f);

            var demod = new MpxDemodulator(sr);

            float cutoff = 100000f;
            if (cutoff > 0.45f * sr) cutoff = 0.45f * sr;
            var mpxPeakLpf = BiQuadFilter.LowPass(sr, cutoff, 0.707f);

            var truePeak = new TruePeakN();
            truePeak.Reset();

            var env = new PeakHoldRelease();
            env.Init(sr, holdMs: 200f, releaseMs: 1500f);

            int activeChannel = 0;
            bool channelLocked = false;
            double energyL = 0.0, energyR = 0.0;
            int energySamples = 0;

            int samplesSinceLastOutput = 0;
            int outputThresh = (sr * Config.SpectrumSendInterval) / 1000;

            float smoothP = 0f; float smoothR = 0f; float smoothB = -99f;
            double resamplePhase = 0.0;
            double resampleRatio = (requestedSr > 0) ? ((double)actualSr / requestedSr) : 1.0;
            bool doDecimate = (actualSr != requestedSr && requestedSr > 0 && actualSr > requestedSr);

            StringBuilder sb = new StringBuilder(4096);

            capture.DataAvailable += (s, e) =>
            {
                if (Config.ChannelConfigChanged) {
                    channelLocked = false; energySamples = 0; energyL = 0; energyR = 0;
                    Config.ChannelConfigChanged = false;
                    Console.Error.WriteLine($"[MPX] Channel Config Changed -> Resetting detection. New mode: {Config.MPXChannel}");
                }
                
                tiltCorrector.Update(Config.MPXTiltCalibration);
                outputThresh = (sr * Config.SpectrumSendInterval) / 1000;

                int frameSize = channels * bytesPerSample;
                int frames = e.BytesRecorded / frameSize;

                bool enableSpectrum = Config.EnableSpectrum;
                bool enableScope = Config.EnableScope;
                string channelMode = Config.MPXChannel;

                for (int i = 0; i < frames; i++)
                {
                    int offset = i * frameSize;
                    float vL = 0f, vR = 0f;

                    if (isFloat) {
                        vL = BitConverter.ToSingle(e.Buffer, offset);
                        if (channels > 1) vR = BitConverter.ToSingle(e.Buffer, offset + 4);
                    }

                    if (doDecimate) {
                        resamplePhase += 1.0;
                        if (resamplePhase < resampleRatio) continue;
                        resamplePhase -= resampleRatio;
                    }

                    if (channelMode == "left") {
                        activeChannel = 0; channelLocked = true;
                    } else if (channelMode == "right") {
                        activeChannel = 1; channelLocked = true;
                    } else {
                        if (!channelLocked) {
                            energyL += vL * vL; energyR += vR * vR; energySamples++;
                            if (energySamples >= 8192) { activeChannel = (energyR > energyL * 4.0) ? 1 : 0; channelLocked = true; }
                        }
                    }

                    float rawVal = (activeChannel == 1) ? vR : vL;
                    rawVal *= BASE_PREAMP;

                    float vTilt = tiltCorrector.Process(rawVal); 
                    float vMeterCalibrated = vTilt * Config.MeterGain;
                    
                    float signalForPeak = vMeterCalibrated;
                    if (Config.MPX_LPF_100kHz != 0) signalForPeak = mpxPeakLpf.Process(signalForPeak);
                    float peakN = truePeak.Process(signalForPeak, Config.TruePeakFactor);
                    float mpxKhz = peakN * Config.MeterMPXScale;
                    float smoothMpx = env.Process(mpxKhz);

                    float vSpecCalibrated = vTilt * Config.SpectrumGain;
                    float mpxForDemod = dcBlocker.Process(vMeterCalibrated); 
                    demod.Process(mpxForDemod);

                    float mpxSq = signalForPeak * signalForPeak;
                    bs412_power += (mpxSq - bs412_power) * bs412_alpha;
                    float powerDbr = 10f * MathF.Log10((bs412_power + 1e-9f) / (BS412_REF_POWER * BS412_REF_POWER + 1e-9f));
                    if (smoothB < -90f) smoothB = powerDbr; else smoothB = (smoothB * 0.98f) + (powerDbr * 0.02f);

                    float pKhz = demod.PilotMag * Config.MeterPilotScale;
                    if (smoothP == 0f) smoothP = pKhz; else smoothP = (smoothP * 0.9f) + (pKhz * 0.1f);

                    float rKhz = demod.RdsMag * Config.MeterRDSScale;
                    if (smoothR == 0f) smoothR = rKhz; else smoothR = (smoothR * 0.9f) + (rKhz * 0.1f);

                    if (enableSpectrum) {
                        if (fftIndex < fftSize) {
                            fftBuffer[fftIndex] = new Complex(vSpecCalibrated * window[fftIndex], 0);
                            fftIndex++;
                        } else {
                            QuickFFT.Compute(fftBuffer);
                            for (int k = 0; k < fftSize / 2; k++) {
                                float mag = (float)fftBuffer[k].Magnitude;
                                if (mag > smoothSpectrum[k]) smoothSpectrum[k] = (smoothSpectrum[k] * (1f - Config.SpectrumAttack)) + (mag * Config.SpectrumAttack);
                                else smoothSpectrum[k] = (smoothSpectrum[k] * (1f - Config.SpectrumDecay)) + (mag * Config.SpectrumDecay);
                            }
                            fftIndex = 0;
                        }
                    }

                    // === DOUBLE-BUFFERED SHIFTED SCOPE STATE MACHINE ===
                    if (enableScope) {
                        if (scopeDecimator >= SCOPE_DECIMATION) {
                            scopeDecimator -= SCOPE_DECIMATION;
                            
                            float decSample = vTilt * Config.ScopeGain;
                            float decRaw = rawVal;
                            
                            scopeRollingBuf[scopeRollIdx & 2047] = decSample;
                            scopeRollingRaw[scopeRollIdx & 2047] = decRaw;
                            scopeRollIdx++;
                            
                            if (Math.Abs(decRaw) < 0.05f) {
                                if (silenceSampleCount < 500) silenceSampleCount++;
                                if (silenceSampleCount >= 400) isBurstMode = true;
                            } else {
                                silenceSampleCount = 0;
                            }
                            
                            if (scopeTrigger) {
                                scopeCaptureCount++;
                                // 128 samples Pre-Trigger shift
                                if (scopeCaptureCount >= (1024 - 128)) {
                                    long startIdx = scopeRollIdx - 1024;
                                    for (int k = 0; k < 1024; k++) {
                                        scopeOutputBuf[k] = scopeRollingBuf[(startIdx + k) & 2047];
                                    }
                                    scopeTrigger = false;
                                    triggerHoldoffCounter = 300; // Decreased holdoff to allow faster triggering
                                    
                                    // Mark the data as updated so the JSON builder knows
                                    scopeDataUpdated = true;
                                }
                            } else if (triggerHoldoffCounter > 0) {
                                triggerHoldoffCounter--;
                            } else {
                                samplesSinceLastTrigger++;
                                bool fire = false;
                                
                                // Significantly lowered auto-trigger to ~1200 samples (~30 FPS) 
                                // This prevents visual stuttering during total silence.
                                if (samplesSinceLastTrigger > 1200) {
                                    fire = true;
                                } else {
                                    if (isBurstMode) {
                                        if (!triggerArmed && decRaw > 0.02f) { // Lowered burst threshold
                                            fire = true;
                                            isBurstMode = false;
                                        }
                                    } else {
                                        if (!triggerArmed && decRaw < -0.01f) { // Lowered arming threshold
                                            triggerArmed = true;
                                        } else if (triggerArmed && decRaw >= 0.0f) {
                                            float prevRaw = scopeRollingRaw[(scopeRollIdx - 2) & 2047];
                                            if (prevRaw < 0.0f) {
                                                fire = true;
                                                triggerArmed = false;
                                            }
                                        }
                                    }
                                }
                                
                                if (fire) {
                                    scopeTrigger = true;
                                    scopeCaptureCount = 0;
                                    samplesSinceLastTrigger = 0;
                                    triggerArmed = false;
                                }
                            }
                        }
                        scopeDecimator += 1.0;
                    }

                    if (++samplesSinceLastOutput >= outputThresh) {
                        samplesSinceLastOutput = 0;
                        sb.Clear();
                        sb.Append("{\"s\":[");
                        
                        if (enableSpectrum) {
                            for (int k = 0; k < fftSize / 2; k++) {
                                sb.Append((smoothSpectrum[k] * 1.0f).ToString("0.0000", CultureInfo.InvariantCulture));
                                if (k < (fftSize / 2) - 1) sb.Append(",");
                            }
                        }
                        
                        sb.Append("],\"o\":[");
                        
                        // ONLY APPEND ARRAY CONTENT IF SCOPE IS ENABLED AND NEW DATA IS READY
                        if (enableScope && scopeDataUpdated) {
                            for (int k = 0; k < 1024; k++) {
                                sb.Append(scopeOutputBuf[k].ToString("0.0000", CultureInfo.InvariantCulture));
                                if (k < 1023) sb.Append(",");
                            }
                            // Reset flag after sending
                            scopeDataUpdated = false;
                        }
                        
                        sb.Append("],\"p\":"); sb.Append(smoothP.ToString("0.00", CultureInfo.InvariantCulture));
                        sb.Append(",\"r\":"); sb.Append(smoothR.ToString("0.00", CultureInfo.InvariantCulture));
                        sb.Append(",\"m\":"); sb.Append(smoothMpx.ToString("0.00", CultureInfo.InvariantCulture));
                        sb.Append(",\"b\":"); sb.Append(smoothB.ToString("0.00", CultureInfo.InvariantCulture));
                        sb.Append("}");
                        Console.WriteLine(sb.ToString());
                    }
                }
            };

            capture.StartRecording();
            Thread.Sleep(Timeout.Infinite);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[MPX] FATAL ERROR: {ex.Message}");
        }
    }

    static void StartUdpListener(int port)
    {
        Task.Run(async () => {
            while(true) {
                await Task.Delay(1000);
                if (Config.EnableSpectrum && (DateTime.UtcNow - Config.LastSpectrumHeartbeat).TotalSeconds > 3.0) {
                    Config.EnableSpectrum = false; Console.Error.WriteLine("[MPX] Spectrum DISABLED (Timeout/Watchdog)");
                }
                if (Config.EnableScope && (DateTime.UtcNow - Config.LastScopeHeartbeat).TotalSeconds > 3.0) {
                    Config.EnableScope = false; Console.Error.WriteLine("[MPX] Scope DISABLED (Timeout/Watchdog)");
                }
            }
        });

        Task.Run(async () => {
            try {
                using var udp = new UdpClient(port);
                Console.Error.WriteLine($"[MPX] UDP Listener on port {port} - Commands: SPECTRUM=1/0, SCOPE=1/0");
                while (true) {
                    var result = await udp.ReceiveAsync();
                    string command = Encoding.UTF8.GetString(result.Buffer).Trim();
                    
                    // INSTANT UDP OFF/ON (Delay completely removed!)
                    if (command.Contains("SPECTRUM=1")) {
                        Config.LastSpectrumHeartbeat = DateTime.UtcNow;
                        if (!Config.EnableSpectrum) { Config.EnableSpectrum = true; Console.Error.WriteLine("[MPX] Spectrum ENABLED"); }
                    } 
                    else if (command.Contains("SPECTRUM=0")) {
                        if (Config.EnableSpectrum) { Config.EnableSpectrum = false; Console.Error.WriteLine("[MPX] Spectrum DISABLED"); }
                    }
                    
                    if (command.Contains("SCOPE=1")) {
                        Config.LastScopeHeartbeat = DateTime.UtcNow;
                        if (!Config.EnableScope) { Config.EnableScope = true; Console.Error.WriteLine("[MPX] Scope ENABLED"); }
                    } 
                    else if (command.Contains("SCOPE=0")) {
                        if (Config.EnableScope) { Config.EnableScope = false; Console.Error.WriteLine("[MPX] Scope DISABLED"); }
                    }
                }
            } 
            catch (Exception ex) { Console.Error.WriteLine($"[MPX] UDP Listener Error: {ex.Message}"); }
        });
    }
}