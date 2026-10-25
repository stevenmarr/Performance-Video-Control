import streamDeck from "@elgato/streamdeck";

import { createPluginServer, DEFAULT_PORT } from "../../lib/decks/plugin-server.js";
import { bridge } from "./bridge";

type Listed = { id?: string };

/**
 * Loopback HTTP the Control Center DECKS tab calls. Hardware is whatever Stream Deck
 * has connected. Nothing here adds a deck that the app did not enumerate.
 */
export function startDeckServer(): void {
	const hardware = {
		devices() {
			const list = streamDeck.devices as Iterable<{ id: string; name?: string; type?: number; size?: { columns?: number; rows?: number }; isConnected?: boolean }>;
			return [...list].map((d) => ({
				id: d.id,
				name: d.name || "Stream Deck",
				model: d.name || "Stream Deck",
				type: d.type,
				columns: d.size?.columns,
				rows: d.size?.rows,
				online: d.isConnected !== false,
			}));
		},
		async deploy(deviceId: string, body: { pages: unknown[] }) {
			const devices = await hardware.devices();
			if (!devices.some((d: Listed) => d.id === deviceId)) {
				throw Object.assign(new Error(`Stream Deck "${deviceId}" is not connected`), { status: 404 });
			}
			return bridge.applyDeploy(deviceId, body as { pages?: Array<{ id: string; title?: string; profile?: string | null; device?: unknown; keys?: Array<Record<string, unknown>> }> });
		},
	};
	const port = Number(process.env.RS6_DECK_PLUGIN_PORT) || DEFAULT_PORT;
	const host = process.env.RS6_DECK_PLUGIN_HOST || "127.0.0.1";
	const srv = createPluginServer({ hardware, host, port });
	void srv.listen().then(async (info) => {
		streamDeck.logger.info(`Path C deck API ${info.url}`);
		try {
			await fetch(`${bridge.base}/api/decks/hello`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ url: info.url }),
			});
		} catch (e) {
			streamDeck.logger.info(`Control Center has not accepted the deck hello yet (${e instanceof Error ? e.message : e})`);
		}
	}).catch((e) => {
		streamDeck.logger.warn(`Path C deck API did not start (${e instanceof Error ? e.message : e})`);
	});
}
