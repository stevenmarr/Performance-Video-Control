// Hold-to-run for MOVE. The ramp starts at 25% of the session speed and reaches 100% after 1.5 s,
// so a tap is a creep. Keep-alives re-arm Control Center's dead-man (1.5 s); the camera is never addressed.

type Phase = "move" | "keepalive" | "stop";

const holds = new Map<string, ReturnType<typeof setInterval>>();

export function beginHold(id: string, run: (phase: Phase, factor: number) => void): void {
	endHold(id, () => undefined);
	const started = Date.now();
	let factor = 0.25;
	const current = () => Math.min(1, 0.25 + (0.75 * (Date.now() - started)) / 1500);
	run("move", factor);
	holds.set(id, setInterval(() => {
		const next = Math.round(current() * 100) / 100;
		if (next > factor + 0.01) {
			factor = next;
			run("move", factor);
		} else {
			run("keepalive", factor);
		}
	}, 400));
}

export function endHold(id: string, run: (phase: Phase, factor: number) => void): void {
	const timer = holds.get(id);
	if (!timer) return;
	clearInterval(timer);
	holds.delete(id);
	run("stop", 0);
}
