# Handwriting OCR

A desktop app that transcribes handwritten documents, built for historical German scripts such as Kurrent and Sütterlin.

![Handwriting OCR screenshot](docs/handwriting-ocr-screenshot.png)

You upload a scan (PDF or image), the app sends each page to a vision model through [OpenRouter](https://openrouter.ai/), and the transcription appears next to the original while it is being written.

## Install

Download the latest installer from the [Releases page](https://github.com/okreitz/handwriting-ocr/releases/latest).

### Windows

1. Download `Handwriting-OCR-Setup-<version>.exe` and double-click it.
2. Windows shows a blue "Windows protected your PC" box, because the installer is not code-signed. Click **More info**, then **Run anyway**.
3. The app installs for your user account (no administrator password needed), adds a desktop and Start-menu shortcut, and starts.

### macOS

1. Download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), open it and drag the app to Applications.
2. The app is not notarised by Apple, so the first start is blocked. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.

### First start

The app opens its Settings on first start. Paste an OpenRouter API key (create one at [openrouter.ai/keys](https://openrouter.ai/keys)), click **Load models**, then **Save settings**.

## Using it

1. Click **Upload document** and choose a PDF, PNG, JPG or WEBP.
2. Optionally limit a long PDF with the **Pages** field: `1-4`, `2,5`, or `10-` for page 10 to the end. Empty means the whole document.
3. Click **Transcribe**. Several pages are read at the same time and the text streams in as the model writes it. **Stop** cancels the run.
4. Move between pages with the page selector. The preview follows along.
5. **Save page .txt** saves the page you are looking at, **Save all .txt** saves the whole document with `--- Page N ---` separators.

Good to know:

- Readings the model is unsure of are in `[square brackets]`, unreadable words are marked `[illegible]`.
- A page you have transcribed before loads instantly from a local cache and costs nothing. **Re-run page** asks the model again.
- If one page fails, the others still finish. The failed page is marked in the page selector with the reason shown above the text.
- Large images are scaled down to 2400 pixels on the long edge before upload. Models do not read more detail than that, and it makes uploads much faster.

## Settings

| Setting | What it does |
| --- | --- |
| API key | Your OpenRouter key. In the desktop app it is stored encrypted with the operating system keychain and is never shown again after saving. |
| Reading model | The vision model that reads the page. **Fast** (`google/gemini-4-carbon`) is the default, **Best quality** is `anthropic/claude-fable-5.2`, **Budget** is `google/gemini-3.8-flash`. Any other image-capable OpenRouter model can be picked from the list. |
| Correction pass | Optional second model call that cleans up each page. Off by default: it doubles the calls per page and only sees the text, not the image. |
| Advanced | Pages read at the same time (default 4; lower it if OpenRouter rate-limits you), base URL, app name and referer sent to OpenRouter. |

The presets follow a public Kurrent benchmark from November 2026. Handwriting varies a lot, so compare the presets on a few of your own pages before a big job.

Settings, the result cache and the model list are stored in the app data folder:

- Windows: `%APPDATA%\handwriting-ocr\data`
- macOS: `~/Library/Application Support/handwriting-ocr/data`
- Running from source in a browser: `data/` inside the project folder

## Privacy

The app runs on your computer. PDFs are split into single pages locally, and only the pages you transcribe are sent to OpenRouter and the model provider you chose. Nothing else leaves the machine. The built-in local server only accepts requests from the app itself.

## Development

Requires Node.js 20 or newer.

```bash
npm install
```

Run in the browser (starts a local server on `http://127.0.0.1:3000` and opens it):

```bash
npm start
```

Run as a desktop app:

```bash
npm run desktop
```

Run the tests:

```bash
npm test
```

### Project layout

| Path | Role |
| --- | --- |
| `server/index.js` | Local HTTP server: static files, settings, model list, `/api/transcribe` |
| `server/transcription-service.js` | Page pipeline: concurrency, cache, optional correction |
| `server/openrouter.js` | Streaming OpenRouter client with retries and timeouts |
| `server/pdf-pages.js` | Page-range parsing and PDF splitting (`pdf-lib`) |
| `server/settings-store.js` | Defaults, settings file, API key handling |
| `public/` | The UI, plain HTML, CSS and ES modules with no build step |
| `desktop/main.js` | Electron shell around the local server |

`/api/transcribe` takes the document as the raw request body and answers with newline-delimited JSON: `start`, `page-delta` (streamed text), `page` (finished page) and `done`.

## Building installers

Releases are built by GitHub Actions. Push a version tag and the workflow in `.github/workflows/release.yml` builds the Windows installer and the macOS disk images and attaches them to a draft release:

```bash
git tag v0.2.0
```

```bash
git push origin v0.2.0
```

Review the draft on GitHub and publish it.

To build locally instead:

```bash
npm run dist -- --win
```

```bash
npm run dist -- --mac
```

The files land in `dist/`. The Windows installer can be built on a Mac. Neither installer is code-signed.
