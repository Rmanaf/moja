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

	// 3. Command: Moja - Check File for Mojibake
	// Re-runs the same scan used on file open, but reports the outcome even
	// when nothing is found (the automatic scan stays silent in that case).
	context.subscriptions.push(
		vscode.commands.registerTextEditorCommand(
			'moja.checkFileForMojibake',
			(editor: vscode.TextEditor) => {
				const result = scanDocument(editor.document);
				switch (result.status) {
					case 'unsupported':
						void vscode.window.showInformationMessage(
							'Moja: This file cannot be scanned (unsaved or non-file documents are skipped).'
						);
						break;
					case 'too-large':
						void vscode.window.showInformationMessage(
							'Moja: This file is too large to scan (over 2,000,000 characters).'
						);
						break;
					case 'disabled':
						void vscode.window.showInformationMessage(
							'Moja: Mojibake detection is turned off in Settings.'
						);
						break;
					case 'clean':
						void vscode.window.showInformationMessage(
							`Moja: No mojibake detected in "${baseName(editor.document)}".`
						);
						break;
					case 'found':
						notifyMojibake(editor.document, result.count, result.first);
						break;
				}
			}
		)
	);
}

function onOpenDocument(doc: vscode.TextDocument): void {
	const result = scanDocument(doc);
	// The automatic scan stays silent unless mojibake above the threshold was
	// actually found; the manual "Check File" command reports every outcome.
	if (result.status === 'found') {
		notifyMojibake(doc, result.count, result.first);
	}
}

type ScanResult =
	| { status: 'disabled' }
	| { status: 'unsupported' }
	| { status: 'too-large' }
	| { status: 'clean' }
	| { status: 'found'; count: number; first: vscode.Position | undefined };

const MAX_SCAN_LENGTH = 2_000_000;

/**
 * The single source of truth for mojibake scanning, shared by the automatic
 * on-open check and the manual "Check File for Mojibake" command.
 */
function scanDocument(doc: vscode.TextDocument): ScanResult {
	const cfg = vscode.workspace.getConfiguration('moja');
	if (!cfg.get<boolean>('enableMojibakeDetection', true)) {
		return { status: 'disabled' };
	}
	// Skip binary-ish / untitled documents.
	if (doc.uri.scheme !== 'file' || doc.isUntitled) {
		return { status: 'unsupported' };
	}
	const text = doc.getText();
	if (text.length > MAX_SCAN_LENGTH) {
		return { status: 'too-large' };
	}
	const count = countMojibake(text);
	const threshold = Math.max(1, cfg.get<number>('detectionThreshold', 3));
	if (count < threshold) {
		return { status: 'clean' };
	}
	return { status: 'found', count, first: findFirstMojibake(doc) };
}

/** Filename without directories, for compact notifications. */
function baseName(doc: vscode.TextDocument): string {
	return doc.fileName.split(/[\\/]/).pop() || doc.fileName;
}

/** Shows the warning with its action buttons for a document known to contain mojibake. */
function notifyMojibake(doc: vscode.TextDocument, count: number, first: vscode.Position | undefined): void {
	const actions = first ? [GOTO_ACTION, ENCODE_ACTION] : [ENCODE_ACTION];
	void vscode.window.showWarningMessage(
		`Moja: ${count} suspicious mojibake sequence${count === 1 ? '' : 's'} detected in "${baseName(doc)}". ` +
		`Use "Moja: Encode Selection to UTF-8" to fix it.`,
		...actions
	).then(action => {
		if (action === ENCODE_ACTION) {
			void vscode.commands.executeCommand('moja.encodeSelectionToUtf8');
		} else if (action === GOTO_ACTION && first) {
			void revealMojibake(doc.uri, first);
		}
	});
}

const GOTO_ACTION = 'Go to First Match';
const ENCODE_ACTION = 'Encode Selection to UTF-8';

/**
 * Finds the first mojibake occurrence in the document, scanning patterns in
 * order and returning the earliest-position match across all of them.
 * Returns undefined when nothing matches (e.g. the document changed since the
 * detection scan).
 */
function findFirstMojibake(doc: vscode.TextDocument): vscode.Position | undefined {
	let best: vscode.Position | undefined;
	for (const re of MOJIBAKE_PATTERNS) {
		// Fresh global regex per scan so lastIndex state cannot leak.
		const rx = new RegExp(re.source, re.flags);
		const m = rx.exec(doc.getText());
		if (!m) {
			continue;
		}
		const pos = doc.positionAt(m.index);
		if (!best || pos.line < best.line || (pos.line === best.line && pos.character < best.character)) {
			best = pos;
		}
	}
	return best;
}

/**
 * Opens the document (if needed), moves the cursor to `pos`, selects the word
 * so the mojibake is visually obvious, and centers it in the viewport.
 */
async function revealMojibake(uri: vscode.Uri, pos: vscode.Position): Promise<void> {
	const editor = await vscode.window.showTextDocument(uri, { preserveFocus: false });
	const wordRange = editor.document.getWordRangeAtPosition(pos) ?? new vscode.Range(pos, pos);
	editor.selection = new vscode.Selection(wordRange.start, wordRange.end);
	editor.revealRange(wordRange, vscode.TextEditorRevealType.InCenter);
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
