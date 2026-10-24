// Types for the Stream Deck plugin. The implementation is lib/deck.js (plain Node, no camera I/O).
export const PLUGIN_UUID: string;
export const DECK_PATH: string;
export const LAYOUT_PATH: string;
export const PROFILES: { live: string; paint: string; func: string; move: string };
export const KEY_ROLES: Record<string, { type: string; op?: string; label: string; text?: string }>;
export const WIDGETS: Record<string, { kind: string; label?: string }>;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface DeckRequest {
  method: "POST";
  path: string;
  body: Record<string, Json | undefined>;
}

export interface DeckPlan {
  requests: DeckRequest[];
  open?: string;
  profile?: string;
  page?: string;
  stepIndex?: number;
}

export interface DeckSnapshot {
  rev: number;
  selected: string | null;
  liveGuard: { mode: string; holdMs: number };
  speeds: { pt: number; zoom: number; focus: number };
  cameras: Array<{ slot: number; id: string; name: string; connected: boolean; tally: boolean; selected: boolean }>;
  presets: Array<{ n: number; name: string }>;
  values: Record<string, Json>;
  readouts: Record<string, { text?: string; value?: Json; fraction?: number; on?: boolean | null }>;
}

export interface DialFace {
  widget: string;
  kind: string;
  parts: Array<{ label: string; text: string; fraction: number; tint: string; active: boolean; muted: boolean }>;
  step: string;
  stepLine: string;
  badge?: string | null;
  caption?: string;
  tap?: string;
}

export function controlCenterBase(settings?: { host?: string; port?: number | string }): string;
export function plan(gesture: Record<string, unknown>): DeckPlan;
export function dialFace(widget: string, snapshot: Partial<DeckSnapshot> | null, stepIndex?: number): DialFace;
