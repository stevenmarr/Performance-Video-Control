#pragma once
#include <atomic>
#include <string>

// VideoToolbox H.264, Annex-B on stdout. Realtime, no B-frames, GOP about 0.5 s.
class AnnexBEncoder {
public:
    AnnexBEncoder();
    ~AnnexBEncoder();
    bool start(int width, int height, double fps, std::string& err);
    void stop();
    // Copies UYVY (or BGRA when bgra is true) into an NV12 pixel buffer and encodes it.
    // Returns false if the frame was dropped or encode failed.
    bool encode(const uint8_t* src, int srcStride, int width, int height, bool bgra, int64_t frameIndex);
    int drops() const { return drops_.load(); }

private:
    struct Impl;
    Impl* impl_;
    std::atomic<int> drops_{0};
};
