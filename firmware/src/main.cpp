#include <Arduino.h>
#include <FastLED.h>
#include <LittleFS.h>
#include <NimBLEDevice.h>

#include <algorithm>
#include <vector>

#include "app_config.h"
#include "paintbar_protocol.h"

namespace paintbar {

namespace {

CRGB leds[kMaxLedCount];
PlaybackConfig g_config;
RuntimeStatus g_status;
std::vector<CRGB> g_bitmap;
std::vector<uint8_t> g_bitmap_raw_cache;
std::vector<uint8_t> g_upload_buffer;
std::vector<uint8_t> g_preview_column_buffer;
uint32_t g_upload_expected_bytes = 0;
uint16_t g_preview_target_column = 0;
uint16_t g_preview_expected_bytes = 0;
uint32_t g_last_column_advance_us = 0;
int g_direction = 1;
volatile uint32_t g_last_trigger_edge_us = 0;
volatile uint32_t g_trigger_period_us = 0;
volatile bool g_trigger_seen = false;
volatile bool g_trigger_button_seen = false;
volatile bool g_trigger_button_released_seen = false;

NimBLECharacteristic* g_config_char = nullptr;
NimBLECharacteristic* g_control_char = nullptr;
NimBLECharacteristic* g_bitmap_char = nullptr;

constexpr char kConfigPath[] = "/config.json";
constexpr char kBitmapPath[] = "/bitmap.raw";

void reset_config_to_defaults() {
  g_config.led_count = kDefaultLedCount;
  g_config.column_count = kDefaultColumnCount;
  g_config.period_mode = PeriodMode::kFixed;
  g_config.playback_mode = PlaybackMode::kLoop;
  g_config.start_mode = StartMode::kAuto;
  g_config.trigger_button_mode = TriggerButtonMode::kOneShot;
  g_config.idle_display_mode = IdleDisplayMode::kEdgeColumn;
  g_config.fixed_column_period_us = kDefaultColumnPeriodUs;
  g_config.max_brightness = kDefaultMaxBrightness;
  g_config.auto_start_after_upload = true;
  g_config.solid_color_r = 0;
  g_config.solid_color_g = 0;
  g_config.solid_color_b = 0;
}

void rebuild_bitmap_raw_cache() {
  g_bitmap_raw_cache.clear();
  g_bitmap_raw_cache.reserve(g_bitmap.size() * 3);
  for (const CRGB& pixel : g_bitmap) {
    g_bitmap_raw_cache.push_back(pixel.r);
    g_bitmap_raw_cache.push_back(pixel.g);
    g_bitmap_raw_cache.push_back(pixel.b);
  }
}

String bool_to_json(bool value) { return value ? "true" : "false"; }

std::string to_std_string(const String& text) { return std::string(text.c_str(), text.length()); }

String config_to_json() {
  String json = "{";
  json += "\"led_count\":" + String(g_config.led_count) + ",";
  json += "\"column_count\":" + String(g_config.column_count) + ",";
  json += "\"period_mode\":\"" +
          String(g_config.period_mode == PeriodMode::kFixed ? "fixed" : "external") + "\",";
  json += "\"playback_mode\":\"";
  switch (g_config.playback_mode) {
    case PlaybackMode::kOnce:
      json += "once";
      break;
    case PlaybackMode::kLoop:
      json += "loop";
      break;
    case PlaybackMode::kPingPong:
      json += "ping_pong";
      break;
  }
  json += "\",";
  json += "\"start_mode\":\"" + String(g_config.start_mode == StartMode::kAuto ? "auto" : "trigger") +
          "\",";
  json += "\"trigger_button_mode\":\"";
  switch (g_config.trigger_button_mode) {
    case TriggerButtonMode::kHoldToPlay:
      json += "hold";
      break;
    case TriggerButtonMode::kReset:
      json += "reset";
      break;
    case TriggerButtonMode::kOneShot:
      json += "one_shot";
      break;
  }
  json += "\",";
  json += "\"idle_display_mode\":\"";
  switch (g_config.idle_display_mode) {
    case IdleDisplayMode::kBlack:
      json += "black";
      break;
    case IdleDisplayMode::kSolidColor:
      json += "solid";
      break;
    case IdleDisplayMode::kEdgeColumn:
      json += "edge";
      break;
  }
  json += "\",";
  json += "\"solid_color_r\":" + String(g_config.solid_color_r) + ",";
  json += "\"solid_color_g\":" + String(g_config.solid_color_g) + ",";
  json += "\"solid_color_b\":" + String(g_config.solid_color_b) + ",";
  json += "\"fixed_column_period_us\":" + String(g_config.fixed_column_period_us) + ",";
  json += "\"max_brightness\":" + String(g_config.max_brightness) + ",";
  json += "\"auto_start_after_upload\":" + bool_to_json(g_config.auto_start_after_upload);
  json += "}";
  return json;
}

String status_to_json() {
  String json = "{";
  json += "\"playing\":" + bool_to_json(g_status.playing) + ",";
  json += "\"upload_in_progress\":" + bool_to_json(g_status.upload_in_progress) + ",";
  json += "\"current_column\":" + String(g_status.current_column) + ",";
  json += "\"measured_trigger_period_us\":" + String(g_status.measured_trigger_period_us) + ",";
  json += "\"effective_column_period_us\":" + String(g_status.effective_column_period_us) + ",";
  json += "\"direction_forward\":" + bool_to_json(g_status.direction_forward);
  json += "}";
  return json;
}

bool extract_unsigned(const String& json, const char* key, uint32_t& out) {
  const String pattern = "\"" + String(key) + "\":";
  const int start = json.indexOf(pattern);
  if (start < 0) {
    return false;
  }
  int value_start = start + pattern.length();
  int value_end = value_start;
  while (value_end < json.length() && isDigit(json[value_end])) {
    ++value_end;
  }
  out = json.substring(value_start, value_end).toInt();
  return true;
}

bool extract_string(const String& json, const char* key, String& out) {
  const String pattern = "\"" + String(key) + "\":\"";
  const int start = json.indexOf(pattern);
  if (start < 0) {
    return false;
  }
  const int value_start = start + pattern.length();
  const int value_end = json.indexOf('"', value_start);
  if (value_end < 0) {
    return false;
  }
  out = json.substring(value_start, value_end);
  return true;
}

bool extract_bool(const String& json, const char* key, bool& out) {
  const String true_pattern = "\"" + String(key) + "\":true";
  const String false_pattern = "\"" + String(key) + "\":false";
  if (json.indexOf(true_pattern) >= 0) {
    out = true;
    return true;
  }
  if (json.indexOf(false_pattern) >= 0) {
    out = false;
    return true;
  }
  return false;
}

IdleDisplayMode parse_idle_display_mode(const String& text) {
  if (text == "black") {
    return IdleDisplayMode::kBlack;
  }
  if (text == "solid") {
    return IdleDisplayMode::kSolidColor;
  }
  return IdleDisplayMode::kEdgeColumn;
}

void parse_solid_color(const String& json) {
  uint32_t value = 0;
  if (extract_unsigned(json, "solid_color_r", value)) {
    g_config.solid_color_r = std::min<uint32_t>(value, 255);
  }
  if (extract_unsigned(json, "solid_color_g", value)) {
    g_config.solid_color_g = std::min<uint32_t>(value, 255);
  }
  if (extract_unsigned(json, "solid_color_b", value)) {
    g_config.solid_color_b = std::min<uint32_t>(value, 255);
  }
}

bool sanitize_config() {
  bool changed = false;

  if (g_config.led_count == 0 || g_config.led_count > kMaxLedCount) {
    g_config.led_count = kDefaultLedCount;
    changed = true;
  }
  if (g_config.column_count == 0 || g_config.column_count > kMaxColumnCount) {
    g_config.column_count = kDefaultColumnCount;
    changed = true;
  }
  if (g_config.max_brightness > 255) {
    g_config.max_brightness = kDefaultMaxBrightness;
    changed = true;
  }

  return changed;
}

bool save_config_to_flash() {
  File file = LittleFS.open(kConfigPath, "w");
  if (!file) {
    Serial.println("Failed to open config file for writing");
    return false;
  }
  const String json = config_to_json();
  const size_t written = file.print(json);
  file.close();
  return written == json.length();
}

bool load_config_from_flash() {
  if (!LittleFS.exists(kConfigPath)) {
    return false;
  }

  File file = LittleFS.open(kConfigPath, "r");
  if (!file) {
    Serial.println("Failed to open config file for reading");
    return false;
  }

  const String json = file.readString();
  file.close();

  uint32_t value = 0;
  String text;
  bool flag = false;

  if (extract_unsigned(json, "led_count", value)) {
    g_config.led_count = std::min<uint32_t>(value, kMaxLedCount);
  }
  if (extract_unsigned(json, "column_count", value)) {
    g_config.column_count = std::min<uint32_t>(value, kMaxColumnCount);
  }
  if (extract_unsigned(json, "fixed_column_period_us", value)) {
    g_config.fixed_column_period_us = value;
  }
  if (extract_unsigned(json, "max_brightness", value)) {
    g_config.max_brightness = std::min<uint32_t>(value, 255);
  }
  if (extract_string(json, "period_mode", text)) {
    g_config.period_mode = text == "external" ? PeriodMode::kExternal : PeriodMode::kFixed;
  }
  if (extract_string(json, "playback_mode", text)) {
    if (text == "once") {
      g_config.playback_mode = PlaybackMode::kOnce;
    } else if (text == "ping_pong") {
      g_config.playback_mode = PlaybackMode::kPingPong;
    } else {
      g_config.playback_mode = PlaybackMode::kLoop;
    }
  }
  if (extract_string(json, "start_mode", text)) {
    g_config.start_mode = text == "trigger" ? StartMode::kTrigger : StartMode::kAuto;
  }
  if (extract_string(json, "trigger_button_mode", text)) {
    if (text == "hold") {
      g_config.trigger_button_mode = TriggerButtonMode::kHoldToPlay;
    } else if (text == "reset") {
      g_config.trigger_button_mode = TriggerButtonMode::kReset;
    } else {
      g_config.trigger_button_mode = TriggerButtonMode::kOneShot;
    }
  }
  if (extract_string(json, "idle_display_mode", text)) {
    g_config.idle_display_mode = parse_idle_display_mode(text);
  }
  parse_solid_color(json);
  if (extract_bool(json, "auto_start_after_upload", flag)) {
    g_config.auto_start_after_upload = flag;
  }

  sanitize_config();
  return true;
}

bool save_bitmap_to_flash() {
  File file = LittleFS.open(kBitmapPath, "w");
  if (!file) {
    Serial.println("Failed to open bitmap file for writing");
    return false;
  }

  for (const CRGB& pixel : g_bitmap) {
    const uint8_t rgb[3] = {pixel.r, pixel.g, pixel.b};
    if (file.write(rgb, sizeof(rgb)) != sizeof(rgb)) {
      file.close();
      return false;
    }
  }

  file.close();
  return true;
}

bool load_bitmap_from_flash() {
  if (!LittleFS.exists(kBitmapPath)) {
    return false;
  }

  const size_t expected_bytes = static_cast<size_t>(g_config.column_count) * g_config.led_count * 3;
  File file = LittleFS.open(kBitmapPath, "r");
  if (!file) {
    Serial.println("Failed to open bitmap file for reading");
    return false;
  }

  if (file.size() != expected_bytes) {
    file.close();
    Serial.println("Stored bitmap size does not match current config");
    return false;
  }

  g_bitmap.assign(static_cast<size_t>(g_config.column_count) * g_config.led_count, CRGB::Black);
  for (size_t i = 0; i < g_bitmap.size(); ++i) {
    uint8_t rgb[3] = {0, 0, 0};
    if (file.read(rgb, sizeof(rgb)) != sizeof(rgb)) {
      file.close();
      return false;
    }
    g_bitmap[i] = CRGB(rgb[0], rgb[1], rgb[2]);
  }

  file.close();
  rebuild_bitmap_raw_cache();
  return true;
}

void publish_status() {
  if (!g_control_char) {
    return;
  }
  const std::string payload = to_std_string(status_to_json());
  g_control_char->setValue(payload);
  g_control_char->notify();
}

void reset_playback() {
  g_status.current_column = 0;
  g_direction = 1;
  g_status.direction_forward = true;
  g_last_column_advance_us = micros();
}

void clear_leds() {
  fill_solid(leds, kMaxLedCount, CRGB::Black);
  FastLED.show();
}

void apply_brightness() {
  FastLED.setBrightness(g_config.max_brightness);
  FastLED.show();
}

void show_startup_test() {
  clear_leds();

  // Three gentle blinks of just the two ends of the strip plus the board's
  // own user LED, at ~10 % brightness.
  constexpr uint8_t kStartupBrightness = 25;  // ~10 % of 255
  constexpr uint8_t kStartupBlinks = 3;
  constexpr uint16_t kStartupOnMs = 80;
  constexpr uint16_t kStartupOffMs = 120;

  const uint16_t last = g_config.led_count > 0 ? g_config.led_count - 1 : 0;
  const uint8_t previous_brightness = FastLED.getBrightness();
  FastLED.setBrightness(kStartupBrightness);

  pinMode(LED_BUILTIN, OUTPUT);

  for (uint8_t i = 0; i < kStartupBlinks; ++i) {
    leds[0] = CRGB::White;
    leds[last] = CRGB::White;
    FastLED.show();
    digitalWrite(LED_BUILTIN, LOW);  // XIAO's user LED is active low
    delay(kStartupOnMs);

    leds[0] = CRGB::Black;
    leds[last] = CRGB::Black;
    FastLED.show();
    digitalWrite(LED_BUILTIN, HIGH);
    delay(kStartupOffMs);
  }

  FastLED.setBrightness(previous_brightness);
  clear_leds();
}

void apply_column(uint16_t column) {
  if (g_bitmap.empty() || g_config.led_count == 0 || column >= g_config.column_count) {
    clear_leds();
    return;
  }

  for (uint16_t y = 0; y < g_config.led_count; ++y) {
    const size_t index = static_cast<size_t>(column) * g_config.led_count + y;
    leds[y] = index < g_bitmap.size() ? g_bitmap[index] : CRGB::Black;
  }
  for (uint16_t y = g_config.led_count; y < kMaxLedCount; ++y) {
    leds[y] = CRGB::Black;
  }
  FastLED.show();
}

void apply_solid_color() {
  fill_solid(leds, kMaxLedCount,
             CRGB(g_config.solid_color_r, g_config.solid_color_g, g_config.solid_color_b));
  FastLED.show();
}

// What the strip shows when playback is not running.
void apply_idle_display(uint16_t column) {
  switch (g_config.idle_display_mode) {
    case IdleDisplayMode::kBlack:
      clear_leds();
      break;
    case IdleDisplayMode::kSolidColor:
      apply_solid_color();
      break;
    case IdleDisplayMode::kEdgeColumn:
      apply_column(column);
      break;
  }
}

uint32_t effective_column_period_us() {
  if (g_config.period_mode == PeriodMode::kExternal && g_trigger_period_us > 0 &&
      g_config.column_count > 0) {
    const uint32_t derived = std::max<uint32_t>(1, g_trigger_period_us / g_config.column_count);
    g_status.measured_trigger_period_us = g_trigger_period_us;
    g_status.effective_column_period_us = derived;
    return derived;
  }
  g_status.effective_column_period_us = g_config.fixed_column_period_us;
  return g_config.fixed_column_period_us;
}

void start_playback() {
  g_status.playing = true;
  reset_playback();
  apply_column(0);
  publish_status();
}

void stop_playback() {
  g_status.playing = false;
  publish_status();
}

void advance_column() {
  if (!g_status.playing || g_config.column_count == 0) {
    return;
  }

  if (g_config.playback_mode == PlaybackMode::kOnce) {
    if (g_status.current_column + 1 >= g_config.column_count) {
      g_status.current_column = g_config.column_count - 1;
      apply_idle_display(g_status.current_column);
      stop_playback();
      return;
    }
    ++g_status.current_column;
  } else if (g_config.playback_mode == PlaybackMode::kLoop) {
    g_status.current_column = (g_status.current_column + 1) % g_config.column_count;
  } else {
    if (g_direction > 0) {
      if (g_status.current_column + 1 >= g_config.column_count) {
        if (g_config.column_count > 1) {
          g_direction = -1;
          --g_status.current_column;
        }
      } else {
        ++g_status.current_column;
      }
    } else {
      if (g_status.current_column == 0) {
        g_direction = 1;
        if (g_config.column_count > 1) {
          ++g_status.current_column;
        }
      } else {
        --g_status.current_column;
      }
    }
    g_status.direction_forward = g_direction > 0;
  }

  apply_column(g_status.current_column);
  publish_status();
}

void IRAM_ATTR on_trigger_edge() {
  const uint32_t now = micros();
  if (now - g_last_trigger_edge_us < kDebounceUs) {
    return;
  }
  g_trigger_period_us = now - g_last_trigger_edge_us;
  g_last_trigger_edge_us = now;
  g_trigger_seen = true;
}

void IRAM_ATTR on_trigger_button() {
  static uint32_t last_us = 0;
  const uint32_t now = micros();
  if (now - last_us < kDebounceUs) {
    return;
  }
  last_us = now;
  if (digitalRead(kTriggerButtonPin) == LOW) {
    g_trigger_button_seen = true;
  } else {
    g_trigger_button_released_seen = true;
  }
}

void handle_trigger_event() {
  if (!(g_trigger_seen || g_trigger_button_seen || g_trigger_button_released_seen)) {
    return;
  }

  noInterrupts();
  const bool trigger_seen = g_trigger_seen;
  const bool button_seen = g_trigger_button_seen;
  const bool button_released_seen = g_trigger_button_released_seen;
  g_trigger_seen = false;
  g_trigger_button_seen = false;
  g_trigger_button_released_seen = false;
  interrupts();

  if (trigger_seen) {
    if (g_config.start_mode == StartMode::kTrigger) {
      start_playback();
    } else if (g_status.playing && g_config.period_mode == PeriodMode::kExternal) {
      g_last_column_advance_us = micros();
    }
  }

  if (button_seen) {
    switch (g_config.trigger_button_mode) {
      case TriggerButtonMode::kOneShot:
        start_playback();
        break;
      case TriggerButtonMode::kHoldToPlay:
        start_playback();
        break;
      case TriggerButtonMode::kReset:
        reset_playback();
        apply_column(0);
        publish_status();
        break;
    }
  }

  if (button_released_seen && g_config.trigger_button_mode == TriggerButtonMode::kHoldToPlay) {
    stop_playback();
  }
}

void send_bitmap_ack(BitmapCommand command, uint16_t value) {
  if (!g_bitmap_char) {
    return;
  }
  uint8_t payload[4] = {
      static_cast<uint8_t>(command),
      static_cast<uint8_t>(value & 0xff),
      static_cast<uint8_t>((value >> 8) & 0xff),
      0,
  };
  g_bitmap_char->setValue(payload, sizeof(payload));
  g_bitmap_char->notify();
}

void send_bitmap_error(uint8_t code) {
  if (!g_bitmap_char) {
    return;
  }
  const uint8_t payload[2] = {static_cast<uint8_t>(BitmapCommand::kError), code};
  g_bitmap_char->setValue(payload, sizeof(payload));
  g_bitmap_char->notify();
}

void start_upload(uint16_t width, uint16_t height, uint32_t total_bytes) {
  if (width == 0 || height == 0 || width > kMaxColumnCount || height > kMaxLedCount) {
    send_bitmap_error(1);
    return;
  }
  if (total_bytes != static_cast<uint32_t>(width) * height * 3) {
    send_bitmap_error(2);
    return;
  }

  g_config.column_count = width;
  g_config.led_count = height;
  sanitize_config();
  g_upload_expected_bytes = total_bytes;
  g_upload_buffer.assign(total_bytes, 0);
  g_status.upload_in_progress = true;
  send_bitmap_ack(BitmapCommand::kAck, 1);
  publish_status();
}

void commit_upload() {
  if (!g_status.upload_in_progress || g_upload_buffer.size() != g_upload_expected_bytes) {
    send_bitmap_error(3);
    return;
  }

  g_bitmap.assign(static_cast<size_t>(g_config.column_count) * g_config.led_count, CRGB::Black);
  for (size_t i = 0; i < g_bitmap.size(); ++i) {
    const size_t base = i * 3;
    g_bitmap[i] = CRGB(g_upload_buffer[base], g_upload_buffer[base + 1], g_upload_buffer[base + 2]);
  }

  g_status.upload_in_progress = false;
  g_upload_buffer.clear();
  g_upload_expected_bytes = 0;
  if (g_config.idle_display_mode == IdleDisplayMode::kSolidColor) {
    g_config.idle_display_mode = IdleDisplayMode::kEdgeColumn;
  }
  rebuild_bitmap_raw_cache();

  // Acknowledge as soon as the bitmap is live in RAM. Persisting it to LittleFS
  // takes well over the client's ack timeout for a full-size frame, so the
  // flash writes and playback restart have to happen after the notify.
  g_config_char->setValue(to_std_string(config_to_json()));
  send_bitmap_ack(BitmapCommand::kAck, 2);
  publish_status();

  save_config_to_flash();
  save_bitmap_to_flash();
  reset_playback();
  if (g_config.auto_start_after_upload) {
    start_playback();
  } else {
    apply_column(0);
  }
}

void start_column_preview(uint16_t column, uint16_t total_bytes) {
  const uint16_t expected_bytes = g_config.led_count * 3;
  if (column >= g_config.column_count) {
    send_bitmap_error(8);
    return;
  }
  if (total_bytes != expected_bytes) {
    send_bitmap_error(9);
    return;
  }

  g_preview_target_column = column;
  g_preview_expected_bytes = total_bytes;
  g_preview_column_buffer.assign(total_bytes, 0);
  send_bitmap_ack(BitmapCommand::kAck, column);
}

void apply_preview_column() {
  if (g_preview_column_buffer.size() != g_preview_expected_bytes ||
      g_preview_expected_bytes != g_config.led_count * 3) {
    send_bitmap_error(10);
    return;
  }

  if (g_bitmap.size() != static_cast<size_t>(g_config.column_count) * g_config.led_count) {
    g_bitmap.assign(static_cast<size_t>(g_config.column_count) * g_config.led_count, CRGB::Black);
  }

  for (uint16_t y = 0; y < g_config.led_count; ++y) {
    const size_t pixel_index = static_cast<size_t>(g_preview_target_column) * g_config.led_count + y;
    const size_t base = y * 3;
    g_bitmap[pixel_index] = CRGB(
        g_preview_column_buffer[base],
        g_preview_column_buffer[base + 1],
        g_preview_column_buffer[base + 2]);
  }

  stop_playback();
  g_status.current_column = g_preview_target_column;
  rebuild_bitmap_raw_cache();
  save_bitmap_to_flash();
  apply_column(g_preview_target_column);
  publish_status();
  send_bitmap_ack(BitmapCommand::kAck, g_preview_target_column);
}

void notify_download_chunk(uint32_t offset, uint16_t length) {
  if (!g_bitmap_char) {
    return;
  }

  const uint32_t available = g_bitmap_raw_cache.size();
  if (offset >= available) {
    const uint8_t end_payload[1] = {static_cast<uint8_t>(BitmapCommand::kDownloadEnd)};
    g_bitmap_char->setValue(end_payload, sizeof(end_payload));
    g_bitmap_char->notify();
    return;
  }

  const uint16_t chunk_len = std::min<uint32_t>(length, available - offset);
  std::vector<uint8_t> payload;
  payload.reserve(chunk_len + 7);
  payload.push_back(static_cast<uint8_t>(BitmapCommand::kDownloadChunk));
  payload.push_back(static_cast<uint8_t>(offset & 0xff));
  payload.push_back(static_cast<uint8_t>((offset >> 8) & 0xff));
  payload.push_back(static_cast<uint8_t>((offset >> 16) & 0xff));
  payload.push_back(static_cast<uint8_t>((offset >> 24) & 0xff));
  payload.push_back(static_cast<uint8_t>(chunk_len & 0xff));
  payload.push_back(static_cast<uint8_t>((chunk_len >> 8) & 0xff));
  payload.insert(
      payload.end(), g_bitmap_raw_cache.begin() + offset, g_bitmap_raw_cache.begin() + offset + chunk_len);
  g_bitmap_char->setValue(payload.data(), payload.size());
  g_bitmap_char->notify();

  if (offset + chunk_len >= available) {
    const uint8_t end_payload[1] = {static_cast<uint8_t>(BitmapCommand::kDownloadEnd)};
    g_bitmap_char->setValue(end_payload, sizeof(end_payload));
    g_bitmap_char->notify();
  }
}

class ConfigCallbacks : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic* characteristic) override {
    characteristic->setValue(to_std_string(config_to_json()));
  }

  void onWrite(NimBLECharacteristic* characteristic) override {
    const String json = String(characteristic->getValue().c_str());
    uint32_t value = 0;
    String text;
    bool flag = false;

    if (extract_unsigned(json, "led_count", value)) {
      g_config.led_count = std::min<uint32_t>(value, kMaxLedCount);
    }
    if (extract_unsigned(json, "column_count", value)) {
      g_config.column_count = std::min<uint32_t>(value, kMaxColumnCount);
    }
    if (extract_unsigned(json, "fixed_column_period_us", value)) {
      g_config.fixed_column_period_us = value;
    }
    if (extract_unsigned(json, "max_brightness", value)) {
      g_config.max_brightness = std::min<uint32_t>(value, 255);
    }
    if (extract_string(json, "period_mode", text)) {
      g_config.period_mode = text == "external" ? PeriodMode::kExternal : PeriodMode::kFixed;
    }
    if (extract_string(json, "playback_mode", text)) {
      if (text == "once") {
        g_config.playback_mode = PlaybackMode::kOnce;
      } else if (text == "ping_pong") {
        g_config.playback_mode = PlaybackMode::kPingPong;
      } else {
        g_config.playback_mode = PlaybackMode::kLoop;
      }
    }
    if (extract_string(json, "start_mode", text)) {
      g_config.start_mode = text == "trigger" ? StartMode::kTrigger : StartMode::kAuto;
    }
    if (extract_string(json, "trigger_button_mode", text)) {
      if (text == "hold") {
        g_config.trigger_button_mode = TriggerButtonMode::kHoldToPlay;
      } else if (text == "reset") {
        g_config.trigger_button_mode = TriggerButtonMode::kReset;
      } else {
        g_config.trigger_button_mode = TriggerButtonMode::kOneShot;
      }
    }
    if (extract_string(json, "idle_display_mode", text)) {
      g_config.idle_display_mode = parse_idle_display_mode(text);
    }
    parse_solid_color(json);
    if (extract_bool(json, "auto_start_after_upload", flag)) {
      g_config.auto_start_after_upload = flag;
    }

    sanitize_config();
    apply_brightness();
    save_config_to_flash();
    characteristic->setValue(to_std_string(config_to_json()));
    publish_status();
  }
};

class ControlCallbacks : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic* characteristic) override {
    characteristic->setValue(to_std_string(status_to_json()));
  }

  void onWrite(NimBLECharacteristic* characteristic) override {
    const std::string value = characteristic->getValue();
    if (value.empty()) {
      return;
    }

    switch (static_cast<ControlCommand>(value[0])) {
      case ControlCommand::kPlay:
        if (g_config.idle_display_mode == IdleDisplayMode::kSolidColor) {
          g_config.idle_display_mode = IdleDisplayMode::kEdgeColumn;
          save_config_to_flash();
          g_config_char->setValue(to_std_string(config_to_json()));
        }
        start_playback();
        break;
      case ControlCommand::kStop:
        stop_playback();
        break;
      case ControlCommand::kRestart:
        reset_playback();
        apply_column(0);
        publish_status();
        break;
      case ControlCommand::kTrigger:
        start_playback();
        break;
      case ControlCommand::kRequestStatus:
        publish_status();
        break;
      case ControlCommand::kSetSolidColor:
        if (value.size() < 4) {
          break;
        }
        stop_playback();
        g_config.solid_color_r = static_cast<uint8_t>(value[1]);
        g_config.solid_color_g = static_cast<uint8_t>(value[2]);
        g_config.solid_color_b = static_cast<uint8_t>(value[3]);
        // Remember it as the idle state so a reboot restores the same colour
        // instead of falling back to the bitmap's edge column.
        g_config.idle_display_mode = IdleDisplayMode::kSolidColor;
        apply_solid_color();
        save_config_to_flash();
        g_config_char->setValue(to_std_string(config_to_json()));
        publish_status();
        break;
      case ControlCommand::kStatus:
        break;
    }
  }
};

class BitmapCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic) override {
    const std::string value = characteristic->getValue();
    if (value.empty()) {
      return;
    }

    const uint8_t* data = reinterpret_cast<const uint8_t*>(value.data());
    const auto command = static_cast<BitmapCommand>(data[0]);

    switch (command) {
      case BitmapCommand::kStartUpload: {
        if (value.size() < 9) {
          send_bitmap_error(4);
          return;
        }
        const uint16_t width = data[1] | (data[2] << 8);
        const uint16_t height = data[3] | (data[4] << 8);
        const uint32_t bytes = data[5] | (data[6] << 8) | (data[7] << 16) | (data[8] << 24);
        start_upload(width, height, bytes);
        break;
      }
      case BitmapCommand::kData: {
        if (value.size() < 5 || !g_status.upload_in_progress) {
          send_bitmap_error(5);
          return;
        }
        const uint32_t offset = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
        const size_t payload_len = value.size() - 5;
        if (offset + payload_len > g_upload_buffer.size()) {
          send_bitmap_error(6);
          return;
        }
        memcpy(g_upload_buffer.data() + offset, data + 5, payload_len);
        send_bitmap_ack(BitmapCommand::kAck, static_cast<uint16_t>(payload_len));
        break;
      }
      case BitmapCommand::kCommit:
        commit_upload();
        break;
      case BitmapCommand::kRequestDownload: {
        if (value.size() < 7) {
          send_bitmap_error(7);
          return;
        }
        const uint32_t offset = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
        const uint16_t length = data[5] | (data[6] << 8);
        notify_download_chunk(offset, length);
        break;
      }
      case BitmapCommand::kStartColumnPreview: {
        if (value.size() < 5) {
          send_bitmap_error(11);
          return;
        }
        const uint16_t column = data[1] | (data[2] << 8);
        const uint16_t bytes = data[3] | (data[4] << 8);
        start_column_preview(column, bytes);
        break;
      }
      case BitmapCommand::kColumnPreviewData: {
        if (value.size() < 4 || g_preview_column_buffer.empty()) {
          send_bitmap_error(12);
          return;
        }
        const uint16_t offset = data[1] | (data[2] << 8);
        const size_t payload_len = value.size() - 3;
        if (offset + payload_len > g_preview_column_buffer.size()) {
          send_bitmap_error(13);
          return;
        }
        memcpy(g_preview_column_buffer.data() + offset, data + 3, payload_len);
        send_bitmap_ack(BitmapCommand::kAck, offset);
        break;
      }
      case BitmapCommand::kApplyColumnPreview:
        apply_preview_column();
        break;
      case BitmapCommand::kCancel:
        g_status.upload_in_progress = false;
        g_upload_buffer.clear();
        g_upload_expected_bytes = 0;
        g_preview_column_buffer.clear();
        g_preview_expected_bytes = 0;
        publish_status();
        break;
      case BitmapCommand::kDownloadChunk:
      case BitmapCommand::kDownloadEnd:
      case BitmapCommand::kAck:
      case BitmapCommand::kError:
        break;
    }
  }
};

void init_bitmap() {
  g_bitmap.assign(static_cast<size_t>(g_config.column_count) * g_config.led_count, CRGB::Black);
  for (uint16_t x = 0; x < g_config.column_count; ++x) {
    const uint8_t hue = map(x, 0, std::max<uint16_t>(1, g_config.column_count - 1), 0, 255);
    for (uint16_t y = 0; y < g_config.led_count; ++y) {
      const size_t index = static_cast<size_t>(x) * g_config.led_count + y;
      g_bitmap[index] = CHSV(hue, 255, ((x + y) % 2) ? 180 : 40);
    }
  }
  rebuild_bitmap_raw_cache();
}

void setup_ble() {
  NimBLEDevice::init(kDeviceName);
  NimBLEDevice::setMTU(247);
  NimBLEServer* server = NimBLEDevice::createServer();
  NimBLEService* service = server->createService(kServiceUuid);

  g_config_char =
      service->createCharacteristic(kConfigCharUuid, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
  g_control_char = service->createCharacteristic(
      kControlCharUuid, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
  g_bitmap_char = service->createCharacteristic(
      kBitmapCharUuid,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::NOTIFY);

  g_config_char->setCallbacks(new ConfigCallbacks());
  g_control_char->setCallbacks(new ControlCallbacks());
  g_bitmap_char->setCallbacks(new BitmapCallbacks());

  g_config_char->setValue(to_std_string(config_to_json()));
  g_control_char->setValue(to_std_string(status_to_json()));

  service->start();
  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(kServiceUuid);
  advertising->setScanResponse(true);
  advertising->start();
}

}  // namespace

void setup() {
  Serial.begin(kBaudRate);
  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed");
  }

  reset_config_to_defaults();

  FastLED.addLeds<WS2812B, kLedDataPin, GRB>(leds, kMaxLedCount);
  FastLED.setBrightness(g_config.max_brightness);
  clear_leds();

  if (!load_config_from_flash() || !load_bitmap_from_flash()) {
    init_bitmap();
    save_config_to_flash();
    save_bitmap_to_flash();
  } else if (sanitize_config()) {
    save_config_to_flash();
  }
  apply_brightness();
  setup_ble();

  pinMode(kTriggerInputPin, INPUT_PULLUP);
  pinMode(kTriggerButtonPin, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(kTriggerInputPin), on_trigger_edge, FALLING);
  attachInterrupt(digitalPinToInterrupt(kTriggerButtonPin), on_trigger_button, CHANGE);

  show_startup_test();

  // A remembered solid colour is the last thing the user asked for, so it wins
  // over auto-start; otherwise nothing would be visible of it after a reboot.
  if (g_config.start_mode == StartMode::kAuto &&
      g_config.idle_display_mode != IdleDisplayMode::kSolidColor) {
    start_playback();
  } else {
    apply_idle_display(0);
  }
}

void loop() {
  handle_trigger_event();

  if (!g_status.playing) {
    delay(5);
    return;
  }

  const uint32_t now = micros();
  const uint32_t column_period = effective_column_period_us();
  if (now - g_last_column_advance_us >= column_period) {
    g_last_column_advance_us = now;
    advance_column();
  }
}

}  // namespace paintbar

void setup() { paintbar::setup(); }

void loop() { paintbar::loop(); }
