// Types for the Path C plugin HTTP server. The implementation is lib/decks/plugin-server.js.

export const DEFAULT_PORT: number;
export const PLUGIN_UUID: string;

export interface DeckHardware {
	devices: () => Promise<unknown[]> | unknown[];
	deploy: (deviceId: string, body: { pages: unknown[] }) => Promise<unknown> | unknown;
}

export function createPluginServer(opts: {
	hardware: DeckHardware;
	host?: string;
	port?: number;
}): {
	url: string;
	listen: () => Promise<{ url: string; port: number; close: () => Promise<void> }>;
};
