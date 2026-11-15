#include "capture.h"

#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>

static void usage() {
    std::fprintf(stderr,
        "usage:\n"
        "  decklink-recv --list\n"
        "  decklink-recv --device N [--mode auto|1080p5994] [--connection auto|SDI|HDMI] [--raw-uyvy]\n"
        "\n"
        "Writes Annex-B H.264 to stdout. Logs (mode, no-signal, drops) go to stderr.\n"
        "Build notes: tools/native/decklink-recv/README.md\n");
}

int main(int argc, char** argv) {
    bool list = false;
    bool raw = false;
    bool help = false;
    int device = -1;
    std::string mode = "auto";
    std::string connection = "auto";
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto need = [&](const char* flag) -> std::string {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "%s needs a value\n", flag);
                std::exit(2);
            }
            return argv[++i];
        };
        if (a == "--list") list = true;
        else if (a == "--help" || a == "-h") help = true;
        else if (a == "--raw-uyvy") raw = true;
        else if (a == "--device") {
            try { device = std::stoi(need("--device")); }
            catch (...) { std::fprintf(stderr, "--device needs an index\n"); return 2; }
        } else if (a == "--mode") mode = need("--mode");
        else if (a == "--connection") connection = need("--connection");
        else { std::fprintf(stderr, "unknown argument %s\n", a.c_str()); return 2; }
    }
    if (help || argc < 2) { usage(); return help ? 0 : 2; }
    if (list) {
        std::vector<DeckLinkDeviceInfo> devs;
        std::string err;
        if (!deckLinkList(devs, err)) {
            std::fprintf(stderr, "decklink-recv: %s\n", err.c_str());
            return 1;
        }
        std::printf("index\tname\tconnections\tmodes\n");
        for (const auto& d : devs) {
            std::printf("%d\t%s\t%s\t%s\n", d.index, d.name.c_str(), d.connections.c_str(), d.modes.c_str());
        }
        if (devs.empty()) std::fprintf(stderr, "decklink-recv: no Desktop Video devices\n");
        return 0;
    }
    if (device < 0) { usage(); return 2; }
    CaptureConfig cfg;
    cfg.device = device;
    cfg.mode = mode;
    cfg.connection = connection;
    cfg.rawUyvy = raw;
    return deckLinkCapture(cfg);
}
