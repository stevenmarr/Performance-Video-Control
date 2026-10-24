import streamDeck from "@elgato/streamdeck";

import { controlCenterBase, DECK_PATH, plan, type DeckPlan, type DeckSnapshot } from "../../lib/deck.js";

type GlobalSettings = { host?: string; port?: number };

/**
 * One HTTP client for every key and dial. It long-polls the deck snapshot and posts the
 * requests `plan()` returns. Those paths are Control Center routes. Nothing here knows a camera address.
 */
class Bridge {
	base = "http://127.0.0.1:8080";
	snap: DeckSnapshot | null = null;
	page = "live";
	private gen = 0;
	private stopped = false;
	private chain: Promise<void> = Promise.resolve();
	private wait: ReturnType<typeof setTimeout> | null = null;
	private views = new Map<string, () => Promise<void>>();

	configure(settings: GlobalSettings = {}): void {
		let next = this.base;
		try {
			next = controlCenterBase(settings);
		} catch (e) {
			streamDeck.logger.warn(`${e instanceof Error ? e.message : e}`);
			return;
		}
		if (next === this.base && this.gen > 0) return;
		this.base = next;
		this.restart();
	}

	start(): void {
		this.stopped = false;
		this.restart();
	}

	private restart(): void {
		if (this.wait) clearTimeout(this.wait);
		this.gen += 1;
		void this.loop(this.gen);
	}

	private async loop(gen: number): Promise<void> {
		let since = -1;
		while (!this.stopped && gen === this.gen) {
			try {
				const res = await fetch(`${this.base}${DECK_PATH}?since=${since}&timeout=25000`);
				if (gen !== this.gen) return;
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const snap = (await res.json()) as DeckSnapshot;
				since = Number(snap.rev) || since;
				this.snap = snap;
				await this.repaint();
			} catch (e) {
				if (gen !== this.gen || this.stopped) return;
				streamDeck.logger.warn(`Control Center: ${e instanceof Error ? e.message : e}`);
				this.snap = null;
				await this.repaint();
				await new Promise<void>((resolve) => {
					this.wait = setTimeout(resolve, 1000);
				});
			}
		}
	}

	watch(id: string, paint: () => Promise<void>): void {
		this.views.set(id, paint);
		void paint().catch((e) => streamDeck.logger.warn(String(e)));
	}

	unwatch(id: string): void {
		this.views.delete(id);
	}

	async repaint(): Promise<void> {
		for (const paint of this.views.values()) {
			try {
				await paint();
			} catch (e) {
				streamDeck.logger.warn(String(e));
			}
		}
	}

	/** Send the Control Center calls for one gesture. Failures are logged, not thrown to Stream Deck. */
	async perform(gesture: Record<string, unknown>): Promise<DeckPlan> {
		const planned = plan({ ...gesture, snapshot: this.snap });
		if (planned.page) this.page = planned.page;
		const job = this.chain.then(async () => {
			for (const r of planned.requests) {
				const res = await fetch(`${this.base}${r.path}`, {
					method: r.method,
					headers: { "content-type": "application/json" },
					body: JSON.stringify(r.body ?? {}),
				});
				if (!res.ok) {
					let message = `HTTP ${res.status}`;
					try {
						const body = (await res.json()) as { error?: string };
						if (body.error) message = body.error;
					} catch { /* the status is enough */ }
					throw new Error(message);
				}
			}
		});
		this.chain = job.then(() => undefined, () => undefined);
		try {
			await job;
		} catch (e) {
			streamDeck.logger.warn(`${e instanceof Error ? e.message : e}`);
		}
		if (planned.open) {
			try {
				await streamDeck.system.openUrl(`${this.base}${planned.open}`);
			} catch (e) {
				streamDeck.logger.warn(`Open Control Center: ${e instanceof Error ? e.message : e}`);
			}
		}
		return planned;
	}
}

export const bridge = new Bridge();
