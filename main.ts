import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { spawn } from "child_process";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QmdResult {
	docid: string;
	score: number;
	file: string;
	title?: string;
	collection?: string;
	context?: string;
	snippet?: string;
	[key: string]: unknown;
}

interface QmdSearchSettings {
	qmdPath: string;
	collection: string;
	resultCount: number;
	extraPath: string;
	debugLogging: boolean;
}

const DEFAULT_SETTINGS: QmdSearchSettings = {
	qmdPath: "qmd",
	collection: "obsidian",
	resultCount: 16,
	extraPath: "",
	debugLogging: false,
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class QmdSearchPlugin extends Plugin {
	settings: QmdSearchSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "qmd-search",
			name: "Keyword search (fast)",
			callback: () => {
				new QmdSearchModal(this.app, this, "search").open();
			},
		});

		this.addCommand({
			id: "qmd-vsearch",
			name: "Semantic search",
			callback: () => {
				new QmdSearchModal(this.app, this, "vsearch").open();
			},
		});

		this.addCommand({
			id: "qmd-query",
			name: "Hybrid search (best quality)",
			callback: () => {
				new QmdSearchModal(this.app, this, "query").open();
			},
		});

		this.addSettingTab(new QmdSearchSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ---------------------------------------------------------------------------
// Search Modal
// ---------------------------------------------------------------------------

class QmdSearchModal extends Modal {
	plugin: QmdSearchPlugin;

	private inputEl!: HTMLInputElement;
	private statusEl!: HTMLDivElement;
	private resultsEl!: HTMLDivElement;
	private results: QmdResult[] = [];
	private selectedIndex = -1;
	private abortController: AbortController | null = null;
	private mode: string;

	private static readonly MODE_LABELS: Record<string, string> = {
		search: "Keyword search",
		vsearch: "Semantic search",
		query: "Hybrid search",
	};

	constructor(app: App, plugin: QmdSearchPlugin, mode: string) {
		super(app);
		this.plugin = plugin;
		this.mode = mode;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		modalEl.addClass("qmd-search-modal");

		const inputContainer = contentEl.createDiv({ cls: "qmd-input-container" });
		this.inputEl = inputContainer.createEl("input", {
			type: "text",
			placeholder: `${QmdSearchModal.MODE_LABELS[this.mode] || this.mode}...`,
			cls: "qmd-search-input",
		});

		this.statusEl = contentEl.createDiv({ cls: "qmd-status" });
		this.statusEl.style.display = "none";

		this.resultsEl = contentEl.createDiv({ cls: "qmd-results" });

		// Reset selection when user focuses or types in the input,
		// so Enter always triggers a new search from the input.
		this.inputEl.addEventListener("focus", () => {
			this.selectedIndex = -1;
			this.highlightSelected();
		});
		this.inputEl.addEventListener("input", () => {
			this.selectedIndex = -1;
			this.highlightSelected();
		});

		this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.isComposing) {
				if (this.selectedIndex >= 0 && this.results.length > 0) {
					this.openResult(this.results[this.selectedIndex]);
				} else {
					e.preventDefault();
					this.runSearch(this.inputEl.value.trim());
				}
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				this.moveSelection(1);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				this.moveSelection(-1);
			} else if (e.key === "Escape") {
				if (this.selectedIndex >= 0) {
					e.preventDefault();
					e.stopPropagation();
					this.selectedIndex = -1;
					this.highlightSelected();
				}
			}
		});

		this.inputEl.focus();
	}

	onClose() {
		this.abortController?.abort();
		this.contentEl.empty();
	}

	// --- Search execution ------------------------------------------------

	private runSearch(query: string) {
		if (!query) return;

		this.abortController?.abort();
		this.abortController = new AbortController();

		this.results = [];
		this.selectedIndex = -1;
		this.resultsEl.empty();
		this.showStatus("searching");

		const { qmdPath, collection, resultCount } = this.plugin.settings;

		const home = homedir();
		const pathParts: string[] = [];

		if (this.plugin.settings.extraPath.trim()) {
			pathParts.push(this.plugin.settings.extraPath.trim());
		}

		pathParts.push(
			`${home}/.bun/bin`,
			`${home}/.local/bin`,
			"/usr/local/bin",
			"/opt/homebrew/bin",
		);

		const env = {
			...process.env,
			HOME: home,
			PATH: `${pathParts.join(":")}:${process.env.PATH || ""}`,
		};

		const args = [this.mode, query, "--json", "-c", collection, "-n", String(resultCount)];
		const child = spawn(qmdPath, args, { env });

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});

		child.on("error", (err: Error) => {
			if (this.abortController?.signal.aborted) return;
			if (this.plugin.settings.debugLogging) {
				console.error("[QMD Search] spawn error:", err);
			}
			this.showStatus("error", err.message);
		});

		child.on("close", (code: number | null) => {
			if (this.abortController?.signal.aborted) return;

			const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
			const stderr = Buffer.concat(stderrChunks).toString("utf-8");

			if (this.plugin.settings.debugLogging) {
				console.debug("[QMD Search] stdout length:", stdout.length, "stderr length:", stderr.length);
			}

			if (code !== 0 && code !== null) {
				const msg = stderr.trim() || `QMD exited with code ${code}`;
				if (this.plugin.settings.debugLogging) {
					console.error("[QMD Search] exit code:", code, "stderr:", stderr);
				}
				this.showStatus("error", msg);
				return;
			}

			try {
				// QMD may print progress lines before the JSON array.
				const jsonStart = stdout.indexOf("[");
				const jsonEnd = stdout.lastIndexOf("]");
				if (jsonStart === -1 || jsonEnd === -1) {
					if (this.plugin.settings.debugLogging) {
						console.error("[QMD Search] No JSON array found. stdout:", stdout.slice(0, 500));
					}
					this.showStatus("empty");
					return;
				}
				const jsonStr = stdout.slice(jsonStart, jsonEnd + 1);

				// QMD snippets may contain literal control characters
				// inside JSON string values. Sanitize before parsing.
				const sanitized = this.sanitizeJson(jsonStr);
				const parsed = JSON.parse(sanitized);
				const items: QmdResult[] = Array.isArray(parsed) ? parsed : [];
				this.results = items;

				if (items.length === 0) {
					this.showStatus("empty");
				} else {
					this.statusEl.style.display = "none";
					this.renderResults(items);
				}
			} catch (parseErr) {
				if (this.plugin.settings.debugLogging) {
					console.error("[QMD Search] JSON parse error:", parseErr);
					console.error("[QMD Search] stdout length:", stdout.length);
				}
				this.showStatus("error", "Failed to parse QMD output." +
					(this.plugin.settings.debugLogging ? " Check console for details." : " Enable debug logging in settings for details."));
			}
		});

		this.abortController.signal.addEventListener("abort", () => {
			child.kill();
		});
	}

	// --- Status display --------------------------------------------------

	private showStatus(state: "searching" | "empty" | "error", errorMsg?: string) {
		this.statusEl.empty();
		this.statusEl.style.display = "flex";

		if (state === "searching") {
			const spinner = this.statusEl.createDiv({ cls: "qmd-spinner" });
			spinner.addClass("loading");
			this.statusEl.createSpan({ text: "Searching..." });
		} else if (state === "empty") {
			this.statusEl.createSpan({ text: "No results found." });
		} else if (state === "error") {
			this.statusEl.createSpan({
				text: errorMsg || "An error occurred.",
				cls: "qmd-error-text",
			});
		}
	}

	// --- Results rendering -----------------------------------------------

	private renderResults(items: QmdResult[]) {
		this.resultsEl.empty();

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const row = this.resultsEl.createDiv({ cls: "qmd-result-item" });

			const headerEl = row.createDiv({ cls: "qmd-result-header" });

			const titleText = item.title || this.fileDisplayName(item.file);
			const titleEl = headerEl.createDiv({ cls: "qmd-result-title" });
			titleEl.setText(titleText);

			const scoreEl = headerEl.createDiv({ cls: "qmd-result-score" });
			scoreEl.setText((item.score * 100).toFixed(0) + "%");

			const filePath = this.cleanFilePath(item.file);
			const pathEl = row.createDiv({ cls: "qmd-result-path" });
			pathEl.setText(filePath);

			const snippetText = this.cleanSnippet(item.snippet || item.context || "");
			if (snippetText) {
				const snippetEl = row.createDiv({ cls: "qmd-result-snippet" });
				snippetEl.setText(
					snippetText.length > 200
						? snippetText.slice(0, 200) + "..."
						: snippetText
				);
			}

			row.addEventListener("click", () => this.openResult(item));
			row.addEventListener("mouseenter", () => {
				this.selectedIndex = i;
				this.highlightSelected();
			});
		}
	}

	// --- Navigation ------------------------------------------------------

	private moveSelection(delta: number) {
		if (this.results.length === 0) return;

		if (this.selectedIndex < 0) {
			this.selectedIndex = delta > 0 ? 0 : this.results.length - 1;
		} else {
			this.selectedIndex += delta;
			if (this.selectedIndex < 0) this.selectedIndex = this.results.length - 1;
			if (this.selectedIndex >= this.results.length) this.selectedIndex = 0;
		}

		this.highlightSelected();
		this.scrollSelectedIntoView();
	}

	private highlightSelected() {
		const items = this.resultsEl.querySelectorAll(".qmd-result-item");
		items.forEach((el, i) => {
			el.toggleClass("is-selected", i === this.selectedIndex);
		});
	}

	private scrollSelectedIntoView() {
		const items = this.resultsEl.querySelectorAll(".qmd-result-item");
		if (this.selectedIndex >= 0 && items[this.selectedIndex]) {
			(items[this.selectedIndex] as HTMLElement).scrollIntoView({ block: "nearest" });
		}
	}

	// --- Open result in Obsidian -----------------------------------------

	private openResult(item: QmdResult) {
		const resolved = this.resolveVaultFile(item.file);
		if (resolved) {
			this.app.workspace.openLinkText(resolved.path, "", false);
		} else {
			const filePath = this.cleanFilePath(item.file);
			const linkPath = filePath.replace(/\.md$/, "");
			new Notice(`Could not resolve file, attempting direct open: ${linkPath}`);
			this.app.workspace.openLinkText(linkPath, "", false);
		}
		this.close();
	}

	private resolveVaultFile(qmdPath: string): { path: string } | null {
		const cleanPath = this.cleanFilePath(qmdPath);
		const qmdFilename = this.normalizeForMatch(
			cleanPath.split("/").pop()?.replace(/\.md$/, "") || ""
		);

		if (!qmdFilename) return null;

		const allFiles = this.app.vault.getMarkdownFiles();

		for (const file of allFiles) {
			const vaultFilename = this.normalizeForMatch(file.basename);
			if (vaultFilename === qmdFilename) {
				return { path: file.path };
			}
		}

		const qmdFullNorm = this.normalizeForMatch(cleanPath.replace(/\.md$/, ""));
		for (const file of allFiles) {
			const vaultPathNorm = this.normalizeForMatch(file.path.replace(/\.md$/, ""));
			if (vaultPathNorm === qmdFullNorm) {
				return { path: file.path };
			}
		}

		return null;
	}

	// --- Helpers ----------------------------------------------------------

	private normalizeForMatch(s: string): string {
		return s.toLowerCase().replace(/\s+/g, "-");
	}

	private cleanFilePath(rawPath: string): string {
		const qmdPrefix = `qmd://${this.plugin.settings.collection}/`;
		if (rawPath.startsWith(qmdPrefix)) {
			return rawPath.slice(qmdPrefix.length);
		}
		const colPrefix = this.plugin.settings.collection + "/";
		if (rawPath.startsWith(colPrefix)) {
			return rawPath.slice(colPrefix.length);
		}
		return rawPath;
	}

	private fileDisplayName(rawPath: string): string {
		const clean = this.cleanFilePath(rawPath);
		const parts = clean.split("/");
		const filename = parts[parts.length - 1] || clean;
		return filename.replace(/\.md$/, "");
	}

	private cleanSnippet(raw: string): string {
		return raw
			.replace(/@@[^@]*@@\s*\([^)]*\)\s*/g, "")
			.replace(/\n+/g, " ")
			.trim();
	}

	private sanitizeJson(raw: string): string {
		const out: string[] = [];
		let inString = false;
		let i = 0;

		while (i < raw.length) {
			const ch = raw[i];

			if (inString) {
				if (ch === "\\") {
					out.push(ch);
					i++;
					if (i < raw.length) {
						out.push(raw[i]);
					}
				} else if (ch === '"') {
					out.push(ch);
					inString = false;
				} else {
					const code = ch.charCodeAt(0);
					if (code < 0x20) {
						switch (ch) {
							case "\n": out.push("\\n"); break;
							case "\r": out.push("\\r"); break;
							case "\t": out.push("\\t"); break;
							default:
								out.push("\\u" + code.toString(16).padStart(4, "0"));
						}
					} else {
						out.push(ch);
					}
				}
			} else {
				if (ch === '"') {
					inString = true;
				}
				out.push(ch);
			}

			i++;
		}

		return out.join("");
	}

	private shellQuote(s: string): string {
		return "'" + s.replace(/'/g, "'\\''") + "'";
	}
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class QmdSearchSettingTab extends PluginSettingTab {
	plugin: QmdSearchPlugin;

	constructor(app: App, plugin: QmdSearchPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Binary path")
			.setDesc(
				"Full path to the qmd binary. If qmd is in your PATH, just 'qmd' works. " +
				"Otherwise use the full path, e.g. /Users/you/.bun/bin/qmd"
			)
			.addText((text) =>
				text
					.setPlaceholder("qmd")
					.setValue(this.plugin.settings.qmdPath)
					.onChange(async (value) => {
						this.plugin.settings.qmdPath = value.trim() || "qmd";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Collection name")
			.setDesc("The collection name pointing to your vault.")
			.addText((text) =>
				text
					.setPlaceholder("obsidian")
					.setValue(this.plugin.settings.collection)
					.onChange(async (value) => {
						this.plugin.settings.collection = value.trim() || "obsidian";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Additional directory to search for bun binary")
			.setDesc(
				"Directory containing the bun binary. QMD needs bun at runtime. " +
				"Run 'which bun' in your terminal and paste the directory part here. " +
				"Example: /Users/you/.nvm/versions/node/v22.13.1/bin"
			)
			.addText((text) =>
				text
					.setPlaceholder("/path/to/directory/containing/bun")
					.setValue(this.plugin.settings.extraPath)
					.onChange(async (value) => {
						this.plugin.settings.extraPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max results")
			.setDesc(
				"Number of results to return per search. " +
				"Increasing beyond 16 may cause errors with longer results due to a known output buffering limitation."
			)
			.addText((text) =>
				text
					.setPlaceholder("16")
					.setValue(String(this.plugin.settings.resultCount))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						this.plugin.settings.resultCount = isNaN(n) || n < 1 ? 16 : n;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Log QMD output to the Obsidian developer console (Cmd+Option+I) when errors occur.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugLogging)
					.onChange(async (value) => {
						this.plugin.settings.debugLogging = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
