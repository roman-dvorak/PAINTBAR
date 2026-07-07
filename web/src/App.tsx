import { useCallback, useEffect, useRef, useState } from "react"
import { EditorCanvas, type Tool, TOOLS } from "./components/EditorCanvas"
import { type PlaybackConfig, ControlCommand } from "./lib/protocol"
import { BitmapFrame } from "./lib/bitmap"
import { PaintbarBle } from "./lib/paintbarBle"
import { bitmapToPngBlob, loadImageDataToFrame, triggerDownload } from "./lib/exportPng"
import "./App.css"

function useFrame() {
  const ref = useRef<BitmapFrame>(new BitmapFrame(64, 160))
  const [n, setN] = useState(0)
  const refresh = useCallback(() => {
    setN((x) => x + 1)
  }, [])
  return { ref, ver: n, refresh }
}

export default function App() {
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
  const [maxBrightness, setMaxBrightness] = useState(128)
  const [periodM, setPeriodM] = useState("fixed")
  const [playM, setPlayM] = useState("loop")
  const [startM, setStartM] = useState("auto")

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
      fixed_column_period_us: period,
      max_brightness: maxBrightness,
      auto_start_after_upload: auto,
    }
  }

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
      await ble.current.requestDevice()
      await ble.current.connect()
      setConnected(true)
      const c = await ble.current.readConfig()
      if (c.led_count > 0 && c.column_count > 0) {
        setLedN(c.led_count)
        setColN(c.column_count)
        setPeriod(c.fixed_column_period_us)
        setMaxBrightness(c.max_brightness ?? 128)
        setPeriodM(c.period_mode)
        setPlayM(c.playback_mode)
        setStartM(c.start_mode)
        fr.current.resize(c.column_count, c.led_count)
        bump()
      }
    })

  const onDisconnect = () =>
    withBusy("Odpojuji…", async () => {
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
              min={1}
              value={period}
              onChange={(e) => setPeriod(Math.max(1, +e.target.value || 1))}
            />
            <label>Max. jas</label>
            <div className="rangefield">
              <input
                type="range"
                min={0}
                max={255}
                value={maxBrightness}
                onChange={(e) => setMaxBrightness(Math.max(0, Math.min(255, +e.target.value || 0)))}
              />
              <span>{maxBrightness}</span>
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
          </div>
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
                  setLedN(c.led_count)
                  setColN(c.column_count)
                  setPeriod(c.fixed_column_period_us)
                  setMaxBrightness(c.max_brightness ?? 128)
                  setPeriodM(c.period_mode)
                  setPlayM(c.playback_mode)
                  setStartM(c.start_mode)
                  fr.current.resize(c.column_count, c.led_count)
                  bump()
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
                setLedN(c.led_count)
                setColN(c.column_count)
                setPeriod(c.fixed_column_period_us)
                setMaxBrightness(c.max_brightness ?? 128)
                setPeriodM(c.period_mode)
                setPlayM(c.playback_mode)
                setStartM(c.start_mode)
                const got = await ble.current.downloadBitmap(c.column_count, c.led_count, onProgress)
                fr.current = got
                bump()
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
