import streamDeck from "@elgato/streamdeck";

import { controlCenterBase, DECK_PATH, plan, PLUSXL, type DeckPlan, type DeckSnapshot } from "../../lib/deck.js";

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
	private cells = new Map<string, { id: string; deviceId: string; column: number; row: number; action: any }>();
	private dials = new Map<string, { id: string; deviceId: string; column: number; action: any }>();
	private stacks = new Map<string, Array<{ id: string; title?: string; profile?: string | null; device?: unknown; keys?: Array<Record<string, unknown>> }>>();
	private showing = new Map<string, { id: string; title?: string; profile?: string | null; device?: unknown; keys?: Array<Record<string, unknown>> } | null>();
	private pendingPaint = new Map<string, ReturnType<typeof setTimeout>>();

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

	/** A key that is on screen. Deploy writes the page stack onto these cells. */
	note(cell: { id: string; deviceId: string; column: number; row: number; action: any }): void {
		this.cells.set(cell.id, cell);
		this.schedulePaint(cell.deviceId);
	}

	forget(id: string): void {
		this.cells.delete(id);
		this.unwatch(id);
	}

	/** A knob already on the device. Push assigns it by dial position, left to right. */
	noteDial(cell: { id: string; deviceId: string; column: number; action: any }): void {
		this.dials.set(cell.id, cell);
		if (this.showing.get(cell.deviceId)) void this.paintDials(cell.deviceId);
	}

	forgetDial(id: string): void {
		this.dials.delete(id);
		this.unwatch(id);
	}

	private schedulePaint(deviceId: string): void {
		const page = this.showing.get(deviceId);
		if (!page) return;
		const prev = this.pendingPaint.get(deviceId);
		if (prev) clearTimeout(prev);
		this.pendingPaint.set(deviceId, setTimeout(() => {
			this.pendingPaint.delete(deviceId);
			void this.paintPage(deviceId, page);
		}, 40));
	}

	/**
	 * Store the stack and write it onto the buttons and knobs already on the deck.
	 * Stream Deck does not create keys. The operator fills the deck with Button and Knob.
	 */
	async applyDeploy(deviceId: string, body: { pages?: Array<{ id: string; title?: string; profile?: string | null; device?: unknown; keys?: Array<Record<string, unknown>> }> } = {}): Promise<{ ok: boolean; deviceId: string; loaded: string[]; painted: number }> {
		const pages = Array.isArray(body.pages) ? body.pages : [];
		this.stacks.set(deviceId, pages);
		const first = pages[0] || null;
		this.showing.set(deviceId, first);
		this.page = this.pageName(first);
		await this.paintPage(deviceId, first);
		const knobs = await this.paintDials(deviceId);
		const keys = [...this.cells.values()].filter((c) => c.deviceId === deviceId).length;
		return { ok: true, deviceId, loaded: pages.map((p) => p.title || p.id), painted: keys + knobs };
	}

	/** Page-jump key. A target that is not in the pushed stack is refused. */
	async showPage(deviceId: string, pageId: string): Promise<{ ok: boolean; warning?: string; pageId?: string; title?: string }> {
		const stack = this.stacks.get(deviceId) || [];
		const page = stack.find((p) => p.id === pageId);
		if (!page) return { ok: false, warning: `Page ${pageId} is not on this deck` };
		this.showing.set(deviceId, page);
		this.page = this.pageName(page);
		await this.paintPage(deviceId, page);
		await this.paintDials(deviceId);
		return { ok: true, pageId, title: page.title || pageId };
	}

	/** POST one stamped key action back to Control Center. The path stays on this app. */
	async runAction(action: { method?: string; path?: string; body?: Record<string, unknown> }): Promise<void> {
		const path = String(action?.path || "");
		if (!path.startsWith("/api/") || path.includes("..")) {
			streamDeck.logger.warn(`Refused deck action path ${path}`);
			return;
		}
		try {
			const res = await fetch(`${this.base}${path}`, {
				method: action.method || "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(action.body ?? {}),
			});
			if (!res.ok) {
				let message = `HTTP ${res.status}`;
				try {
					const body = (await res.json()) as { error?: string };
					if (body.error) message = body.error;
				} catch { /* the status is enough */ }
				throw new Error(message);
			}
		} catch (e) {
			streamDeck.logger.warn(`${e instanceof Error ? e.message : e}`);
		}
	}

	private pageName(page: { id?: string; profile?: string | null } | null): string {
		const id = String((page && (page.profile || page.id)) || "");
		if (/paint/i.test(id)) return "paint";
		if (/func/i.test(id)) return "func";
		if (/move/i.test(id)) return "move";
		return "live";
	}

	private async paintDials(deviceId: string): Promise<number> {
		const page = this.showing.get(deviceId) || null;
		const fromPage = page && Array.isArray((page as { dials?: string[] }).dials) ? (page as { dials: string[] }).dials : null;
		const name = fromPage && !fromPage.length ? "" : this.pageName(page);
		if (name) this.page = name;
		const layout = PLUSXL.pages.find((p) => p.id === name) || PLUSXL.pages[0];
		const list = fromPage || layout.dials;
		let n = 0;
		for (const dial of this.dials.values()) {
			if (dial.deviceId !== deviceId) continue;
			const settings = { widget: list[dial.column] || "off" };
			try {
				await dial.action.setSettings(settings);
			} catch (e) {
				streamDeck.logger.warn(String(e));
			}
			const paint = this.views.get(dial.id);
			if (paint) {
				try {
					await paint();
				} catch (e) {
					streamDeck.logger.warn(String(e));
				}
			}
			n += 1;
		}
		return n;
	}

	private async switchProfile(deviceId: string, profile: string): Promise<void> {
		const device = [...streamDeck.devices].find((d) => d.id === deviceId);
		const type = (device as { type?: number } | undefined)?.type;
		const suffix: Record<number, string> = { 0: "", 1: " Mini", 2: " XL", 7: " +", 9: " Neo", 11: " + XL" };
		const tail = type != null && suffix[type] != null ? suffix[type] : "";
		const names = [`Profiles/${profile}${tail}`, `${profile}${tail}`, `Profiles/Control Center${tail}`, `Control Center${tail}`];
		for (const name of names) {
			try {
				await streamDeck.profiles.switchToProfile(deviceId, name);
				return;
			} catch {
				/* try the next name this device type installs */
			}
		}
		streamDeck.logger.info(`Profile "${profile}" is not installed`);
	}

	private async paintPage(deviceId: string, page: { device?: unknown; keys?: Array<Record<string, unknown>> } | null): Promise<void> {
		if (!page) return;
		const keys = page.keys || [];
		for (const cell of this.cells.values()) {
			if (cell.deviceId !== deviceId) continue;
			const key = keys.find((k) => k.col === cell.column && k.row === cell.row);
			if (!key) continue;
			const settings: Record<string, unknown> = {
				label: key.label || "",
				value: key.value || "",
				caption: key.caption || "",
				role: key.role || "",
			};
			if (key.jump) settings.jump = key.jump;
			if (key.action) settings.action = key.action;
			if (key.device || page.device) settings.device = key.device || page.device;
			try {
				await cell.action.setSettings(settings);
			} catch (e) {
				streamDeck.logger.warn(String(e));
			}
			const paint = this.views.get(cell.id);
			if (!paint) continue;
			try {
				await paint();
			} catch (e) {
				streamDeck.logger.warn(String(e));
			}
		}
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
