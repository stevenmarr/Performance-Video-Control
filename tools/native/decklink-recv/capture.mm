// DeckLink input, shaped like the Mac Capture Preview sample (discovery, format
// detection, VideoInputFrameArrived) without the Cocoa preview window.
// Headers come from the local DeckLink SDK. They are not in this repo.
#include "capture.h"
#include "encode.h"

#include "DeckLinkAPI.h"

#include <CoreFoundation/CoreFoundation.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <csignal>
#include <string>
#include <unistd.h>
#include <vector>

static std::atomic<int> g_stop{0};
static void onSignal(int) { g_stop.store(1); }

static void logLine(const char* msg) { std::fprintf(stderr, "decklink-recv: %s\n", msg); }

static std::string cfToUtf8(CFStringRef s) {
    if (!s) return "";
    char buf[512];
    if (CFStringGetCString(s, buf, sizeof(buf), kCFStringEncodingUTF8)) return buf;
    return "";
}

static std::string sanitize(std::string s) {
    for (char& c : s) if (c == '\t' || c == '\n' || c == '\r') c = ' ';
    return s;
}

static bool iidIs(REFIID a, REFIID b) { return std::memcmp(&a, &b, sizeof(REFIID)) == 0; }

static bool iidIsUnknown(REFIID iid) {
    if (sizeof(REFIID) == sizeof(CFUUIDBytes)) {
        CFUUIDBytes u = CFUUIDGetUUIDBytes(IUnknownUUID);
        return std::memcmp(&iid, &u, sizeof(u)) == 0;
    }
    return iidIs(iid, static_cast<REFIID>(IUnknownUUID));
}

struct ModeName { const char* name; BMDDisplayMode mode; };
static const ModeName kModes[] = {
    {"ntsc", bmdModeNTSC}, {"pal", bmdModePAL},
    {"1080p2398", bmdModeHD1080p2398}, {"1080p24", bmdModeHD1080p24},
    {"1080p25", bmdModeHD1080p25}, {"1080p2997", bmdModeHD1080p2997}, {"1080p30", bmdModeHD1080p30},
    {"1080p50", bmdModeHD1080p50}, {"1080p5994", bmdModeHD1080p5994}, {"1080p60", bmdModeHD1080p6000},
    {"1080i50", bmdModeHD1080i50}, {"1080i5994", bmdModeHD1080i5994}, {"1080i60", bmdModeHD1080i6000},
    {"720p50", bmdModeHD720p50}, {"720p5994", bmdModeHD720p5994}, {"720p60", bmdModeHD720p60},
};

static bool lookupMode(const std::string& name, BMDDisplayMode& out) {
    for (const auto& m : kModes) if (name == m.name) { out = m.mode; return true; }
    return false;
}

static std::string modeLabel(IDeckLinkDisplayMode* mode) {
    CFStringRef name = nullptr;
    std::string text;
    if (mode->GetName(&name) == S_OK && name) { text = cfToUtf8(name); CFRelease(name); }
    if (!text.empty()) return text;
    BMDTimeValue dur = 0; BMDTimeScale scale = 0;
    mode->GetFrameRate(&dur, &scale);
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%ldx%ld", mode->GetWidth(), mode->GetHeight());
    return buf;
}

static std::string connectionList(int64_t bits) {
    struct Item { BMDVideoConnection bit; const char* name; };
    const Item items[] = {
        {bmdVideoConnectionSDI, "SDI"}, {bmdVideoConnectionHDMI, "HDMI"},
        {bmdVideoConnectionOpticalSDI, "OpticalSDI"}, {bmdVideoConnectionComponent, "Component"},
        {bmdVideoConnectionComposite, "Composite"}, {bmdVideoConnectionSVideo, "SVideo"},
    };
    std::string out;
    for (const auto& it : items) {
        if (bits & it.bit) { if (!out.empty()) out += ','; out += it.name; }
    }
    return out.empty() ? "auto" : out;
}

static bool connectionBit(const std::string& name, int64_t& bit) {
    if (name == "SDI" || name == "sdi") { bit = bmdVideoConnectionSDI; return true; }
    if (name == "HDMI" || name == "hdmi") { bit = bmdVideoConnectionHDMI; return true; }
    if (name == "OpticalSDI") { bit = bmdVideoConnectionOpticalSDI; return true; }
    return false;
}

class InputCallback : public IDeckLinkInputCallback {
public:
    explicit InputCallback(class CaptureSession* owner) : ref_(1), owner_(owner) {}
    HRESULT QueryInterface(REFIID iid, LPVOID* ppv) override {
        if (!ppv) return E_POINTER;
        if (iidIsUnknown(iid) || iidIs(iid, IID_IDeckLinkInputCallback)) { *ppv = this; AddRef(); return S_OK; }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG AddRef() override { return ++ref_; }
    ULONG Release() override { ULONG n = --ref_; if (!n) delete this; return n; }
    HRESULT VideoInputFormatChanged(BMDVideoInputFormatChangedEvents events, IDeckLinkDisplayMode* mode, BMDDetectedVideoInputFormatFlags flags) override;
    HRESULT VideoInputFrameArrived(IDeckLinkVideoInputFrame* frame, IDeckLinkAudioInputPacket*) override;

private:
    std::atomic<ULONG> ref_;
    CaptureSession* owner_;
};

class CaptureSession {
public:
    IDeckLink* device = nullptr;
    IDeckLinkInput* input = nullptr;
    InputCallback* callback = nullptr;
    AnnexBEncoder encoder;
    bool raw = false;
    bool detect = true;
    bool bgra = false;
    int width = 0;
    int height = 0;
    double fps = 30;
    int64_t frames = 0;
    bool loggedNoSignal = false;
    bool encoderReady = false;
    std::string err;

    void applyMode(IDeckLinkDisplayMode* mode) {
        width = static_cast<int>(mode->GetWidth());
        height = static_cast<int>(mode->GetHeight());
        BMDTimeValue dur = 0; BMDTimeScale scale = 0;
        if (mode->GetFrameRate(&dur, &scale) == S_OK && dur > 0) fps = static_cast<double>(scale) / static_cast<double>(dur);
        else fps = 30;
        char buf[160];
        std::snprintf(buf, sizeof(buf), "signal %s %dx%d %.3f fps", modeLabel(mode).c_str(), width, height, fps);
        logLine(buf);
        if (!raw) {
            encoder.stop();
            encoderReady = encoder.start(width, height, fps, err);
            if (!encoderReady) logLine(err.c_str());
        }
    }

    HRESULT onFormat(BMDVideoInputFormatChangedEvents events, IDeckLinkDisplayMode* mode, BMDDetectedVideoInputFormatFlags) {
        if (!(events & (bmdVideoInputDisplayModeChanged | bmdVideoInputColorspaceChanged))) return S_OK;
        if (!input || !mode) return S_OK;
        input->PauseStreams();
        applyMode(mode);
        BMDVideoInputFlags vif = detect ? bmdVideoInputEnableFormatDetection : bmdVideoInputFlagDefault;
        bgra = false;
        HRESULT hr = input->EnableVideoInput(mode->GetDisplayMode(), bmdFormat8BitYUV, vif);
        if (FAILED(hr)) {
            hr = input->EnableVideoInput(mode->GetDisplayMode(), bmdFormat8BitBGRA, vif);
            bgra = SUCCEEDED(hr);
            if (bgra) logLine("8-bit YUV refused; capturing BGRA and converting");
        }
        if (FAILED(hr)) { logLine("EnableVideoInput failed after format change"); g_stop.store(1); return hr; }
        input->FlushStreams();
        input->StartStreams();
        return S_OK;
    }

    HRESULT onFrame(IDeckLinkVideoInputFrame* frame) {
        if (!frame || g_stop.load()) return S_OK;
        if (frame->GetFlags() & bmdFrameHasNoInputSource) {
            if (!loggedNoSignal) { logLine("no input signal"); loggedNoSignal = true; }
            return S_OK;
        }
        loggedNoSignal = false;
        void* bytes = nullptr;
        if (frame->GetBytes(&bytes) != S_OK || !bytes) return S_OK;
        const int w = static_cast<int>(frame->GetWidth());
        const int h = static_cast<int>(frame->GetHeight());
        const int row = static_cast<int>(frame->GetRowBytes());
        const BMDPixelFormat pf = frame->GetPixelFormat();
        if (raw) {
            if (pf != bmdFormat8BitYUV) { logLine("raw mode wants 8-bit UYVY"); return S_OK; }
            for (int y = 0; y < h; y++) {
                const auto* rowp = static_cast<const uint8_t*>(bytes) + static_cast<size_t>(y) * row;
                fwrite(rowp, 1, static_cast<size_t>(w) * 2, stdout);
            }
            fflush(stdout);
            return S_OK;
        }
        const bool useBgra = pf == bmdFormat8BitBGRA || (pf != bmdFormat8BitYUV && bgra);
        if (pf != bmdFormat8BitYUV && pf != bmdFormat8BitBGRA) {
            logLine("skipping a frame that is not 8-bit YUV or BGRA");
            return S_OK;
        }
        if (!encoderReady || w != width || h != height) {
            width = w; height = h;
            encoderReady = encoder.start(w, h, fps, err);
            if (!encoderReady) return S_OK;
        }
        encoder.encode(static_cast<const uint8_t*>(bytes), row, w, h, useBgra, frames++);
        return S_OK;
    }

    void shutdown() {
        if (input) {
            input->StopStreams();
            input->DisableVideoInput();
            input->SetCallback(nullptr);
        }
        encoder.stop();
        if (callback) { callback->Release(); callback = nullptr; }
        if (input) { input->Release(); input = nullptr; }
        if (device) { device->Release(); device = nullptr; }
    }
};

HRESULT InputCallback::VideoInputFormatChanged(BMDVideoInputFormatChangedEvents events, IDeckLinkDisplayMode* mode, BMDDetectedVideoInputFormatFlags flags) {
    return owner_ ? owner_->onFormat(events, mode, flags) : S_OK;
}
HRESULT InputCallback::VideoInputFrameArrived(IDeckLinkVideoInputFrame* frame, IDeckLinkAudioInputPacket*) {
    return owner_ ? owner_->onFrame(frame) : S_OK;
}

static IDeckLinkIterator* openIterator(std::string& err) {
    IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
    if (!it) err = "Desktop Video is not available (CreateDeckLinkIteratorInstance returned null). Install Blackmagic Desktop Video and allow the driver in System Settings → Privacy & Security.";
    return it;
}

bool deckLinkList(std::vector<DeckLinkDeviceInfo>& out, std::string& err) {
    IDeckLinkIterator* it = openIterator(err);
    if (!it) return false;
    IDeckLink* dev = nullptr;
    int index = 0;
    while (it->Next(&dev) == S_OK) {
        DeckLinkDeviceInfo info;
        info.index = index++;
        CFStringRef name = nullptr;
        if (dev->GetDisplayName(&name) == S_OK && name) { info.name = sanitize(cfToUtf8(name)); CFRelease(name); }
        if (info.name.empty()) info.name = "DeckLink";
        IDeckLinkProfileAttributes* attrs = nullptr;
        if (dev->QueryInterface(IID_IDeckLinkProfileAttributes, reinterpret_cast<void**>(&attrs)) == S_OK && attrs) {
            int64_t bits = 0;
            if (attrs->GetInt(BMDDeckLinkVideoInputConnections, &bits) == S_OK) info.connections = connectionList(bits);
            bool detect = false;
            attrs->GetFlag(BMDDeckLinkSupportsInputFormatDetection, &detect);
            (void)detect;
            attrs->Release();
        }
        IDeckLinkInput* input = nullptr;
        if (dev->QueryInterface(IID_IDeckLinkInput, reinterpret_cast<void**>(&input)) == S_OK && input) {
            info.supportsInput = true;
            IDeckLinkDisplayModeIterator* modes = nullptr;
            if (input->GetDisplayModeIterator(&modes) == S_OK && modes) {
                IDeckLinkDisplayMode* mode = nullptr;
                while (modes->Next(&mode) == S_OK) {
                    std::string label = sanitize(modeLabel(mode));
                    if (!label.empty()) {
                        if (!info.modes.empty()) info.modes += ',';
                        info.modes += label;
                    }
                    mode->Release();
                }
                modes->Release();
            }
            input->Release();
        }
        if (info.connections.empty()) info.connections = "-";
        out.push_back(info);
        dev->Release();
    }
    it->Release();
    return true;
}

int deckLinkCapture(const CaptureConfig& cfg) {
    std::string err;
    IDeckLinkIterator* it = openIterator(err);
    if (!it) { logLine(err.c_str()); return 1; }
    IDeckLink* dev = nullptr;
    int index = 0;
    IDeckLink* chosen = nullptr;
    while (it->Next(&dev) == S_OK) {
        if (index == cfg.device) chosen = dev;
        else dev->Release();
        index++;
    }
    it->Release();
    if (!chosen) { logLine("device index is out of range (see --list)"); return 1; }

    CaptureSession session;
    session.device = chosen;
    session.raw = cfg.rawUyvy;
    session.detect = cfg.mode == "auto" || cfg.mode.empty();
    if (session.device->QueryInterface(IID_IDeckLinkInput, reinterpret_cast<void**>(&session.input)) != S_OK || !session.input) {
        logLine("this Desktop Video device has no input");
        session.device->Release();
        session.device = nullptr;
        return 1;
    }
    if (cfg.connection != "auto" && !cfg.connection.empty()) {
        int64_t bit = 0;
        if (!connectionBit(cfg.connection, bit)) { logLine("connection must be auto, SDI, or HDMI"); session.shutdown(); return 2; }
        IDeckLinkConfiguration* conf = nullptr;
        if (session.device->QueryInterface(IID_IDeckLinkConfiguration, reinterpret_cast<void**>(&conf)) == S_OK && conf) {
            if (FAILED(conf->SetInt(bmdDeckLinkConfigVideoInputConnection, bit))) logLine("could not set the input connection");
            conf->Release();
        }
    }
    BMDDisplayMode mode = bmdModeHD1080p5994;
    if (!session.detect && !lookupMode(cfg.mode, mode)) {
        logLine("unknown --mode (try auto, 1080p5994, 1080p50, 720p5994)");
        session.shutdown();
        return 2;
    }
    session.callback = new InputCallback(&session);
    session.input->SetCallback(session.callback);
    BMDVideoInputFlags flags = session.detect ? bmdVideoInputEnableFormatDetection : bmdVideoInputFlagDefault;
    HRESULT hr = session.input->EnableVideoInput(mode, bmdFormat8BitYUV, flags);
    if (FAILED(hr)) {
        logLine("EnableVideoInput failed. Another app (Playout output) may own this device, or the mode is unsupported.");
        session.shutdown();
        return 1;
    }
    hr = session.input->StartStreams();
    if (FAILED(hr)) { logLine("StartStreams failed"); session.shutdown(); return 1; }
    logLine(session.detect ? "capturing (auto format detection, initial 1080p5994)" : "capturing locked mode");
    if (session.raw) logLine("raw uyvy422 on stdout");

    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);
    while (!g_stop.load()) usleep(50000);
    const int dropped = session.encoder.drops();
    if (dropped) std::fprintf(stderr, "decklink-recv: dropped %d frames\n", dropped);
    session.shutdown();
    return 0;
}
