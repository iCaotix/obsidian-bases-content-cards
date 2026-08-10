import type { App, TFile } from 'obsidian';

interface CacheEntry {
	mtime: number;
	text: string;
}

/**
 * Bridges the gap between Bases and the file system: `onDataUpdated()` is
 * synchronous, reading a file is not. Lookups are synchronous and may miss;
 * a miss schedules a read and the view is told to fill that card in later.
 *
 * On a second render the text is already here, so nothing moves at all.
 */
export class ContentCache {
	private entries = new Map<string, CacheEntry>();
	private pending = new Set<string>();

	constructor(
		private readonly app: App,
		private readonly onLoaded: (path: string) => void,
	) {}

	/** Null when the file has not been read yet, or the copy is older than the file. */
	get(file: TFile): string | null {
		const entry = this.entries.get(file.path);
		if (!entry || entry.mtime !== file.stat.mtime) return null;
		return entry.text;
	}

	/** Idempotent — calling it for a card that is already loading does nothing. */
	request(file: TFile): void {
		if (this.pending.has(file.path) || this.get(file) !== null) return;

		this.pending.add(file.path);
		const mtime = file.stat.mtime;

		this.app.vault
			.cachedRead(file)
			.then((text) => {
				this.entries.set(file.path, { mtime, text });
				this.pending.delete(file.path);
				this.onLoaded(file.path);
			})
			.catch(() => {
				this.pending.delete(file.path);
			});
	}

	invalidate(path: string): void {
		this.entries.delete(path);
	}

	clear(): void {
		this.entries.clear();
		this.pending.clear();
	}
}
