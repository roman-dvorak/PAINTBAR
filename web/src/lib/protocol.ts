export const SERVICE_UUID = "6f65f4de-f8c0-4f77-8a31-8fa7516f1000"
export const CONFIG_CHAR_UUID = "6f65f4de-f8c0-4f77-8a31-8fa7516f1001"
export const CONTROL_CHAR_UUID = "6f65f4de-f8c0-4f77-8a31-8fa7516f1002"
export const BITMAP_CHAR_UUID = "6f65f4de-f8c0-4f77-8a31-8fa7516f1003"

export const DEFAULT_CHUNK_SIZE = 237

export const BitmapCommand = {
  START_UPLOAD: 0x01,
  DATA: 0x02,
  COMMIT: 0x03,
  REQUEST_DOWNLOAD: 0x04,
  CANCEL: 0x05,
  START_COLUMN_PREVIEW: 0x06,
  COLUMN_PREVIEW_DATA: 0x07,
  APPLY_COLUMN_PREVIEW: 0x08,
  DOWNLOAD_CHUNK: 0x84,
  DOWNLOAD_END: 0x85,
  ACK: 0x90,
  ERROR: 0x91,
} as const

export const ControlCommand = {
  PLAY: 0x01,
  STOP: 0x02,
  RESTART: 0x03,
  TRIGGER: 0x04,
  REQUEST_STATUS: 0x05,
  SET_SOLID_COLOR: 0x06,
} as const

export type ControlCommandId = (typeof ControlCommand)[keyof typeof ControlCommand]

export type PlaybackConfig = {
  led_count: number
  column_count: number
  period_mode: "fixed" | "external" | string
  playback_mode: "once" | "loop" | "ping_pong" | string
  start_mode: "auto" | "trigger" | string
  trigger_button_mode: "one_shot" | "hold" | "reset" | string
  idle_display_mode: "black" | "edge" | "solid" | string
  solid_color_r: number
  solid_color_g: number
  solid_color_b: number
  fixed_column_period_us: number
  max_brightness: number
  auto_start_after_upload: boolean
}

export const defaultPlaybackConfig = (): PlaybackConfig => ({
  led_count: 160,
  column_count: 64,
  period_mode: "fixed",
  playback_mode: "loop",
  start_mode: "auto",
  trigger_button_mode: "one_shot",
  idle_display_mode: "edge",
  solid_color_r: 0,
  solid_color_g: 0,
  solid_color_b: 0,
  fixed_column_period_us: 20_000,
  max_brightness: 128,
  auto_start_after_upload: true,
})
