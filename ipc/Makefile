CXX ?= g++
CXXFLAGS ?= -O3 -std=c++20 -Wall -Wextra -Wpedantic -Werror
BUILD ?= build
SOURCES = mapping.cpp buffer.cpp sender.cpp receiver.cpp
HEADERS = $(wildcard *.hpp)

.PHONY: all test test64 demo sanitize clean
all: $(BUILD)/demo $(BUILD)/tests

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/%: %.cpp $(SOURCES) $(HEADERS) | $(BUILD)
	$(CXX) $(CXXFLAGS) $(SOURCES) $< -o $@

test: $(BUILD)/tests
	./$(BUILD)/tests

test64:
	$(MAKE) BUILD=build/64 CXXFLAGS='$(CXXFLAGS) -DKNITTING_IPC_QUEUE_SLOTS=64' test

demo: $(BUILD)/demo
	./$(BUILD)/demo

sanitize:
	$(MAKE) BUILD=build/sanitize CXXFLAGS='-O1 -g -std=c++20 -Wall -Wextra -Wpedantic -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie -no-pie' test

clean:
	rm -rf build
