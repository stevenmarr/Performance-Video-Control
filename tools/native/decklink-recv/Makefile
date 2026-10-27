# decklink-recv links Blackmagic Desktop Video. Build on macOS only.
#   make
#   The SDK stays at $(HOME)/deck-link-sdk/Blackmagic DeckLink SDK 16.0
#   Override with: make DECKLINK_SDK=/other/path
#
# <string> not found is not the DeckLink SDK. After a macOS update, clang
# prefers a leftover folder at CommandLineTools/usr/include/c++ which no
# longer contains the C++ headers. The real headers are in the Mac SDK.
# -nostdinc++ drops that leftover folder. -isystem adds the one that has <string>.

UNAME_S := $(shell uname -s)
ifneq ($(UNAME_S),Darwin)
$(error decklink-recv links Blackmagic Desktop Video and builds on macOS only (this host is $(UNAME_S)). See README.md. Control Center on Linux or a Pi only relays H.264.)
endif

DECKLINK_SDK ?= $(HOME)/deck-link-sdk/Blackmagic DeckLink SDK 16.0
SDK_INC := $(DECKLINK_SDK)/Mac/include
DISPATCH := $(SDK_INC)/DeckLinkAPIDispatch.cpp

CXX := clang++
SYSROOT := $(shell xcrun --sdk macosx --show-sdk-path 2>/dev/null)
CXX_INC := $(shell for d in \
	"$(SYSROOT)/usr/include/c++/v1" \
	"/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/usr/include/c++/v1" \
	"/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/include/c++/v1" \
	"/Library/Developer/CommandLineTools/usr/include/c++/v1"; do \
	if [ -f "$$d/string" ]; then printf '%s' "$$d"; break; fi; done)

ifeq ($(strip $(SYSROOT)),)
$(error The macOS SDK was not found. The DeckLink SDK is not the problem. Run: xcode-select --install)
endif
ifeq ($(strip $(CXX_INC)),)
$(error C++ headers (<string>) were not found. The DeckLink SDK at $(DECKLINK_SDK) is fine. Reinstall the Command Line Tools: sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install)
endif

CXXFLAGS := -std=c++17 -stdlib=libc++ -nostdinc++ -fno-objc-arc -Wall -Wextra -isysroot "$(SYSROOT)" -isystem "$(CXX_INC)" -I"$(SDK_INC)"
FRAMEWORKS := -framework CoreFoundation -framework Foundation -framework CoreMedia -framework CoreVideo -framework VideoToolbox
SRCS := main.cc capture.mm encode.mm convert.cc
OUT := build/decklink-recv

.PHONY: all clean
all: $(OUT)

$(OUT): $(SRCS)
	@test -f "$(DISPATCH)" || { echo "DeckLink SDK not found at $(SDK_INC). Set DECKLINK_SDK. See README.md."; exit 1; }
	@test -f "$(CXX_INC)/string" || { echo "C++ header <string> is not at $(CXX_INC). The DeckLink SDK is not the problem."; exit 1; }
	mkdir -p build
	$(CXX) $(CXXFLAGS) -o $(OUT) $(SRCS) "$(DISPATCH)" $(FRAMEWORKS) -isysroot "$(SYSROOT)"

clean:
	rm -rf build
