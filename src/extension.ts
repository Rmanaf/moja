import * as vscode from 'vscode';

/**
 * Common mojibake patterns — these are the typical results of UTF-8 text
 * being decoded as Windows-1252 / Latin-1 (and similar double-encodings).
 */
const MOJIBAKE_PATTERNS: RegExp[] = [
	// UTF-8 read as CP1252/Latin-1: Ã©, â€™, Ð¸, å…¬, Ù…Ø±Ø­Ø¨Ø§ ...
	/[\u00C0-\u00FF][\u0080-\u00BF]/g,
	// Classic "â€" / "â€™" smart-quote and dash artifacts
	/â€[\u0080-\u00BF\u2013\u2019\u201c\u201d\u2122\u0153\u0152]/g,
	// "ï¿½" replacement-char artifacts / "Â " artifacts
	/ï¿½/g,
	/Â[\u00A0-\u00BF]/g,
	// Unicode "replacement character" (U+FFFD)
	/\uFFFD/g,
];

export function activate(context: vscode.ExtensionContext) {

	// 1. Mojibake detection on file open
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(onOpenDocument)
	);

	// Also scan the active editor at activation (covers files already open).
	const active = vscode.window.activeTextEditor;
	if (active) {
		onOpenDocument(active.document);
	}

	// 2. Command: Moja - Encode Selection to UTF-8
	context.subscriptions.push(
		vscode.commands.registerTextEditorCommand(
			'moja.encodeSelectionToUtf8',
			async (editor: vscode.TextEditor) => {
				const edits = buildEncodeEdits(editor);
				if (edits.length === 0) {
					vscode.window.showInformationMessage(
						'Moja: Nothing to encode — place the cursor inside a word or select some text.'
					);
					return;
				}
				const ok = await editor.edit(editBuilder => {
					for (const e of edits) {
						editBuilder.replace(e.range, e.newText);
					}
				});
				if (ok) {
					vscode.window.showInformationMessage(
						`Moja: Encoded ${edits.length} ${edits.length === 1 ? 'selection' : 'regions'} to UTF-8.`
					);
				}
			}
		)
	);
}

function onOpenDocument(doc: vscode.TextDocument): void {
	const cfg = vscode.workspace.getConfiguration('moja');
	if (!cfg.get<boolean>('enableMojibakeDetection', true)) {
		return;
	}
	// Skip binary-ish / huge files.
	if (doc.uri.scheme !== 'file' || doc.isUntitled) {
		return;
	}
	const text = doc.getText();
	if (text.length > 2_000_000) {
		return;
	}
	const count = countMojibake(text);
	const threshold = Math.max(1, cfg.get<number>('detectionThreshold', 3));
	if (count >= threshold) {
		void vscode.window.showWarningMessage(
			`Moja: ${count} suspicious mojibake sequence${count === 1 ? '' : 's'} detected in "${doc.fileName.split(/[\\/]/).pop() || doc.fileName}". ` +
			`Use "Moja: Encode Selection to UTF-8" to fix it.`,
			'Encode Selection to UTF-8'
		).then(action => {
			if (action === 'Encode Selection to UTF-8') {
				void vscode.commands.executeCommand('moja.encodeSelectionToUtf8');
			}
		});
	}
}

function countMojibake(text: string): number {
	let count = 0;
	for (const re of MOJIBAKE_PATTERNS) {
		const matches = text.match(re);
		if (matches) {
			count += matches.length;
		}
	}
	return count;
}

interface EncodeEdit {
	range: vscode.Range;
	newText: string;
}

/**
 * For each selection: if it is empty, expand to the word at the cursor.
 * The text is "mojibake-decoded" (Latin-1/CP1252 chars mapped back to their
 * original UTF-8 bytes) and the result is written back as proper UTF-8 text.
 */
function buildEncodeEdits(editor: vscode.TextEditor): EncodeEdit[] {
	const edits: EncodeEdit[] = [];
	for (const sel of editor.selections) {
		const range = sel.isEmpty
			? editor.document.getWordRangeAtPosition(sel.active) || sel
			: sel;
		if (range.isEmpty) {
			continue;
		}
		const original = editor.document.getText(range);
		const encoded = encodeToUtf8(original);
		if (encoded !== original) {
			edits.push({ range, newText: encoded });
		}
	}
	return edits;
}

/**
 * Rebuilds the original UTF-8 string from mojibake:
 * 1. Interpret each character code (with CP1252 quirks) as a byte value.
 * 2. Decode that byte sequence as UTF-8.
 * Returns the input unchanged when the text is not a CP1252 mis-decode of
 * valid UTF-8 (e.g. already-correct non-ASCII text).
 */
export function encodeToUtf8(input: string): string {
	if (!input) {
		return input;
	}
	const bytes: number[] = [];
	for (const ch of input) {
		const byte = cp1252ToByte(ch.codePointAt(0)!);
		if (byte === undefined) {
			// A character that was never part of a CP1252 mis-decode
			// (e.g. already-correct Chinese/Arabic text) — leave the whole
			// string alone rather than mangling it.
			return input;
		}
		bytes.push(byte);
	}
	try {
		const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
		return decoded;
	} catch {
		return input; // Not a valid UTF-8 byte sequence — leave as-is.
	}
}

const CP1252_HOLE: Record<number, number> = {
	0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
	0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
	0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
	0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
	0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
	0x017E: 0x9E, 0x0178: 0x9F,
};

/** Character code -> byte, inverted from CP1252_HOLE (built once at load). */
const CP1252_HOLE_REVERSE: Record<number, number> = Object.create(null) as Record<number, number>;
for (const charStr of Object.keys(CP1252_HOLE)) {
	CP1252_HOLE_REVERSE[Number(charStr)] = CP1252_HOLE[Number(charStr)];
}

/**
 * Maps a character code back to the byte CP1252 would have produced for it.
 * Returns undefined when the character is not representable in CP1252, which
 * means the text was not created by a CP1252 mis-decode.
 */
function cp1252ToByte(c: number): number | undefined {
	if (c <= 0x7F) {
		return c; // ASCII passes through untouched
	}
	if (c >= 0xA0 && c <= 0xFF) {
		return c; // Latin-1 range is identical in CP1252
	}
	// The 0x80-0x9F hole: CP1252 maps these bytes to the punctuation chars below
	if (CP1252_HOLE_REVERSE[c] !== undefined) {
		return CP1252_HOLE_REVERSE[c];
	}
	// U+0080-U+009F are control chars in Latin-1; they survive as bytes too
	if (c >= 0x80 && c <= 0x9F) {
		return c;
	}
	return undefined;
}

export function deactivate() { }
