/*
 * MPXCapture.cs   High-Performance MPX Analyzer Tool
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
using System.Text;
using NAudio.CoreAudioApi;
using NAudio.Wave;

// ====================================================================================
//  GLOBAL CONFIG
// ====================================================================================
public static class Config
{
    public static float MeterInputCalibrationDB = 0.0f;
    public static float SpectrumInputCalibrationDB = 0.0f;
    public static float MeterGain = 1.0f;
    public static float SpectrumGain = 1.0f;

    // Calibration/display scales
    public static float MeterPilotScale = 1.0f; 
    public static float MeterMPXScale = 100.0f;
    public static float MeterRDSScale = 1.0f;

    // Spectrum
    public static float SpectrumAttack = 0.25f;
    public static float SpectrumDecay = 0.15f;
    public static int SpectrumSendInterval = 30;

    // Options
    public static int TruePeakFactor = 8;
    public static int MPX_LPF_100kHz = 1;

    private static string _configPath = "metricsmonitor.json";
    private static DateTime _lastModTime;

    public static void Init(string path)
    {
        if (!string.IsNullOrWhiteSpace(path)) 
            _configPath = path.Trim().Trim('"');
        Update(force: true);
    }

    public static void Update(bool force = false)
    {
        if (!File.Exists(_configPath)) return;

        try
        {
            DateTime mod = File.GetLastWriteTime(_configPath);
            if (!force && mod == _lastModTime) return;
            _lastModTime = mod;

            string jsonString = "";
            for (int i = 0; i < 5; i++) {
                try {
                    using (var fs = new FileStream(_configPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    using (var sr = new StreamReader(fs))
                        jsonString = sr.ReadToEnd();
                    if (!string.IsNullOrWhiteSpace(jsonString) && jsonString.Trim().Length > 2) break;
                } catch { Thread.Sleep(50); }
            }

            if (string.IsNullOrWhiteSpace(jsonString)) return;

            var options = new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
            using (JsonDocument doc = JsonDocument.Parse(jsonString, options))
            {
                var root = doc.RootElement;

                float GetFloat(string k, float def) {
                    if (root.TryGetProperty(k, out var e)) {
                        if (e.ValueKind == JsonValueKind.Number && e.TryGetSingle(out float v)) return v;
                        if (e.ValueKind == JsonValueKind.String && float.TryParse(e.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out float vs)) return vs;
                    }
                    return def;
                }

                int GetInt(string k, int def) {
                    float f = GetFloat(k, def);
                    return (int)MathF.Round(f);
                }

                float mGain = GetFloat("MeterInputCalibration", -9999f);
                if (mGain > -9000f) {
                    MeterInputCalibrationDB = mGain;
                    MeterGain = (float)Math.Pow(10.0, mGain / 20.0);
                }

                float sGain = GetFloat("SpectrumInputCalibration", -9999f);
                if (sGain > -9000f) {
                    SpectrumInputCalibrationDB = sGain;
                    SpectrumGain = (float)Math.Pow(10.0, sGain / 20.0);
                }

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

                Console.Error.WriteLine($"[MPX] Config Update ({_configPath}):");
                Console.Error.WriteLine($"   MeterGain: {MeterInputCalibrationDB:F2} dB (x{MeterGain:F6})");
                Console.Error.WriteLine($"   Scales:    Pilot={MeterPilotScale:F4}, MPX={MeterMPXScale:F4}, RDS={MeterRDSScale:F4}");
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[MPX] Config Parse Error: {ex.Message}");
        }
    }
}

// ====================================================================================
//  DSP UTILS
// ====================================================================================
public static class DspUtils
{
    public static float ExpAlphaFromTau(float sampleRate, float tauSeconds)
    {
        if (tauSeconds <= 0f) return 1f;
        float dt = 1f / sampleRate;
        return 1f - MathF.Exp(-(dt / tauSeconds));
    }
    
    public static float Clamp(float x, float lo, float hi) => (x < lo) ? lo : (x > hi) ? hi : x;
}

// ====================================================================================
//  FFT
// ====================================================================================
public static class QuickFFT
{
    public static void Compute(Complex[] data)
    {
        int n = data.Length;
        int m = (int)Math.Log(n, 2);
        int j = 0;
        int n2 = n / 2;
        for (int i = 1; i < n - 1; i++) {
            int n1 = n2;
            while (j >= n1) { j -= n1; n1 >>= 1; }
            j += n1;
            if (i < j) (data[i], data[j]) = (data[j], data[i]);
        }
        int n1_ = 0;
        int n2_ = 1;
        for (int i = 0; i < m; i++) {
            n1_ = n2_;
            n2_ <<= 1;
            double a = 0.0;
            double step = -Math.PI / n1_;
            for (j = 0; j < n1_; j++) {
                Complex c = new Complex(Math.Cos(a), Math.Sin(a));
                a += step;
                for (int k = j; k < n; k += n2_) {
                    Complex t = c * data[k + n1_];
                    data[k + n1_] = data[k] - t;
                    data[k] = data[k] + t;
                }
            }
        }
    }
}

// ====================================================================================
//  BIQUAD FILTER
// ====================================================================================
public class BiQuadFilter
{
    private float a1, a2, b0, b1, b2;
    private float x1, x2, y1, y2;

    public static BiQuadFilter BandPass(float sampleRate, float frequency, float q)
    {
        var f = new BiQuadFilter();
        float w0 = 2f * MathF.PI * frequency / sampleRate;
        float alpha = MathF.Sin(w0) / (2f * q);

        float b0 = alpha; 
        float b1 = 0f; 
        float b2 = -alpha;
        
        float a0 = 1f + alpha;
        float a1 = -2f * MathF.Cos(w0);
        float a2 = 1f - alpha;

        f.b0 = b0 / a0; f.b1 = b1 / a0; f.b2 = b2 / a0;
        f.a1 = a1 / a0; f.a2 = a2 / a0;
        return f;
    }

    public static BiQuadFilter LowPass(float sampleRate, float frequency, float q)
    {
        var f = new BiQuadFilter();
        float w0 = 2f * MathF.PI * frequency / sampleRate;
        float alpha = MathF.Sin(w0) / (2f * q);
        float cosW0 = MathF.Cos(w0);

        float b0 = (1f - cosW0) * 0.5f;
        float b1 = 1f - cosW0;
        float b2 = (1f - cosW0) * 0.5f;
        
        float a0 = 1f + alpha;
        float a1 = -2f * cosW0;
        float a2 = 1f - alpha;

        f.b0 = b0 / a0; f.b1 = b1 / a0; f.b2 = b2 / a0;
        f.a1 = a1 / a0; f.a2 = a2 / a0;
        return f;
    }

    public float Process(float x)
    {
        float y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x;
        y2 = y1; y1 = y;
        return y;
    }
}

// ====================================================================================
//  DC BLOCKER
// ====================================================================================
public class DCBlocker
{
    private float x1;
    private float y1;
    private readonly float R;

    public DCBlocker()
    {
        x1 = 0f;
        y1 = 0f;
        // R = 0.9995 creates a HPF cutoff < 5 Hz at standard rates
        // y[n] = x[n] - x[n-1] + R * y[n-1]
        R = 0.9995f;
    }

    public float Process(float x)
    {
        float y = x - x1 + R * y1;
        x1 = x;
        y1 = y;
        return y;
    }
}

// ====================================================================================
//  TRUEPEAK & ENVELOPE
// ====================================================================================
public class TruePeakN
{
    private float x0, x1, x2, x3;
    private int warm;

    public void Reset() { x0=x1=x2=x3=0f; warm=0; }

    private static float CatmullRom(float p0, float p1, float p2, float p3, float t)
    {
        float t2 = t * t; float t3 = t2 * t;
        return 0.5f * ((2f * p1) + (-p0 + p2) * t + (2f * p0 - 5f * p1 + 4f * p2 - p3) * t2 + (-p0 + 3f * p1 - 3f * p2 + p3) * t3);
    }

    public float Process(float x, int factor)
    {
        if (factor != 8) factor = 4;
        if (warm < 4) {
            if (warm == 0) x0=x1=x2=x3=x; else if (warm==1) x1=x2=x3=x; else if (warm==2) x2=x3=x; else x3=x;
            warm++; return MathF.Abs(x);
        }
        x0 = x1; x1 = x2; x2 = x3; x3 = x;
        float maxAbs = 0f;
        for (int k = 0; k <= factor; k++) {
            float y = CatmullRom(x0, x1, x2, x3, (float)k / factor);
            if (MathF.Abs(y) > maxAbs) maxAbs = MathF.Abs(y);
        }
        return maxAbs;
    }
}

public class PeakHoldRelease
{
    private int holdSamples;
    private int holdCounter;
    private float releaseCoef;
    public float Value { get; private set; }

    public void Init(int sampleRate, float holdMs, float releaseMs) {
        holdSamples = (int)MathF.Max(1f, sampleRate * (holdMs / 1000f));
        float tau = MathF.Max(0.001f, releaseMs / 1000f);
        releaseCoef = MathF.Exp(-1f / (sampleRate * tau));
        Value = 0f;
    }

    public float Process(float x) {
        if (x >= Value) { Value = x; holdCounter = holdSamples; return Value; }
        if (holdCounter > 0) { holdCounter--; return Value; }
        Value *= releaseCoef;
        if (x > Value) { Value = x; holdCounter = holdSamples; }
        return Value;
    }
}

// ====================================================================================
//  MPX DEMODULATOR
// ====================================================================================
public class MpxDemodulator
{
    private readonly int sr;
    private readonly BiQuadFilter bpf19, bpf57;
    private readonly BiQuadFilter lpfI_Pilot, lpfQ_Pilot, lpfI_Rds, lpfQ_Rds;

    // Pilot PLL
    private float p_phaseRad, p_w0Rad, p_integrator, p_kp, p_ki, p_errLP, p_errAlpha;
    // RDS PLL
    private float r_phaseRad, r_w0Rad, r_integrator, r_kp, r_ki, r_errLP, r_errAlpha;
    // Power
    private float pilotPow, pilotPowAlpha, mpxPow, mpxPowAlpha, rdsPow, rdsPowAlpha;
    // RMS
    private float meanSqPilot, meanSqRds, rmsAlpha;
    // State
    private int pilotPresent, presentCount, absentCount;
    private float rdsRefBlend, blendAlpha;

    public float PilotMag { get; private set; }
    public float RdsMag { get; private set; }

    public MpxDemodulator(int sampleRate)
    {
        sr = sampleRate;
        bpf19 = BiQuadFilter.BandPass(sr, 19000f, 20f);
        bpf57 = BiQuadFilter.BandPass(sr, 57000f, 20f);
        lpfI_Pilot = BiQuadFilter.LowPass(sr, 50f, 0.707f);
        lpfQ_Pilot = BiQuadFilter.LowPass(sr, 50f, 0.707f);
        lpfI_Rds = BiQuadFilter.LowPass(sr, 2400f, 0.707f);
        lpfQ_Rds = BiQuadFilter.LowPass(sr, 2400f, 0.707f);

        p_w0Rad = 2f * MathF.PI * 19000f / sr;
        r_w0Rad = 2f * MathF.PI * 57000f / sr;

        ComputePllGains(sr, 2.0f, 0.707f, out p_kp, out p_ki);
        ComputePllGains(sr, 2.0f, 0.707f, out r_kp, out r_ki);

        pilotPowAlpha = DspUtils.ExpAlphaFromTau(sr, 0.050f);
        mpxPowAlpha   = DspUtils.ExpAlphaFromTau(sr, 0.100f);
        rdsPowAlpha   = DspUtils.ExpAlphaFromTau(sr, 0.050f);
        p_errAlpha    = DspUtils.ExpAlphaFromTau(sr, 0.010f);
        r_errAlpha    = DspUtils.ExpAlphaFromTau(sr, 0.010f);
        rmsAlpha      = DspUtils.ExpAlphaFromTau(sr, 0.100f);
        blendAlpha    = DspUtils.ExpAlphaFromTau(sr, 0.050f);

        pilotPow = 1e-6f; mpxPow = 1e-6f; rdsPow = 1e-6f;
        rdsRefBlend = 1.0f;
    }

    private static void ComputePllGains(float sampleRate, float loopBwHz, float zeta, out float kp, out float ki) {
        float T = 1f / sampleRate;
        float theta = (loopBwHz * T) / (zeta + (0.25f / zeta));
        float d = 1f + 2f * zeta * theta + theta * theta;
        float kp0 = (4f * zeta * theta) / d;
        float ki0 = (4f * theta * theta) / d;
        kp = kp0 / 0.5f; ki = ki0 / 0.5f;
    }

    private void ResetPilotPll() { p_integrator = 0f; p_errLP = 0f; }
    private void ResetRdsPll()   { r_integrator = 0f; r_errLP = 0f; }

    public void Process(float rawSample)
    {
        mpxPow += (rawSample * rawSample - mpxPow) * mpxPowAlpha;
        float mpxRms = MathF.Sqrt(MathF.Max(mpxPow, 1e-12f));

        float pilotFiltered = bpf19.Process(rawSample);
        pilotPow += (pilotFiltered * pilotFiltered - pilotPow) * pilotPowAlpha;
        float pilotRms = MathF.Sqrt(MathF.Max(pilotPow, 1e-12f));

        bool presentNow = (mpxRms > 1e-9f) && ((pilotRms / (mpxRms + 1e-9f)) > 0.01f);

        if (presentNow) {
            presentCount++; absentCount = 0;
            if (pilotPresent == 0 && presentCount > 2000) {
                pilotPresent = 1; ResetPilotPll();
                r_phaseRad = Wrap2Pi(3f * p_phaseRad); ResetRdsPll();
            }
        } else {
            absentCount++; presentCount = 0;
            if (pilotPresent != 0 && absentCount > 8000) {
                pilotPresent = 0; ResetPilotPll(); ResetRdsPll();
            }
        }

        // --- PILOT PLL ---
        float p_s = MathF.Sin(p_phaseRad);
        float p_err = pilotFiltered * (-p_s);
        float p_errNorm = p_err / (pilotRms + 1e-9f);

        p_errLP += (p_errNorm - p_errLP) * p_errAlpha;

        if (pilotPresent != 0) {
            p_integrator += p_ki * p_errLP;
            float maxPull = 50f * (2f * MathF.PI / sr);
            p_integrator = DspUtils.Clamp(p_integrator, -maxPull, +maxPull);
            p_phaseRad = Wrap2Pi(p_phaseRad + p_w0Rad + (p_kp * p_errLP + p_integrator));
        } else {
            p_phaseRad = Wrap2Pi(p_phaseRad + p_w0Rad);
            meanSqPilot *= 0.9995f;
        }

        float p_c = MathF.Cos(p_phaseRad);
        float I_P = lpfI_Pilot.Process(rawSample * p_c);
        float Q_P = lpfQ_Pilot.Process(rawSample * MathF.Sin(p_phaseRad));
        meanSqPilot += ((I_P * I_P + Q_P * Q_P) - meanSqPilot) * rmsAlpha;
        PilotMag = (pilotPresent != 0) ? MathF.Sqrt(MathF.Max(meanSqPilot, 0f)) : 0f;

        // --- RDS BLEND ---
        rdsRefBlend += ((pilotPresent != 0 ? 1f : 0f) - rdsRefBlend) * blendAlpha;
        float phase57_pilot = Wrap2Pi(3f * p_phaseRad);

        // --- RDS PLL ---
        float rdsFiltered57 = bpf57.Process(rawSample);
        rdsPow += (rdsFiltered57 * rdsFiltered57 - rdsPow) * rdsPowAlpha;
        float rdsRms = MathF.Sqrt(MathF.Max(rdsPow, 1e-12f));

        if (pilotPresent == 0) {
            float r_err = rdsFiltered57 * (-MathF.Sin(r_phaseRad));
            float r_errNorm = r_err / (rdsRms + 1e-9f);

            r_errLP += (r_errNorm - r_errLP) * r_errAlpha;
            r_integrator += r_ki * r_errLP;
            float maxPull = 100f * (2f * MathF.PI / sr);
            r_integrator = DspUtils.Clamp(r_integrator, -maxPull, +maxPull);
            r_phaseRad = Wrap2Pi(r_phaseRad + r_w0Rad + (r_kp * r_errLP + r_integrator));
        } else {
            r_phaseRad = phase57_pilot; r_integrator = 0f; r_errLP = 0f;
        }

        float b = rdsRefBlend;
        float c57 = b * MathF.Cos(phase57_pilot) + (1f - b) * MathF.Cos(r_phaseRad);
        float s57 = b * MathF.Sin(phase57_pilot) + (1f - b) * MathF.Sin(r_phaseRad);

        float I_R = lpfI_Rds.Process(rawSample * c57);
        float Q_R = lpfQ_Rds.Process(rawSample * s57);
        meanSqRds += ((I_R * I_R + Q_R * Q_R) - meanSqRds) * rmsAlpha;
        RdsMag = MathF.Sqrt(MathF.Max(meanSqRds, 0f));
    }

    private static float Wrap2Pi(float x) {
        float twoPi = 2f * MathF.PI;
        if (x >= twoPi) x -= twoPi; if (x < 0) x += twoPi;
        if (x >= twoPi || x < 0) x %= twoPi;
        if (x < 0) x += twoPi;
        return x;
    }
}

// ====================================================================================
//  MAIN
// ====================================================================================
class Program
{
    const float BASE_PREAMP = 3.0f;

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

        Console.Error.WriteLine($"[MPX] C# Init RequestedSR:{requestedSr} FFT:{fftSize} Dev:'{devName}'");
        Console.Error.WriteLine("[MPX] Features: BS.412 Power, DC Blocker, TruePeak, PLL+IQ");

        var enumerator = new MMDeviceEnumerator();
        MMDevice device = null;

        if (string.IsNullOrEmpty(devName)) {
            device = enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Multimedia);
        } else {
            device = enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active)
                               .FirstOrDefault(d => d.FriendlyName.Contains(devName, StringComparison.OrdinalIgnoreCase));
        }

        if (device == null) { Console.Error.WriteLine("[MPX] ERROR: Audio device not found."); return; }

        try
        {
            var requestedFormat = WaveFormat.CreateIeeeFloatWaveFormat(requestedSr, 2);
            var capture = new WasapiCapture(device, false, 20);

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

            for (int i = 0; i < fftSize; i++)
                window[i] = (float)(0.5 * (1.0 - Math.Cos(2.0 * Math.PI * i / (fftSize - 1))));

            var dcBlocker = new DCBlocker();

            // BS.412
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

            // Channel detection
            int activeChannel = 0;
            bool channelLocked = false;
            double energyL = 0.0, energyR = 0.0;
            int energySamples = 0;

            int fftIndex = 0;
            int counter = 0;
            int configTick = 0;
            int outputThresh = (sr * Config.SpectrumSendInterval) / 1000;

            float smoothP = 0f, smoothR = 0f, smoothB = -99f;

            double resamplePhase = 0.0;
            double resampleRatio = (requestedSr > 0) ? ((double)actualSr / requestedSr) : 1.0;
            bool doDecimate = (actualSr != requestedSr && requestedSr > 0 && actualSr > requestedSr);

            capture.DataAvailable += (s, e) =>
            {
                if (configTick++ > 40) {
                    Config.Update();
                    configTick = 0;
                    outputThresh = (sr * Config.SpectrumSendInterval) / 1000;
                }

                int frameSize = channels * bytesPerSample;
                int frames = e.BytesRecorded / frameSize;

                for (int i = 0; i < frames; i++)
                {
                    int offset = i * frameSize;
                    float vL = 0f, vR = 0f;

                    if (isFloat) {
                        vL = BitConverter.ToSingle(e.Buffer, offset);
                        if (channels > 1) vR = BitConverter.ToSingle(e.Buffer, offset + 4);
                    } else {
                        if (bytesPerSample == 2) {
                            vL = BitConverter.ToInt16(e.Buffer, offset) / 32768f;
                            if (channels > 1) vR = BitConverter.ToInt16(e.Buffer, offset + 2) / 32768f;
                        } else if (bytesPerSample == 3) {
                            int s24L = (e.Buffer[offset] | (e.Buffer[offset+1] << 8) | (e.Buffer[offset+2] << 16));
                            if ((s24L & 0x800000) != 0) s24L |= unchecked((int)0xFF000000);
                            vL = s24L / 8388608f;
                            if (channels > 1) {
                                int o2 = offset + 3;
                                int s24R = (e.Buffer[o2] | (e.Buffer[o2+1] << 8) | (e.Buffer[o2+2] << 16));
                                if ((s24R & 0x800000) != 0) s24R |= unchecked((int)0xFF000000);
                                vR = s24R / 8388608f;
                            }
                        }
                    }

                    if (doDecimate) {
                        resamplePhase += 1.0;
                        if (resamplePhase < resampleRatio) continue;
                        resamplePhase -= resampleRatio;
                    }

                    if (!channelLocked) {
                        energyL += vL * vL; energyR += vR * vR;
                        energySamples++;
                        if (energySamples >= 8192) {
                            activeChannel = (energyR > energyL * 1.5) ? 1 : 0;
                            channelLocked = true;
                            Console.Error.WriteLine($"[MPX] Locked: {(activeChannel == 0 ? "LEFT" : "RIGHT")}");
                        }
                    }

                    float vRaw = (activeChannel == 0 ? vL : vR) * BASE_PREAMP;

                    // --- DC BLOCKER (Pure 1:1, no safety check) ---
                    float v = dcBlocker.Process(vRaw);

                    float vMeters = v * Config.MeterGain;
                    float vSpec = v * Config.SpectrumGain;

                    // --- BS.412 ---
                    float vScaledForPower = vMeters * Config.MeterMPXScale;
                    float pwrInst = vScaledForPower * vScaledForPower;
                    bs412_power += (pwrInst - bs412_power) * bs412_alpha;

                    // --- MPX PEAK ---
                    float vPeak = vMeters;
                    if (Config.MPX_LPF_100kHz != 0) vPeak = mpxPeakLpf.Process(vPeak);
                    float tp = truePeak.Process(vPeak, Config.TruePeakFactor);
                    float envPeak = env.Process(tp);

                    // --- DEMOD ---
                    demod.Process(vMeters);

                    // --- FFT ---
                    if (fftIndex < fftSize) {
                        fftBuffer[fftIndex] = new Complex(vSpec * window[fftIndex], 0.0);
                        fftIndex++;
                    }

                    counter++;
                    if (counter >= outputThresh)
                    {
                        float pScaled = demod.PilotMag * Config.MeterPilotScale;
                        float rScaled = demod.RdsMag * Config.MeterRDSScale;
                        float mScaled = envPeak * Config.MeterMPXScale;
                        
                        float bs412_dBr = 10f * MathF.Log10((bs412_power + 1e-12f) / BS412_REF_POWER);

                        smoothP = (smoothP == 0f) ? pScaled : (smoothP * 0.90f + pScaled * 0.10f);
                        smoothR = (smoothR == 0f) ? rScaled : (smoothR * 0.90f + rScaled * 0.10f);
                        if (smoothB < -90f) smoothB = bs412_dBr; else smoothB = smoothB * 0.98f + bs412_dBr * 0.02f;

                        if (fftIndex >= fftSize)
                        {
                            QuickFFT.Compute(fftBuffer);

                            int maxBin = (int)((100000.0 / (sr / 2.0)) * (fftSize / 2.0));
                            if (maxBin > fftSize / 2) maxBin = fftSize / 2;
                            if (maxBin < 10) maxBin = 10;

                            var sb = new StringBuilder(maxBin * 8 + 128);
                            sb.Append("{\"p\":");
                            sb.Append(smoothP.ToString("F4", CultureInfo.InvariantCulture));
                            sb.Append(",\"r\":");
                            sb.Append(smoothR.ToString("F4", CultureInfo.InvariantCulture));
                            sb.Append(",\"m\":");
                            sb.Append(mScaled.ToString("F4", CultureInfo.InvariantCulture));
                            sb.Append(",\"b\":");
                            sb.Append(smoothB.ToString("F4", CultureInfo.InvariantCulture));
                            sb.Append(",\"s\":[");

                            for (int k = 0; k < maxBin; k++)
                            {
                                float mag = (float)fftBuffer[k].Magnitude;
                                float lin = (mag * 2.0f) / fftSize;
                                if (lin > smoothSpectrum[k])
                                    smoothSpectrum[k] = smoothSpectrum[k] * (1f - Config.SpectrumAttack) + lin * Config.SpectrumAttack;
                                else
                                    smoothSpectrum[k] = smoothSpectrum[k] * (1f - Config.SpectrumDecay) + lin * Config.SpectrumDecay;

                                if (k > 0) sb.Append(',');
                                sb.Append((smoothSpectrum[k] * 15.0f).ToString("F4", CultureInfo.InvariantCulture));
                            }
                            sb.Append("]}");
                            Console.WriteLine(sb.ToString());
                            fftIndex = 0;
                        }
                        counter = 0;
                    }
                }
            };

            capture.StartRecording();
            Thread.Sleep(Timeout.Infinite);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[MPX] FATAL: {ex}");
        }
    }
}