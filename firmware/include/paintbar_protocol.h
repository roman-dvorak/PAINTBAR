#pragma once

#include <Arduino.h>

namespace paintbar {

enum class PeriodMode : uint8_t {
  kFixed = 0,
  kExternal = 1,
};

enum class PlaybackMode : uint8_t {
  kOnce = 0,
  kLoop = 1,
  kPingPong = 2,
};

enum class StartMode : uint8_t {
  kAuto = 0,
  kTrigger = 1,
};

enum class BitmapCommand : uint8_t {
  kStartUpload = 0x01,
  kData = 0x02,
  kCommit = 0x03,
  kRequestDownload = 0x04,
  kCancel = 0x05,
  kStartColumnPreview = 0x06,
  kColumnPreviewData = 0x07,
  kApplyColumnPreview = 0x08,
  kDownloadChunk = 0x84,
  kDownloadEnd = 0x85,
  kAck = 0x90,
  kError = 0x91,
};

enum class ControlCommand : uint8_t {
  kPlay = 0x01,
  kStop = 0x02,
  kRestart = 0x03,
  kTrigger = 0x04,
  kRequestStatus = 0x05,
  kStatus = 0x80,
};

struct PlaybackConfig {
  uint16_t led_count = 16;
  uint16_t column_count = 64;
  PeriodMode period_mode = PeriodMode::kFixed;
  PlaybackMode playback_mode = PlaybackMode::kLoop;
  StartMode start_mode = StartMode::kAuto;
  uint32_t fixed_column_period_us = 20000;
  bool auto_start_after_upload = true;
};

struct RuntimeStatus {
  bool playing = false;
  bool upload_in_progress = false;
  uint16_t current_column = 0;
  uint32_t measured_trigger_period_us = 0;
  uint32_t effective_column_period_us = 20000;
  bool direction_forward = true;
};

}  // namespace paintbar
