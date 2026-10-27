#include "encode.h"
#include "convert.h"

#include <CoreFoundation/CoreFoundation.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreVideo/CoreVideo.h>
#include <VideoToolbox/VideoToolbox.h>

#include <cstdio>
#include <cstring>
#include <mutex>
#include <vector>

static void writeStartCode(FILE* out) {
    const uint8_t sc[4] = {0, 0, 0, 1};
    fwrite(sc, 1, 4, out);
}

struct AnnexBEncoder::Impl {
    VTCompressionSessionRef session = nullptr;
    int width = 0;
    int height = 0;
    double fps = 30;
    std::atomic<int>* drops = nullptr;
    std::atomic<int> inflight{0};
    std::mutex writeMu;

    static void callback(void* ref, void*, OSStatus status, VTEncodeInfoFlags, CMSampleBufferRef sample) {
        auto* self = static_cast<Impl*>(ref);
        if (self) self->inflight.fetch_sub(1);
        if (status != noErr || !sample || !self) return;
        self->writeSample(sample);
    }

    void writeSample(CMSampleBufferRef sample) {
        std::lock_guard<std::mutex> lock(writeMu);
        FILE* out = stdout;
        CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
        bool key = true;
        if (attachments && CFArrayGetCount(attachments) > 0) {
            CFDictionaryRef dict = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(attachments, 0));
            CFBooleanRef notSync = static_cast<CFBooleanRef>(CFDictionaryGetValue(dict, kCMSampleAttachmentKey_NotSync));
            if (notSync && CFBooleanGetValue(notSync)) key = false;
        }
        if (key) {
            CMFormatDescriptionRef fmt = CMSampleBufferGetFormatDescription(sample);
            size_t count = 0;
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, 0, nullptr, nullptr, &count, nullptr);
            for (size_t i = 0; i < count; i++) {
                const uint8_t* p = nullptr;
                size_t sz = 0;
                if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, i, &p, &sz, nullptr, nullptr) == noErr && p && sz) {
                    writeStartCode(out);
                    fwrite(p, 1, sz, out);
                }
            }
        }
        CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
        if (!block) return;
        size_t total = CMBlockBufferGetDataLength(block);
        std::vector<uint8_t> buf(total);
        if (CMBlockBufferCopyDataBytes(block, 0, total, buf.data()) != kCMBlockBufferNoErr) return;
        size_t nalLen = 4;
        CMVideoFormatDescriptionRef fmt = CMSampleBufferGetFormatDescription(sample);
        int header = 4;
        if (fmt && CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, 0, nullptr, nullptr, nullptr, &header) == noErr && header >= 1 && header <= 4)
            nalLen = static_cast<size_t>(header);
        size_t off = 0;
        while (off + nalLen <= buf.size()) {
            uint32_t len = 0;
            for (size_t i = 0; i < nalLen; i++) len = (len << 8) | buf[off + i];
            off += nalLen;
            if (len == 0 || off + len > buf.size()) break;
            writeStartCode(out);
            fwrite(buf.data() + off, 1, len, out);
            off += len;
        }
        fflush(out);
    }
};

AnnexBEncoder::AnnexBEncoder() : impl_(new Impl) {}
AnnexBEncoder::~AnnexBEncoder() { stop(); delete impl_; }

bool AnnexBEncoder::start(int width, int height, double fps, std::string& err) {
    stop();
    if (width < 2 || height < 2) { err = "bad frame size"; return false; }
    impl_->width = width;
    impl_->height = height;
    impl_->fps = fps > 1 ? fps : 30;
    impl_->drops = &drops_;
    CFMutableDictionaryRef attrs = CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    int fmt = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
    CFNumberRef fmtN = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &fmt);
    CFDictionarySetValue(attrs, kCVPixelBufferPixelFormatTypeKey, fmtN);
    CFRelease(fmtN);
    CFNumberRef wN = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &width);
    CFNumberRef hN = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &height);
    CFDictionarySetValue(attrs, kCVPixelBufferWidthKey, wN);
    CFDictionarySetValue(attrs, kCVPixelBufferHeightKey, hN);
    CFRelease(wN);
    CFRelease(hN);
    CFDictionaryRef io = CFDictionaryCreate(kCFAllocatorDefault, nullptr, nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(attrs, kCVPixelBufferIOSurfacePropertiesKey, io);
    CFRelease(io);

    OSStatus st = VTCompressionSessionCreate(kCFAllocatorDefault, width, height, kCMVideoCodecType_H264,
                                             nullptr, attrs, nullptr, Impl::callback, impl_, &impl_->session);
    CFRelease(attrs);
    if (st != noErr || !impl_->session) { err = "VTCompressionSessionCreate failed"; return false; }

    VTSessionSetProperty(impl_->session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
    VTSessionSetProperty(impl_->session, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
    VTSessionSetProperty(impl_->session, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel);
    int gop = 1; // every frame is a key, so a dropped frame does not freeze the picture
    CFNumberRef gopN = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &gop);
    VTSessionSetProperty(impl_->session, kVTCompressionPropertyKey_MaxKeyFrameInterval, gopN);
    CFRelease(gopN);
    double gap = impl_->fps > 1 ? 1.0 / impl_->fps : 0.016;
    CFNumberRef halfN = CFNumberCreate(kCFAllocatorDefault, kCFNumberDoubleType, &gap);
    VTSessionSetProperty(impl_->session, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, halfN);
    CFRelease(halfN);
    int br = width * height * 20;
    if (br < 12000000) br = 12000000;
    CFNumberRef brN = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &br);
    VTSessionSetProperty(impl_->session, kVTCompressionPropertyKey_AverageBitRate, brN);
    CFRelease(brN);
    CFNumberRef fpsN = CFNumberCreate(kCFAllocatorDefault, kCFNumberDoubleType, &impl_->fps);
    VTSessionSetProperty(impl_->session, kVTCompressionPropertyKey_ExpectedFrameRate, fpsN);
    CFRelease(fpsN);
    VTCompressionSessionPrepareToEncodeFrames(impl_->session);
    return true;
}

void AnnexBEncoder::stop() {
    if (!impl_->session) return;
    VTCompressionSessionCompleteFrames(impl_->session, kCMTimeInvalid);
    VTCompressionSessionInvalidate(impl_->session);
    CFRelease(impl_->session);
    impl_->session = nullptr;
}

bool AnnexBEncoder::encode(const uint8_t* src, int srcStride, int width, int height, bool bgra, int64_t frameIndex) {
    if (!impl_->session || !src) return false;
    if (width != impl_->width || height != impl_->height) return false;
    if (impl_->inflight.load() >= 2) { drops_.fetch_add(1); return false; }
    CVPixelBufferRef pb = nullptr;
    CVPixelBufferPoolRef pool = VTCompressionSessionGetPixelBufferPool(impl_->session);
    if (!pool || CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pb) != kCVReturnSuccess || !pb) {
        drops_.fetch_add(1);
        return false;
    }
    CVPixelBufferLockBaseAddress(pb, 0);
    uint8_t* y = static_cast<uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(pb, 0));
    uint8_t* uv = static_cast<uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(pb, 1));
    const int ys = static_cast<int>(CVPixelBufferGetBytesPerRowOfPlane(pb, 0));
    const int uvs = static_cast<int>(CVPixelBufferGetBytesPerRowOfPlane(pb, 1));
    if (bgra) bgraToNv12(src, srcStride, y, ys, uv, uvs, width, height);
    else uyvyToNv12(src, srcStride, y, ys, uv, uvs, width, height);
    CVPixelBufferUnlockBaseAddress(pb, 0);

    const int32_t scale = static_cast<int32_t>(impl_->fps * 1000);
    CMTime pts = CMTimeMake(frameIndex * 1000, scale > 0 ? scale : 30000);
    CMTime dur = CMTimeMake(1000, scale > 0 ? scale : 30000);
    impl_->inflight.fetch_add(1);
    OSStatus st = VTCompressionSessionEncodeFrame(impl_->session, pb, pts, dur, nullptr, nullptr, nullptr);
    CFRelease(pb);
    if (st != noErr) {
        impl_->inflight.fetch_sub(1);
        drops_.fetch_add(1);
        return false;
    }
    return true;
}
