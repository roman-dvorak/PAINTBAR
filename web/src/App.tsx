import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { EditorCanvas, type Tool, TOOLS } from "./components/EditorCanvas"
import { Gallery } from "./components/Gallery"
import { type PlaybackConfig, ControlCommand } from "./lib/protocol"
import { BitmapFrame } from "./lib/bitmap"
import { PaintbarBle } from "./lib/paintbarBle"
import { bitmapToPngBlob, loadImageDataToFrame, triggerDownload } from "./lib/exportPng"
import "./App.css"

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "?"
  const totalMs = Math.max(0, Math.round(ms))
  const s = Math.floor(totalMs / 1000)
  const rem = totalMs % 1000
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return mm > 0
    ? `${mm}:${String(ss).padStart(2, "0")}.${String(rem).padStart(3, "0")}`
    : `${ss}.${String(rem).padStart(3, "0")} s`
}

function useFrame() {
  const ref = useRef<BitmapFrame>(new BitmapFrame(64, 160))
  const [n, setN] = useState(0)
  const refresh = useCallback(() => {
    setN((x) => x + 1)
  }, [])
  return { ref, ver: n, refresh }
}

export default const hex2 = (v: number) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")

const solidColorHex = (c: Partial<PlaybackConfig>) =>
  "#" + hex2(c.solid_color_r ?? 0) + hex2(c.solid_color_g ?? 0) + hex2(c.solid_color_b ?? 0)

function App() {
  const { ref: fr, ver, refresh: bump } = useFrame()
  const ble = useRef(new PaintbarBle())
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const [tool, setTool] = useState<Tool>("Pen")
  const [color, setColor] = useState("#f52828")
  const [activeCol, setActiveCol] = useState(0)
  const [fixed, setFixed] = useState(false)
  const [drawLive, setDrawLive] = useState(false)
  const [previewMs, setPreviewMs] = useState(120)
  const tPrev = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [ledN, setLedN] = useState(160)
  const [colN, setColN] = useState(64)
  const [period, setPeriod] = useState(20_000)
  const [brightnessPct, setBrightnessPct] = useState(50)
  const [periodM, setPeriodM] = useState("fixed")
  const [playM, setPlayM] = useState("loop")
  const [startM, setStartM] = useState("auto")
  const [triggerButtonMode, setTriggerButtonMode] = useState("one_shot")
  const [idleDisplayMode, setIdleDisplayMode] = useState("edge")
  const [solidColor, setSolidColor] = useState("#ffffff")
  const initializedRef = useRef(false)
  const liveApplyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [subMsg, setMsg] = useState("")
  const [transferLabel, setTransferLabel] = useState("")
  const [transferProgress, setTransferProgress] = useState<number | null>(null)

  const push = useCallback((m: string) => {
    setLog((L) => [...L.slice(-120), m])
  }, [])

  useEffect(() => {
    ble.current.setStatusCallback((m) => {
      console.log(m)
      push(m)
    })
  }, [push])

  const withBusy = useCallback(
    async (msg: string, fn: () => Promise<void>) => {
      setMsg(msg)
      setBusy(true)
      try {
        await fn()
      } catch (e) {
        const t = e instanceof Error ? e.message : String(e)
        push("Chyba: " + t)
        window.alert("Chyba: " + t)
      } finally {
        setBusy(false)
        setMsg("")
      }
    },
    [push],
  )

  const withTransferBusy = useCallback(
    async (
      msg: string,
      transferMsg: string,
      fn: (onProgress: (pct: number) => void) => Promise<void>,
    ) => {
      setTransferLabel(transferMsg)
      setTransferProgress(0)
      await withBusy(msg, async () => {
        await fn((pct) => setTransferProgress(Math.max(0, Math.min(100, Math.round(pct)))))
      })
      setTransferProgress(null)
      setTransferLabel("")
    },
    [withBusy],
  )

  const syncSize = (cw: number, ch: number) => {
    const f = fr.current
    if (f.width !== cw || f.height !== ch) f.resize(cw, ch)
    if (activeCol >= cw) setActiveCol(0)
    bump()
  }

  const toCfg = (auto: boolean): PlaybackConfig => {
    const w = colN
    const h = ledN
    syncSize(w, h)
    return {
      led_count: h,
      column_count: w,
      period_mode: periodM,
      playback_mode: playM,
      start_mode: startM,
      trigger_button_mode: triggerButtonMode,
      idle_display_mode: idleDisplayMode,
      solid_color_r: parseInt(solidColor.slice(1, 3), 16),
      solid_color_g: parseInt(solidColor.slice(3, 5), 16),
      solid_color_b: parseInt(solidColor.slice(5, 7), 16),
      fixed_column_period_us: period,
      max_brightness: Math.round((brightnessPct / 100) * 255),
      auto_start_after_upload: auto,
    }
  }

  useEffect(() => {
    if (!initializedRef.current || !connected) return
    if (liveApplyTimer.current) clearTimeout(liveApplyTimer.current)
    liveApplyTimer.current = setTimeout(() => {
      liveApplyTimer.current = null
      ble.current
        .writeConfig(toCfg(false))
        .catch((e) => push("Živé nahrání parametrů selhalo: " + String(e)))
    }, 300)
    return () => {
      if (liveApplyTimer.current) clearTimeout(liveApplyTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ledN,
    colN,
    period,
    brightnessPct,
    periodM,
    playM,
    startM,
    triggerButtonMode,
    idleDisplayMode,
    solidColor,
    connected,
  ])

  const durationMs = useMemo(() => (colN * period) / 1000, [colN, period])

  const schedulePreview = useCallback(() => {
    if (!drawLive || !ble.current.connected) return
    if (tPrev.current) clearTimeout(tPrev.current)
    tPrev.current = setTimeout(async () => {
      tPrev.current = null
      try {
        await ble.current.previewColumn(fr.current, activeCol)
      } catch {
        /* tiché — preview je best-effort */
      }
    }, previewMs)
  }, [activeCol, drawLive, previewMs, fr])

  const onConnect = () =>
    withBusy("Připojování…", async () => {
      if (ble.current.connected) await ble.current.disconnect()
      setConnected(false)
      initializedRef.current = false
      await ble.current.requestDevice()
      await ble.current.connect()
      const c = await ble.current.readConfig()
      if (c.led_count > 0 && c.column_count > 0) {
        setLedN(c.led_count)
        setColN(c.column_count)
        setPeriod(c.fixed_column_period_us)
        setBrightnessPct(Math.round(((c.max_brightness ?? 128) / 255) * 100))
        setPeriodM(c.period_mode)
        setPlayM(c.playback_mode)
        setStartM(c.start_mode)
        setTriggerButtonMode(c.trigger_button_mode ?? "one_shot")
        setIdleDisplayMode(c.idle_display_mode ?? "edge")
                  setSolidColor(solidColorHex(c))
        fr.current.resize(c.column_count, c.led_count)
        bump()
      }
      setConnected(true)
      initializedRef.current = true
    })

  const onDisconnect = () =>
    withBusy("Odpojuji…", async () => {
      initializedRef.current = false
      await ble.current.disconnect()
      setConnected(false)
    })

  return (
    <div className="app">
      <header className="app__header">
        <h1>PAINTBAR</h1>
      </header>
      {busy && (
        <div className="app__overlay" role="status">
          <div className="app__overlay-card">
            <p>{subMsg || "…"}</p>
            {transferProgress !== null && (
              <>
                <p className="app__overlay-sub">{transferLabel || "Přenos dat"}</p>
                <div className="app__progress">
                  <div className="app__progress-fill" style={{ width: `${transferProgress}%` }} />
                </div>
                <p className="app__progress-pct">{transferProgress} %</p>
              </>
            )}
          </div>
        </div>
      )}

      <div className="app__body">
        <section className="app__side">
          <h2>BLE</h2>
          <div className="btnrow">
            <button className="btn" type="button" disabled={busy} onClick={onConnect}>
              {connected ? "Znovu vybrat" : "Připojit k desce"}
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy || !connected}
              onClick={onDisconnect}
            >
              Odpojit
            </button>
          </div>
          {connected && <p className="app__ok">Spojeno</p>}

          <h2>Konfigurace</h2>
          <div className="formgrid">
            <label>LED (výška)</label>
            <input
              type="number"
              min={1}
              max={256}
              value={ledN}
              onChange={(e) => setLedN(Math.max(1, +e.target.value || 1))}
            />
            <label>Sloupců (šířka)</label>
            <input
              type="number"
              min={1}
              max={512}
              value={colN}
              onChange={(e) => setColN(Math.max(1, +e.target.value || 1))}
            />
            <label>Perioda sloupce (µs)</label>
            <input
              type="number"
              min={0}
              value={period}
              onChange={(e) => setPeriod(Math.max(0, +e.target.value || 0))}
            />
            <label>Max. jas (%)</label>
            <div className="rangefield">
              <input
                type="range"
                min={0}
                max={100}
                value={brightnessPct}
                onChange={(e) => setBrightnessPct(Math.max(0, Math.min(100, +e.target.value || 0)))}
              />
              <span>{brightnessPct} %</span>
            </div>
            <label>Režim periody</label>
            <select value={periodM} onChange={(e) => setPeriodM(e.target.value)}>
              <option value="fixed">fixed</option>
              <option value="external">external</option>
            </select>
            <label>Přehrávání</label>
            <select value={playM} onChange={(e) => setPlayM(e.target.value)}>
              <option value="once">once</option>
              <option value="loop">loop</option>
              <option value="ping_pong">ping_pong</option>
            </select>
            <label>Start</label>
            <select value={startM} onChange={(e) => setStartM(e.target.value)}>
              <option value="auto">auto</option>
              <option value="trigger">trigger</option>
            </select>
            <label>Tlačítko trigger</label>
            <select value={triggerButtonMode} onChange={(e) => setTriggerButtonMode(e.target.value)}>
              <option value="one_shot">one_shot</option>
              <option value="hold">hold</option>
              <option value="reset">reset</option>
            </select>
            <label>Klidový stav (start/konec)</label>
            <select value={idleDisplayMode} onChange={(e) => setIdleDisplayMode(e.target.value)}>
              <option value="edge">první/poslední sloupec</option>
              <option value="black">tma</option>
              <option value="solid">poslední barva</option>
            </select>
          </div>
          <p className="app__muted">
            {periodM === "external"
              ? "0 = nejrychlejší možný posun. Délka jednoho přehrání závisí na externím triggeru."
              : `0 = nejrychlejší možný posun. Jedno přehrání: ${formatDuration(durationMs)}${
                  playM === "ping_pong" ? ` (cyklus tam a zpět: ${formatDuration(durationMs * 2)})` : ""
                }`}
          </p>
          <div className="btnrow">
            <button
              className="btn sm"
              type="button"
              disabled={busy || !connected}
              onClick={() =>
                withBusy("Nahrávám parametry…", async () => {
                  await ble.current.writeConfig(toCfg(false))
                })
              }
            >
              Nahrát parametry
            </button>
            <button
              className="btn sm"
              type="button"
              disabled={busy || !connected}
              onClick={() =>
                withBusy("Stahuji parametry…", async () => {
                  const c = await ble.current.readConfig()
                  if (c.led_count < 1 || c.column_count < 1) {
                    push("Deska vratila neplatnou konfiguraci")
                    return
                  }
                  initializedRef.current = false
                  setLedN(c.led_count)
                  setColN(c.column_count)
                  setPeriod(c.fixed_column_period_us)
                  setBrightnessPct(Math.round(((c.max_brightness ?? 128) / 255) * 100))
                  setPeriodM(c.period_mode)
                  setPlayM(c.playback_mode)
                  setStartM(c.start_mode)
                  setTriggerButtonMode(c.trigger_button_mode ?? "one_shot")
                  setIdleDisplayMode(c.idle_display_mode ?? "edge")
                  setSolidColor(solidColorHex(c))
                  fr.current.resize(c.column_count, c.led_count)
                  bump()
                  initializedRef.current = true
                })
              }
            >
              Stáhnout parametry
            </button>
          </div>
          <button
            className="btn"
            type="button"
            disabled={busy || !connected}
            onClick={() =>
              withTransferBusy("Ukládám…", "Nahrávání bitmapy", async (onProgress) => {
                await ble.current.writeConfig(toCfg(false))
                await ble.current.uploadBitmap(fr.current, onProgress)
              })
            }
          >
            Nahrát (konfig + obraz)
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy || !connected}
            onClick={() =>
              withTransferBusy("Canvas…", "Nahrávání bitmapy", async (onProgress) => {
                await ble.current.sendControl(ControlCommand.STOP)
                await ble.current.writeConfig(toCfg(true))
                await ble.current.uploadBitmap(fr.current, onProgress)
                push("Canvas: po nahrátí může firmware ihned hrát (auto).")
              })
            }
          >
            Upload canvas + auto play
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy || !connected}
            onClick={() =>
              withTransferBusy("Stahuji…", "Stahování bitmapy", async (onProgress) => {
                const c = await ble.current.readConfig()
                if (c.led_count < 1 || c.column_count < 1) {
                  push("Deska vratila neplatnou konfiguraci")
                  return
                }
                initializedRef.current = false
                setLedN(c.led_count)
                setColN(c.column_count)
                setPeriod(c.fixed_column_period_us)
                setBrightnessPct(Math.round(((c.max_brightness ?? 128) / 255) * 100))
                setPeriodM(c.period_mode)
                setPlayM(c.playback_mode)
                setStartM(c.start_mode)
                setTriggerButtonMode(c.trigger_button_mode ?? "one_shot")
                setIdleDisplayMode(c.idle_display_mode ?? "edge")
                  setSolidColor(solidColorHex(c))
                const got = await ble.current.downloadBitmap(c.column_count, c.led_count, onProgress)
                fr.current = got
                bump()
                initializedRef.current = true
              })
            }
          >
            Stáhnout z desky
          </button>
          <div className="btnrow">
            <button
              className="btn sm"
              type="button"
              disabled={busy || !connected}
              onClick={() => withBusy("Příkaz…", () => ble.current.sendControl(ControlCommand.PLAY))}
            >
              Play
            </button>
            <button
              className="btn sm"
              type="button"
              disabled={busy || !connected}
              onClick={() => withBusy("Příkaz…", () => ble.current.sendControl(ControlCommand.STOP))}
            >
              Stop
            </button>
            <button
              className="btn sm"
              type="button"
              disabled={busy || !connected}
              onClick={() => withBusy("Příkaz…", () => ble.current.sendControl(ControlCommand.TRIGGER))}
            >
              Trigger
            </button>
          </div>

          <h2>Nastavit barvu</h2>
          <div className="btnrow">
            <input
              type="color"
              value={solidColor}
              onChange={(e) => setSolidColor(e.target.value)}
            />
            <button
              className="btn sm"
              type="button"
              disabled={busy || !connected}
              onClick={() =>
                withBusy("Nastavuji barvu…", async () => {
                  const r = parseInt(solidColor.slice(1, 3), 16)
                  const g = parseInt(solidColor.slice(3, 5), 16)
                  const b = parseInt(solidColor.slice(5, 7), 16)
                  await ble.current.setSolidColor(r, g, b)
                  // Deska si barvu uloží jako klidový stav; srovnej UI, aby ji
                  // živý zápis konfigurace hned nepřepsal zpátky na "edge".
                  setIdleDisplayMode("solid")
                })
              }
            >
              Nastavit barvu na celý pásek
            </button>
          </div>
          <p className="app__muted">
            Nedestruktivní — nepřepíše rozmalovaný motiv. Návrat k obrazu: Play/Trigger.
          </p>

          <h2>Živý náhled</h2>
          <label className="ck">
            <input
              type="checkbox"
              checked={drawLive}
              onChange={(e) => setDrawLive(e.target.checked)}
            />
            Posílat sloupec (preview)
          </label>
          <label className="ck">
            <input type="checkbox" checked={fixed} onChange={(e) => setFixed(e.target.checked)} />
            Fixní sloupec
          </label>
          <label>Sloupec</label>
          <input
            type="number"
            min={1}
            max={colN}
            value={activeCol + 1}
            onChange={(e) => {
              const n = Math.min(colN, Math.max(1, +e.target.value || 1))
              setActiveCol(n - 1)
              if (drawLive) schedulePreview()
            }}
          />
          <label>Debounce (ms)</label>
          <input
            type="number"
            min={0}
            max={2000}
            value={previewMs}
            onChange={(e) => setPreviewMs(+e.target.value || 0)}
          />

          <h2>Nástroje</h2>
          <select
            className="tool"
            value={tool}
            onChange={(e) => setTool(e.target.value as Tool)}
          >
            {TOOLS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <label>Barva</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />

          <h2>Obraz</h2>
          <div className="btnrow">
            <label className="btn btn--file">
              Otevřít obrázek
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ""
                  if (!f) return
                  const u = URL.createObjectURL(f)
                  const img = new Image()
                  img.decoding = "async"
                  img.src = u
                  await new Promise((res, rej) => {
                    img.onload = res
                    img.onerror = rej
                  })
                  const frame = loadImageDataToFrame(img, colN, ledN)
                  fr.current = frame
                  setColN(frame.width)
                  setLedN(frame.height)
                  URL.revokeObjectURL(u)
                  setActiveCol(0)
                  bump()
                }}
              />
            </label>
            <button
              className="btn"
              type="button"
              onClick={async () => {
                const b = await bitmapToPngBlob(fr.current, 4)
                if (b) triggerDownload(b, "paintbar.png")
              }}
            >
              Uložit PNG
            </button>
          </div>
          <button
            className="btn"
            type="button"
            onClick={() => {
              syncSize(colN, ledN)
            }}
          >
            Použít rozměry
          </button>

          <Gallery
            currentConfig={() => toCfg(false)}
            currentFrame={() => fr.current}
            push={push}
            onLoad={(cfg, frame) => {
              initializedRef.current = false
              fr.current = frame
              setLedN(cfg.led_count)
              setColN(cfg.column_count)
              setPeriod(cfg.fixed_column_period_us)
              setBrightnessPct(Math.round(((cfg.max_brightness ?? 128) / 255) * 100))
              setPeriodM(cfg.period_mode)
              setPlayM(cfg.playback_mode)
              setStartM(cfg.start_mode)
              setTriggerButtonMode(cfg.trigger_button_mode ?? "one_shot")
              setIdleDisplayMode(cfg.idle_display_mode ?? "edge")
              setSolidColor(solidColorHex(cfg))
              setActiveCol(0)
              bump()
              initializedRef.current = true
            }}
          />
        </section>
        <section className="app__main">
          <div className="canvasbox">
            <EditorCanvas
              frame={fr.current}
              tick={ver}
              color={color}
              tool={tool}
              activeColumn={activeCol}
              fixedColumn={drawLive && fixed}
              onColumnChange={(c) => {
                setActiveCol(c)
                if (drawLive) schedulePreview()
              }}
              onChange={() => {
                bump()
                if (drawLive) schedulePreview()
              }}
            />
          </div>
        </section>
      </div>

      <section className="app__log">
        <h2>Log</h2>
        <pre>{log.join("\n")}</pre>
      </section>
    </div>
  )
}
