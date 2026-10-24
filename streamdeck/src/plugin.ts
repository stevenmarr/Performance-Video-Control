import streamDeck from "@elgato/streamdeck";

import { CameraAction, DialAction, HomeAction, KeyAction, PageAction, PresetAction } from "./actions";
import { bridge } from "./bridge";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new HomeAction());
streamDeck.actions.registerAction(new CameraAction());
streamDeck.actions.registerAction(new PresetAction());
streamDeck.actions.registerAction(new PageAction());
streamDeck.actions.registerAction(new KeyAction());
streamDeck.actions.registerAction(new DialAction());

streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
	const settings = ev.settings as { host?: string; port?: number };
	bridge.configure(settings);
});

streamDeck.connect();
bridge.start();
