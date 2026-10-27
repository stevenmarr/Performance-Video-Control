'use strict';
// Own the Stream Deck over USB, the way Companion does. The Elgato desktop app
// is not in this path: it does not run on a Pi, and it holds the HID device if
// it is open. Quit it before Scan.
//
// The driver is @elgato-stream-deck/node (Node 18+). If it is not installed the
// app still runs and Scan says so.

const { surfaceFor } = require('./surfaces');
const { keyImage } = require('./draw');

function loadDriver() {
  try {
    return { driver: require('@elgato-stream-deck/node'), error: null };
  } catch (e) {
    const hint = 'USB Stream Deck control needs Node 18+ and @elgato-stream-deck/node. Quit the Elgato Stream Deck app, then npm install in this repo.';
    return { driver: null, error: e && e.code === 'MODULE_NOT_FOUND' ? hint : `${hint} (${e.message})` };
  }
}

class UsbDecks {
  constructor() {
    this.loaded = loadDriver();
    this.open = new Map();
    this.press = null;
    this.turn = null;
  }

  status() {
    return { installed: !!this.loaded.driver, error: this.loaded.error };
  }

  onPress(fn) { this.press = fn; }
  onTurn(fn) { this.turn = fn; }

  async scan() {
    this.loaded = loadDriver();
    if (!this.loaded.driver) return [];
    let listed = [];
    try {
      listed = await this.loaded.driver.listStreamDecks();
    } catch (e) {
      this.loaded.error = e.message || String(e);
      return [...this.open.values()].map((d) => d.info);
    }
    const paths = new Set(listed.map((d) => d.path));
    for (const [path, held] of this.open) {
      if (!paths.has(path)) {
        try { await held.deck.close(); } catch { /* already gone */ }
        this.open.delete(path);
      }
    }
    for (const info of listed) {
      if (this.open.has(info.path)) continue;
      try {
        const deck = await this.loaded.driver.openStreamDeck(info.path);
        const model = String(deck.MODEL || info.model || info.productName || 'Stream Deck');
        const surface = surfaceFor({ model, columns: deck.KEY_COLUMNS, rows: deck.KEY_ROWS });
        const held = {
          deck,
          info: {
            id: info.path,
            path: info.path,
            serial: info.serialNumber || '',
            name: model,
            model,
            surfaceId: surface.id,
            columns: surface.cols,
            rows: surface.rows,
            online: true,
            transport: 'usb',
          },
        };
        deck.on('error', (err) => {
          held.info.online = false;
          held.info.error = err && err.message ? err.message : String(err);
        });
        deck.on('down', (key) => this.emitPress(held, key));
        deck.on('up', () => {});
        if (typeof deck.on === 'function') {
          deck.on('rotate', (key, amount) => this.emitTurn(held, key, amount));
        }
        this.open.set(info.path, held);
      } catch (e) {
        this.loaded.error = e.message || String(e);
      }
    }
    return [...this.open.values()].map((d) => ({ ...d.info }));
  }

  emitPress(held, key) {
    if (!this.press) return;
    const index = typeof key === 'number' ? key : (key && (key.index ?? key.keyIndex));
    if (!Number.isInteger(index)) return;
    const cols = held.info.columns;
    this.press(held.info.id, { col: index % cols, row: Math.floor(index / cols), index });
  }

  emitTurn(held, key, amount) {
    if (!this.turn) return;
    const index = typeof key === 'number' ? key : (key && (key.index ?? key.column ?? 0));
    const ticks = Number(amount && amount.ticks != null ? amount.ticks : amount) || 0;
    if (!ticks) return;
    this.turn(held.info.id, { index: Number(index) || 0, ticks });
  }

  async paint(id, keys) {
    const held = this.open.get(id);
    if (!held) return false;
    const size = Number(held.deck.BUTTON_WIDTH || held.deck.KEY_PIXEL_SIZE || 72);
    for (const key of keys || []) {
      const index = key.row * held.info.columns + key.col;
      const image = keyImage(key, size);
      try {
        if (image.jpeg && typeof held.deck.fillKeyJPEG === 'function') await held.deck.fillKeyJPEG(index, image.jpeg);
        else if (typeof held.deck.fillKeyColor === 'function') await held.deck.fillKeyColor(index, image.rgb[0], image.rgb[1], image.rgb[2]);
      } catch { /* one bad key does not stop the page */ }
    }
    return true;
  }

  async close() {
    for (const held of this.open.values()) {
      try { await held.deck.close(); } catch { /* ignore */ }
    }
    this.open.clear();
  }
}

module.exports = { UsbDecks, loadDriver };
