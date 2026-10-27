# decklink-recv links Blackmagic Desktop Video. Build on macOS only.
#   make
#   The SDK stays at $(HOME)/deck-link-sdk/Blackmagic DeckLink SDK 16.0
#   Override with: make DECKLINK_SDK=/other/path

UNAME_S := $(shell uname -s)
ifneq ($(UNAME_S),Darwin)
$(error decklink-recv links Blackmagic Desktop Video and builds on macOS only (this host is $(UNAME_S)). See README.md. Control Center on Linux or a Pi only relays H.264.)
endif

DECKLINK_SDK ?= $(HOME)/deck-link-sdk/Blackmagic DeckLink SDK 16.0
SDK_INC := $(DECKLINK_SDK)/Mac/include
DISPATCH := $(SDK_INC)/DeckLinkAPIDispatch.cpp

CXX := clang++
SYSROOT := $(shell xcrun --sdk macosx --show-sdk-path 2>/dev/null)
ifeq ($(strip $(SYSROOT)),)
$(error The macOS SDK was not found, so clang cannot see the C++ headers. Run: xcode-select --install)
endif
CXXFLAGS := -std=c++17 -stdlib=libc++ -fno-objc-arc -Wall -Wextra -isysroot "$(SYSROOT)" -I"$(SDK_INC)"
FRAMEWORKS := -framework CoreFoundation -framework Foundation -framework CoreMedia -framework CoreVideo -framework VideoToolbox
SRCS := main.cc capture.mm encode.mm convert.cc
OUT := build/decklink-recv

.PHONY: all clean
all: $(OUT)

$(OUT): $(SRCS)
	@test -f "$(DISPATCH)" || { echo "DeckLink SDK not found at $(SDK_INC). Set DECKLINK_SDK. See README.md."; exit 1; }
	mkdir -p build
	$(CXX) $(CXXFLAGS) -o $(OUT) $(SRCS) "$(DISPATCH)" $(FRAMEWORKS) -isysroot "$(SYSROOT)"

clean:
	rm -rf build
