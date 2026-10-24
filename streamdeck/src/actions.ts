import streamDeck, {
	action,
	type Action,
	type DialDownEvent,
	type DialRotateEvent,
	type KeyDownEvent,
	type KeyUpEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import { dialFace } from "../../lib/deck.js";
import { keySvg, knobSvg, presentKey, svgDataUrl } from "../../lib/deck-image.js";
import { beginHold, endHold } from "./hold.js";
import { bridge } from "./bridge.js";

type Settings = JsonObject;

const UUID = "com.performancevideo.control";

const HOLD_ROLES = new Set([
	"moveUp", "moveDown", "moveLeft", "moveRight", "moveUpLeft", "moveUpRight", "moveDownLeft", "moveDownRight",
	"zoomTele", "zoomWide", "focusFar", "focusNear",
]);

function num(value: JsonValue | undefined, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

async function paintKey(evAction: Action<Settings>, settings: Settings, role: string): Promise<void> {
	if (!evAction.isKey()) return;
	const model = presentKey({ ...settings, role }, bridge.snap ?? {}, { page: bridge.page });
	if (!bridge.snap) model.caption = "NO LINK";
	await evAction.setImage(svgDataUrl(keySvg(model)));
}

async function paintDial(evAction: Action<Settings>, settings: Settings): Promise<void> {
	if (!evAction.isDial()) return;
	const face = dialFace(String(settings.widget || "iris"), bridge.snap ?? {}, num(settings.stepIndex, 0));
	await evAction.setFeedbackLayout("layouts/knob.json");
	await evAction.setFeedback({ canvas: svgDataUrl(knobSvg(face)) });
}

function deviceId(evAction: Action<Settings>): string {
	return evAction.device.id;
}

/** HOME is the M4 Viewport mark. Pressing it opens Control Center. It does not talk to a camera. */
@action({ UUID: `${UUID}.home` })
export class HomeAction extends SingletonAction<Settings> {
	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		bridge.watch(ev.action.id, () => paintKey(ev.action, { role: "home" }, "home"));
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		bridge.unwatch(ev.action.id);
	}

	override async onKeyDown(): Promise<void> {
		await bridge.perform({ gesture: "home" });
	}
}

/** One camera on the select row. Slot 8 becomes CAM ▸ when the system has more than eight cameras. */
@action({ UUID: `${UUID}.camera` })
export class CameraAction extends SingletonAction<Settings> {
	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		bridge.watch(ev.action.id, () => paintKey(ev.action, ev.payload.settings, "camera"));
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		bridge.unwatch(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		await bridge.perform({ gesture: "select", slot: num(ev.payload.settings.slot, 1) });
	}
}

/**
 * Preset recall. On a red-tally camera the server is in hold or lock. In hold, the key must stay
 * down for liveGuard.holdMs before the plugin sends confirmed: true.
 */
@action({ UUID: `${UUID}.preset` })
export class PresetAction extends SingletonAction<Settings> {
	private down = new Map<string, number>();

	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		bridge.watch(ev.action.id, () => paintKey(ev.action, ev.payload.settings, "preset"));
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		this.down.delete(ev.action.id);
		bridge.unwatch(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		const cam = (bridge.snap?.cameras || []).find((c) => c.selected);
		const guard = bridge.snap?.liveGuard;
		if (cam?.tally && guard?.mode === "hold") {
			this.down.set(ev.action.id, Date.now());
			return;
		}
		await bridge.perform({ gesture: "recall", preset: num(ev.payload.settings.preset, 1), confirmed: false });
	}

	override async onKeyUp(ev: KeyUpEvent<Settings>): Promise<void> {
		const started = this.down.get(ev.action.id);
		if (started == null) return;
		this.down.delete(ev.action.id);
		const holdMs = bridge.snap?.liveGuard?.holdMs ?? 600;
		if (Date.now() - started < holdMs) return;
		await bridge.perform({ gesture: "recall", preset: num(ev.payload.settings.preset, 1), confirmed: true });
	}
}

/** Page tab. Accent while it is the deck's page. Switches a bundled profile of the same name when one is installed. */
@action({ UUID: `${UUID}.page` })
export class PageAction extends SingletonAction<Settings> {
	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		bridge.watch(ev.action.id, () => paintKey(ev.action, ev.payload.settings, "page"));
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		bridge.unwatch(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		const page = String(ev.payload.settings.page || "live");
		const planned = await bridge.perform({ gesture: "page", page });
		await bridge.repaint();
		if (!planned.profile) return;
		try {
			await streamDeck.profiles.switchToProfile(deviceId(ev.action), planned.profile);
		} catch (e) {
			streamDeck.logger.info(`Profile "${planned.profile}" is not installed (${e instanceof Error ? e.message : e})`);
		}
	}
}

/** A toggle, cycle, exec, or hold-to-run. R/B gain and pedestal are not in this list. */
@action({ UUID: `${UUID}.key` })
export class KeyAction extends SingletonAction<Settings> {
	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		bridge.watch(ev.action.id, () => paintKey(ev.action, ev.payload.settings, String(ev.payload.settings.role || "")));
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		const role = String(ev.payload.settings.role || "");
		endHold(ev.action.id, (phase) => {
			void bridge.perform({ gesture: "hold", role, phase });
		});
		bridge.unwatch(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		const role = String(ev.payload.settings.role || "");
		if (HOLD_ROLES.has(role)) {
			beginHold(ev.action.id, (phase, factor) => {
				void bridge.perform({ gesture: "hold", role, phase, factor });
			});
			return;
		}
		await bridge.perform({ gesture: "key", role });
	}

	override onKeyUp(ev: KeyUpEvent<Settings>): void {
		const role = String(ev.payload.settings.role || "");
		if (!HOLD_ROLES.has(role)) return;
		endHold(ev.action.id, (phase) => {
			void bridge.perform({ gesture: "hold", role, phase });
		});
	}
}

/**
 * One encoder on the + XL strip. The touch screen is a circular paint knob (or a pair).
 * Rotate steps the value. Push cycles fine / coarse, and R / B on a paired bias.
 * A tap runs the knob's function (A/M, AWB, ABB, reset, stop, push AF).
 */
@action({ UUID: `${UUID}.dial` })
export class DialAction extends SingletonAction<Settings> {
	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		bridge.watch(ev.action.id, () => paintDial(ev.action, ev.payload.settings));
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		bridge.unwatch(ev.action.id);
	}

	override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
		await bridge.perform({
			gesture: "dial",
			widget: String(ev.payload.settings.widget || "iris"),
			event: "rotate",
			ticks: ev.payload.ticks,
			stepIndex: num(ev.payload.settings.stepIndex, 0),
		});
	}

	override async onDialDown(ev: DialDownEvent<Settings>): Promise<void> {
		const planned = await bridge.perform({
			gesture: "dial",
			widget: String(ev.payload.settings.widget || "iris"),
			event: "push",
			stepIndex: num(ev.payload.settings.stepIndex, 0),
		});
		if (planned.stepIndex == null) return;
		const settings = { ...ev.payload.settings, stepIndex: planned.stepIndex };
		await ev.action.setSettings(settings);
		await paintDial(ev.action, settings);
	}

	override async onTouchTap(ev: TouchTapEvent<Settings>): Promise<void> {
		await bridge.perform({
			gesture: "dial",
			widget: String(ev.payload.settings.widget || "iris"),
			event: "tap",
			stepIndex: num(ev.payload.settings.stepIndex, 0),
		});
	}
}
