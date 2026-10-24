import type { DeckSnapshot, DialFace } from "./deck";

export interface KeyModel {
  fill?: string;
  ink?: string;
  dim?: string;
  border?: string | null;
  ring?: boolean;
  mark?: boolean;
  offline?: boolean;
  title?: string;
  value?: string;
  caption?: string;
}

export function knobSvg(face: DialFace): string;
export function keySvg(model: KeyModel): string;
export function svgDataUrl(svg: string): string;
export function presentKey(settings: Record<string, unknown>, snapshot: Partial<DeckSnapshot>, deck?: { page?: string }): KeyModel;
export function presentDial(settings: { widget?: string; stepIndex?: number }, snapshot: Partial<DeckSnapshot>): DialFace;
