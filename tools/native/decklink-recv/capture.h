#pragma once
#include <string>
#include <vector>

struct DeckLinkDeviceInfo {
    int index = 0;
    std::string name;
    std::string connections;
    std::string modes;
    bool supportsInput = false;
};

// Fills out. Returns false when Desktop Video did not answer; err explains why.
bool deckLinkList(std::vector<DeckLinkDeviceInfo>& out, std::string& err);

struct CaptureConfig {
    int device = 0;
    std::string mode = "auto";
    std::string connection = "auto";
    bool rawUyvy = false;
};

// Blocks until SIGINT/SIGTERM. Annex-B (or raw UYVY) goes to stdout. Logs go to stderr.
// Returns 0 on a clean stop, 1 on a capture error.
int deckLinkCapture(const CaptureConfig& cfg);
