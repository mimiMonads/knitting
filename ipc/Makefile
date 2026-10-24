CXX ?= g++
AR ?= ar
CXXFLAGS ?= -O3 -std=c++20 -Wall -Wextra -Wpedantic -Werror
QUEUE_SLOTS ?= 32
BUILD ?= build

ifeq ($(filter $(QUEUE_SLOTS),32 64),)
$(error QUEUE_SLOTS must be 32 or 64)
endif
ifneq ($(words $(QUEUE_SLOTS)),1)
$(error QUEUE_SLOTS must be a single value)
endif

IPC_CPPFLAGS = -I. -DKNITTING_IPC_QUEUE_SLOTS=$(QUEUE_SLOTS)
SOURCES = mapping.cpp buffer.cpp sender.cpp receiver.cpp
OBJECTS = $(SOURCES:%.cpp=$(BUILD)/%.o)
LIBRARY = $(BUILD)/libknitting_ipc.a
SANITIZER_FLAGS = -O1 -g -std=c++20 -Wall -Wextra -Wpedantic -Werror \
	-fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie -no-pie

.PHONY: all test test64 demo check headers headers64 sanitize sanitize64 clean FORCE
all: $(LIBRARY) $(BUILD)/demo $(BUILD)/tests

$(BUILD) $(BUILD)/benchmarks:
	mkdir -p $@

# Flag changes invalidate objects even when their source timestamps are unchanged.
$(BUILD)/.config: FORCE | $(BUILD)
	@printf '%s\n' '$(CXX)' '$(CPPFLAGS)' '$(IPC_CPPFLAGS)' '$(CXXFLAGS)' '$(LDFLAGS)' '$(LDLIBS)' > $@.tmp
	@if ! cmp -s $@.tmp $@; then mv $@.tmp $@; else rm $@.tmp; fi

$(BUILD)/%.o: %.cpp $(BUILD)/.config | $(BUILD)
	$(CXX) $(CPPFLAGS) $(IPC_CPPFLAGS) $(CXXFLAGS) -MMD -MP -c $< -o $@

$(BUILD)/benchmarks/%.o: benchmarks/%.cpp $(BUILD)/.config | $(BUILD)/benchmarks
	$(CXX) $(CPPFLAGS) $(IPC_CPPFLAGS) $(CXXFLAGS) -MMD -MP -c $< -o $@

$(LIBRARY): $(OBJECTS)
	$(AR) rcs $@ $^

$(BUILD)/demo: $(BUILD)/demo.o $(LIBRARY)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) $^ $(LDLIBS) -o $@

$(BUILD)/tests: $(BUILD)/tests.o $(LIBRARY)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) $^ $(LDLIBS) -o $@

$(BUILD)/benchmark: $(BUILD)/benchmarks/benchmark.o $(BUILD)/benchmarks/checksum.o $(LIBRARY)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) $^ $(LDLIBS) -o $@

test: $(BUILD)/tests
	./$(BUILD)/tests

test64:
	$(MAKE) BUILD=build/64 QUEUE_SLOTS=64 test

demo: $(BUILD)/demo
	./$(BUILD)/demo

headers:
	@for header in *.hpp; do \
		printf '#include "%s"\n' "$$header" | \
		$(CXX) $(CPPFLAGS) $(IPC_CPPFLAGS) $(CXXFLAGS) -x c++ -fsyntax-only - || exit 1; \
	done

headers64:
	$(MAKE) BUILD=build/64 QUEUE_SLOTS=64 headers

check: test test64 headers headers64

# Non-PIE avoids sanitizer startup faults observed on the development host.
sanitize:
	$(MAKE) BUILD=build/sanitize/$(QUEUE_SLOTS) CXXFLAGS='$(SANITIZER_FLAGS)' test

sanitize64:
	$(MAKE) QUEUE_SLOTS=64 sanitize

clean:
	rm -rf build

-include $(OBJECTS:.o=.d) $(BUILD)/demo.d $(BUILD)/tests.d \
	$(BUILD)/benchmarks/benchmark.d $(BUILD)/benchmarks/checksum.d
