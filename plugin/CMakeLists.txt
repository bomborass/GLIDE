cmake_minimum_required(VERSION 3.22)

# macOS: one universal build for Apple Silicon and Intel, running on macOS 11+
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS version")
if(APPLE AND NOT CMAKE_OSX_ARCHITECTURES)
    set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "" FORCE)
endif()

project(SLIDE VERSION 0.1.0 LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# JUCE: a local checkout (-DJUCE_DIR=...) or fetched from GitHub
if(DEFINED JUCE_DIR)
    add_subdirectory(${JUCE_DIR} juce)
else()
    include(FetchContent)
    FetchContent_Declare(juce
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG 8.0.4
        GIT_SHALLOW TRUE)
    FetchContent_MakeAvailable(juce)
endif()

# the web UI, built by `npm run build` in ../ui
set(SLIDE_UI_HTML "${CMAKE_CURRENT_SOURCE_DIR}/../ui/dist/index.html" CACHE FILEPATH "Built UI page")
if(NOT EXISTS ${SLIDE_UI_HTML})
    message(FATAL_ERROR "Build the UI first: cd ui && npm ci && npm run build")
endif()

set(SLIDE_FORMATS VST3 Standalone)
if(APPLE)
    list(APPEND SLIDE_FORMATS AU)
endif()

juce_add_plugin(SLIDE
    COMPANY_NAME "SLIDE"
    BUNDLE_ID com.slide.slide
    PLUGIN_MANUFACTURER_CODE Sldx
    PLUGIN_CODE Sld1
    FORMATS ${SLIDE_FORMATS}
    PRODUCT_NAME "SLIDE"
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT TRUE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    NEEDS_WEB_BROWSER TRUE
    VST3_CATEGORIES Instrument Synth
    AU_MAIN_TYPE kAudioUnitType_MusicDevice
    COPY_PLUGIN_AFTER_BUILD FALSE)

juce_add_binary_data(SLIDEUi SOURCES ${SLIDE_UI_HTML})
set_target_properties(SLIDEUi PROPERTIES POSITION_INDEPENDENT_CODE ON)

target_sources(SLIDE PRIVATE
    Source/Clip.cpp
    Source/PluginCatalog.cpp
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp)

target_compile_definitions(SLIDE PUBLIC
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_AU=1
    JUCE_PLUGINHOST_LADSPA=0
    JUCE_PLUGINHOST_LV2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0)

target_link_libraries(SLIDE
    PRIVATE
        SLIDEUi
        juce::juce_audio_utils
        juce::juce_audio_processors
        juce::juce_audio_formats
        juce::juce_gui_extra
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)

# headless check of the engine: plays the demo clip through the processor
option(SLIDE_TESTS "Build the engine test" OFF)
if(SLIDE_TESTS)
    juce_add_console_app(SlideTest PRODUCT_NAME "SlideTest" NEEDS_WEB_BROWSER TRUE)
    target_sources(SlideTest PRIVATE test/EngineTest.cpp
        Source/Clip.cpp Source/PluginCatalog.cpp Source/PluginProcessor.cpp Source/PluginEditor.cpp)
    target_compile_definitions(SlideTest PRIVATE JUCE_USE_CURL=0 JUCE_WEB_BROWSER=1
        JUCE_PLUGINHOST_VST3=1 JUCE_PLUGINHOST_AU=1 JUCE_PLUGINHOST_LADSPA=0 JUCE_PLUGINHOST_LV2=0)
    target_link_libraries(SlideTest PRIVATE SLIDEUi juce::juce_audio_utils juce::juce_audio_processors
        juce::juce_audio_formats juce::juce_gui_extra juce::juce_recommended_config_flags)
endif()
