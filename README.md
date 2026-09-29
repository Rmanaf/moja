# Moja

<img src="https://raw.githubusercontent.com/Rmanaf/moja/main/icon.png" alt="Moja icon" width="128" height="128" />

Are you suffering from **mojibake**? Meet Moja! Your VSCode cure.

Moja detects **mojibake** (text that was saved as UTF-8 but read with the wrong encoding, producing things like `Ã©`, `â€™`, `Ð¸`) when you open a file, and gives you a one-keystroke fix.

## Features

### 1. Mojibake detection on file open
When you open a file, Moja scans its contents for sequences that look like mis-decoded UTF-8 (UTF-8 bytes read as Windows-1252 / Latin-1, `U+FFFD` replacement characters, etc.). If enough suspicious sequences are found, you get a notification so you know the file's text is corrupted.

Configure the sensitivity from Settings:

- `moja.enableMojibakeDetection` — turn detection on/off (default: on)
- `moja.detectionThreshold` — how many suspicious sequences trigger a notification (default: 3)

### 2. Moja: Encode Selection to UTF-8
Select the mojibake text (or just place the cursor inside it) and run **Moja: Encode Selection to UTF-8** from the Command Palette (`Ctrl+Shift+P`), or use the shortcut:

- **Windows/Linux:** `Ctrl+Shift+8`
- **macOS:** `Cmd+Shift+8`

The selection is re-encoded: the mojibake characters are mapped back to their original UTF-8 bytes and replaced with the correctly-decoded text.


## Extension Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `moja.enableMojibakeDetection` | boolean | `true` | Detect mojibake on file open |
| `moja.detectionThreshold` | number | `3` | Minimum suspicious sequences to notify |

## Development

```bash
npm install
npm run compile     # build once
npm run watch       # rebuild on change
```

Press `F5` in VS Code to launch an Extension Development Host with Moja loaded.

To build the installable package:

```bash
npx @vscode/vsce package
```

## License

MIT
