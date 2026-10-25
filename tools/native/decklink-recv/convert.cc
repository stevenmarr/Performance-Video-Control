#include "convert.h"
#include <algorithm>

static inline uint8_t clamp8(int v) {
    return static_cast<uint8_t>(std::max(0, std::min(255, v)));
}

void uyvyToNv12(const uint8_t* src, int srcStride,
                uint8_t* yPlane, int yStride,
                uint8_t* uvPlane, int uvStride,
                int width, int height) {
    if (!src || !yPlane || !uvPlane || width < 2 || height < 2) return;
    for (int y = 0; y + 1 < height; y += 2) {
        const uint8_t* r0 = src + static_cast<size_t>(y) * srcStride;
        const uint8_t* r1 = src + static_cast<size_t>(y + 1) * srcStride;
        uint8_t* y0 = yPlane + static_cast<size_t>(y) * yStride;
        uint8_t* y1 = yPlane + static_cast<size_t>(y + 1) * yStride;
        uint8_t* uv = uvPlane + static_cast<size_t>(y / 2) * uvStride;
        for (int x = 0; x + 1 < width; x += 2) {
            const int u = (r0[0] + r1[0]) / 2;
            const int v = (r0[2] + r1[2]) / 2;
            y0[x] = r0[1];
            y0[x + 1] = r0[3];
            y1[x] = r1[1];
            y1[x + 1] = r1[3];
            uv[x] = static_cast<uint8_t>(u);
            uv[x + 1] = static_cast<uint8_t>(v);
            r0 += 4;
            r1 += 4;
        }
    }
}

void bgraToNv12(const uint8_t* src, int srcStride,
                uint8_t* yPlane, int yStride,
                uint8_t* uvPlane, int uvStride,
                int width, int height) {
    if (!src || !yPlane || !uvPlane || width < 2 || height < 2) return;
    auto yuv = [](int b, int g, int r, int& Y, int& Cb, int& Cr) {
        Y = clamp8(((47 * r + 157 * g + 16 * b + 128) >> 8) + 16);
        Cb = clamp8(((-26 * r - 87 * g + 112 * b + 128) >> 8) + 128);
        Cr = clamp8(((112 * r - 102 * g - 10 * b + 128) >> 8) + 128);
    };
    for (int y = 0; y + 1 < height; y += 2) {
        const uint8_t* r0 = src + static_cast<size_t>(y) * srcStride;
        const uint8_t* r1 = src + static_cast<size_t>(y + 1) * srcStride;
        uint8_t* y0 = yPlane + static_cast<size_t>(y) * yStride;
        uint8_t* y1 = yPlane + static_cast<size_t>(y + 1) * yStride;
        uint8_t* uv = uvPlane + static_cast<size_t>(y / 2) * uvStride;
        for (int x = 0; x + 1 < width; x += 2) {
            int Y00, U00, V00, Y01, U01, V01, Y10, U10, V10, Y11, U11, V11;
            yuv(r0[0], r0[1], r0[2], Y00, U00, V00);
            yuv(r0[4], r0[5], r0[6], Y01, U01, V01);
            yuv(r1[0], r1[1], r1[2], Y10, U10, V10);
            yuv(r1[4], r1[5], r1[6], Y11, U11, V11);
            y0[x] = static_cast<uint8_t>(Y00);
            y0[x + 1] = static_cast<uint8_t>(Y01);
            y1[x] = static_cast<uint8_t>(Y10);
            y1[x + 1] = static_cast<uint8_t>(Y11);
            uv[x] = static_cast<uint8_t>((U00 + U01 + U10 + U11) / 4);
            uv[x + 1] = static_cast<uint8_t>((V00 + V01 + V10 + V11) / 4);
            r0 += 8;
            r1 += 8;
        }
    }
}
