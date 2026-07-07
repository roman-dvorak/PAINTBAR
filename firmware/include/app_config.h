#pragma once

#include <Arduino.h>

namespace paintbar {

// XIAO ESP32-S3 defaults:
// - WS2812B data: D10 / GPIO9
// - external trigger: D1 / GPIO2
// - trigger button: D0 / GPIO1
//
// Trigger input and trigger button are currently reserved only for future use.
constexpr uint8_t kLedDataPin = D10;
constexpr uint8_t kTriggerInputPin = 2;
constexpr uint8_t kTriggerButtonPin = 1;

constexpr uint16_t kDefaultLedCount = 320;
constexpr uint16_t kDefaultColumnCount = 64;
constexpr uint16_t kMaxLedCount = 320;
constexpr uint16_t kMaxColumnCount = 512;

constexpr uint8_t kDefaultMaxBrightness = 128;
constexpr uint32_t kBaudRate = 115200;
constexpr uint32_t kDefaultColumnPeriodUs = 20000;
constexpr uint32_t kDebounceUs = 5000;

constexpr char kDeviceName[] = "PAINTBAR";

constexpr char kServiceUuid[] = "6f65f4de-f8c0-4f77-8a31-8fa7516f1000";
constexpr char kConfigCharUuid[] = "6f65f4de-f8c0-4f77-8a31-8fa7516f1001";
constexpr char kControlCharUuid[] = "6f65f4de-f8c0-4f77-8a31-8fa7516f1002";
constexpr char kBitmapCharUuid[] = "6f65f4de-f8c0-4f77-8a31-8fa7516f1003";

}  // namespace paintbar
