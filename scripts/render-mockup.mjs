import process from 'node:process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'

if (process.platform === 'darwin') app.dock.hide()
app.disableHardwareAcceleration()

const [inputArg, outputArg] = process.argv.slice(2).filter((arg) => arg !== '--')

if (!inputArg || !outputArg) {
  console.error('Usage: pnpm run render:mockup -- <input.html> <output.png>')
  process.exit(2)
}

const inputPath = resolve(inputArg)
const outputPath = resolve(outputArg)
const log = (...args) => console.log('[render:mockup]', ...args)

let window
let temporaryDirectory
let timeout
let finished = false

function cleanup() {
  if (window && !window.isDestroyed()) window.destroy()
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
}

function finish(code) {
  if (finished) return
  finished = true
  if (timeout) clearTimeout(timeout)
  cleanup()

  if (app.isReady()) app.exit(code)
  else process.exit(code)
}

function fail(error, code = 1) {
  console.error('[render:mockup]', error instanceof Error ? error.stack : error)
  finish(code)
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    console.error(`[render:mockup] Received ${signal}`)
    finish(code)
  })
}

timeout = setTimeout(() => {
  fail(new Error('Rendering timed out after 25 seconds'), 3)
}, 25_000)

app.whenReady().then(async () => {
  try {
    const html = readFileSync(inputPath, 'utf8')
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'ua-mockup-'))
    const temporaryHtml = join(temporaryDirectory, 'mockup.html')
    writeFileSync(temporaryHtml, html)

    window = new BrowserWindow({
      width: 1160,
      height: 2600,
      show: false,
      backgroundColor: '#0f1011',
      webPreferences: { offscreen: true }
    })

    window.webContents.on('console-message', (_event, _level, message) => {
      log('page:', message)
    })

    await window.loadFile(temporaryHtml)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 700))

    const contentHeight = await window.webContents.executeJavaScript(`
      const body = document.body;
      const bottom = body.getBoundingClientRect().bottom + scrollY;
      const margin = parseFloat(getComputedStyle(body).marginBottom) || 0;
      Math.ceil(Math.max(body.scrollHeight, bottom + margin));
    `)
    const height = Math.min(4200, Math.max(1, Math.ceil(Number(contentHeight) || 2600)))
    window.setContentSize(1160, height)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400))

    const image = await window.webContents.capturePage()
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, image.toPNG())
    log(`Saved ${outputPath} (${image.getSize().width}x${image.getSize().height})`)
    finish(0)
  } catch (error) {
    fail(error)
  }
}).catch(fail)
