#pragma once
#include <cstddef>
#include <cstdint>

// UYVY (8-bit 4:2:2) -> NV12 (8-bit 4:2:0). width and height are even.
void uyvyToNv12(const uint8_t* src, int srcStride,
                uint8_t* yPlane, int yStride,
                uint8_t* uvPlane, int uvStride,
                int width, int height);

// BGRA -> NV12, BT.709 limited range. Used only if the card will not deliver 8-bit YUV.
void bgraToNv12(const uint8_t* src, int srcStride,
                uint8_t* yPlane, int yStride,
                uint8_t* uvPlane, int uvStride,
                int width, int height);
