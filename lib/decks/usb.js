'use strict';
// Own the Stream Deck over USB, the way Companion does. The Elgato desktop app
// is not in this path: it does not run on a Pi, and it holds the HID device if
// it is open. Quit it before Scan.
//
// The driver is @elgato-stream-deck/node (Node 18+), which uses node-hid.
// On Linux, node-hid opens /dev/hidraw*, not the Mac HID manager. The package
// is a normal dependency. If node_modules does not have it, scan() returns
// nothing and the service logs that at startup.

const { surfaceFor } = require('./surfaces');
const { keyImage, stripImage, dialSignature, blit } = require('./look');
const { installJpegGuard } = require('./jpeg-guard');
installJpegGuard();

function loadDriver() {
  try {
    return { driver: require('@elgato-stream-deck/node'), error: null, code: null };
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    const msg = e && e.message ? e.message : String(e);
    // 7.8.0 is the pin. Its own engines field is Node >=18.18. 18.20.4 is enough.
    const hint = 'Fix: cd /opt/control-center && sudo rm -rf node_modules && sudo chown -R pi:pi /opt/control-center && sudo -u pi npm install --omit=dev --prefix /opt/control-center && sudo systemctl restart control-center. @elgato-stream-deck/node@7.8.0 needs Node >=18.18.';
    return { driver: null, error: `${code ? code + ': ' : ''}${msg}. ${hint}`, code };
  }
}

class UsbDecks {
  constructor() {
    this.loaded = loadDriver();
    this.open = new Map();
    this.openErrors = [];
    this.press = null;
    this.turn = null;
  }

  status() {
    return { installed: !!this.loaded.driver, error: this.loaded.error };
  }

  onPress(fn) { this.press = fn; }
  onTurn(fn) { this.turn = fn; }
  onRelease(fn) { this.release = fn; }
  emitRelease(held, key) {
    if (!this.release) return;
    const index = typeof key === 'number' ? key : (key && (key.index ?? key.keyIndex));
    if (!Number.isInteger(index)) return;
    const cols = held.info.columns;
    this.release(held.info.id, { col: index % cols, row: Math.floor(index / cols), index });
  }

  async list() {
    this.loaded = loadDriver();
    if (!this.loaded.driver) return { installed: false, error: this.loaded.error, devices: [] };
    try {
      const listed = await this.loaded.driver.listStreamDecks();
      return {
        installed: true,
        devices: (listed || []).map((d) => ({ path: d.path, serial: d.serialNumber || '', model: d.model || '' })),
      };
    } catch (e) {
      return { installed: true, error: e.message || String(e), devices: [] };
    }
  }

  async scan({ claim, skipPaths } = {}) {
    this.loaded = loadDriver();
    this.openErrors = [];
    const report = {
      installed: !!this.loaded.driver,
      error: this.loaded.error,
      found: 0,
      listed: [],
      opened: [],
      failed: [],
      skipped: [],
    };
    this.lastReport = report;
    if (!this.loaded.driver) return [];
    let listed = [];
    try {
      listed = await this.loaded.driver.listStreamDecks();
    } catch (e) {
      this.loaded.error = e.message || String(e);
      report.error = this.loaded.error;
      return [...this.open.values()].map((d) => d.info);
    }
    report.found = listed.length;
    report.listed = listed.map((d) => ({ path: d.path, serial: d.serialNumber || '', model: d.model || '' }));
    const paths = new Set(listed.map((d) => d.path));
    for (const [path, held] of this.open) {
      if (!paths.has(path)) {
        try { await held.deck.close(); } catch { /* already gone */ }
        this.open.delete(path);
      }
    }
    for (const info of listed) {
      if (this.open.has(info.path)) continue;
      if ((skipPaths && skipPaths.has(info.path)) || (claim && claim(info) === false)) {
        report.skipped.push({ serial: info.serialNumber || '', path: info.path });
        continue;
      }
      try {
        const deck = await this.loaded.driver.openStreamDeck(info.path, { jpegOptions: { quality: 50 } });
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
        held.painted = new Map();
        held.stripSig = '';
        deck.on('error', (err) => {
          held.info.online = false;
          held.info.error = err && err.message ? err.message : String(err);
        });
        deck.on('down', (control) => {
          if (control && control.type === 'encoder') this.emitTurn(held, control, 0, 'down');
          else this.emitPress(held, control);
        });
        deck.on('up', (control) => {
          if (control && control.type === 'encoder') this.emitTurn(held, control, 0, 'up');
          else this.emitRelease(held, control);
        });
        deck.on('rotate', (control, amount) => this.emitTurn(held, control, amount, 'rotate'));
        deck.on('lcdShortPress', (control, pos) => this.emitTouch(held, control, pos));
        this.open.set(info.path, held);
        report.opened.push({ serial: held.info.serial || '', path: info.path, model });
      } catch (e) {
        const where = info.serialNumber || info.path || 'USB';
        const line = deckOpenMessage(where, e);
        this.openErrors.push(line);
        report.failed.push({ serial: info.serialNumber || '', path: info.path || '', message: line });
        this.loaded.error = line;
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

  emitTurn(held, key, amount, event) {
    if (!this.turn) return;
    const index = typeof key === 'number' ? key : (key && (key.index ?? key.column ?? 0));
    const ticks = Number(amount && amount.ticks != null ? amount.ticks : amount) || 0;
    const name = event || 'rotate';
    if (name === 'rotate' && !ticks) return;
    this.turn(held.info.id, { index: Number(index) || 0, ticks, event: name });
  }

  controlsOf(deck) {
    if (deck.CONTROLS && deck.CONTROLS.length) return deck.CONTROLS;
    const info = deck.modelInfo || {};
    return info.controls || [];
  }

  emitTouch(held, control, pos) {
    if (!this.turn || !pos) return;
    const controls = this.controlsOf(held.deck);
    const encoders = controls.filter((c) => c.type === 'encoder');
    if (!encoders.length) return;
    const lcdW = (control.pixelSize && control.pixelSize.width) || 800;
    let best = encoders[0].index || 0;
    let bestD = Infinity;
    for (const enc of encoders) {
      const cx = enc.bounds && control.bounds
        ? (enc.bounds.x + enc.bounds.width / 2) - control.bounds.x
        : ((enc.index + 0.5) * (lcdW / encoders.length));
      const d = Math.abs(cx - pos.x);
      if (d < bestD) { bestD = d; best = enc.index; }
    }
    this.turn(held.info.id, { index: best, ticks: 0, event: 'tap' });
  }

  buttonSize(id) {
    const held = this.open.get(id);
    if (!held) return null;
    const button = this.controlsOf(held.deck).find((c) => c.type === 'button' && c.pixelSize);
    if (!button) return null;
    return { width: button.pixelSize.width, height: button.pixelSize.height || button.pixelSize.width };
  }

  sigOf(key, width) {
    const face = key.faceStyle || {};
    const layers = (face.layers || []).map((layer) => `${layer.id || ''}${layer.next ? 'N' : ''}${layer.air ? 'A' : ''}`).join(',');
    return `${key.label}|${key.caption}|${face.title || ''}|${face.value || ''}|${face.caption || ''}|${face.fill || ''}|${face.border || ''}|${layers}|${key.tone}|${key.nav}|${key.on ? 1 : 0}|${key.ring ? 1 : 0}|${key.pressed ? 1 : 0}|${width}`;
  }

  async paint(id, keys, face) {
    const held = this.open.get(id);
    if (!held) return false;
    const size = this.buttonSize(id) || { width: 72, height: 72 };
    const width = size.width;
    const height = size.height;
    held.info.paintError = null;
    held.painted = held.painted || new Map();
    const list = keys || [];
    const pending = list.filter((key) => held.painted.get(key.row * held.info.columns + key.col) !== this.sigOf(key, width));
    if (pending.length) {
      const dim = typeof held.deck.calculateFillPanelDimensions === 'function' ? held.deck.calculateFillPanelDimensions() : null;
      const allChanged = pending.length === list.length;
      const packed = allChanged && dim && pending.length >= 4 && dim.width === held.info.columns * width && dim.height === held.info.rows * height;
      let sent = false;
      if (packed) {
        try {
          const data = Buffer.alloc(dim.width * dim.height * 4);
          for (const key of list) blit(data, dim.width, keyImage(key, width, height), key.col * width, key.row * height);
          await held.deck.fillPanelBuffer(data, { format: 'rgba' });
          for (const key of list) held.painted.set(key.row * held.info.columns + key.col, this.sigOf(key, width));
          sent = true;
        } catch (e) {
          held.info.paintError = e.message || String(e);
        }
      }
      if (!sent) {
        for (const key of pending) {
          const index = key.row * held.info.columns + key.col;
          try {
            const image = keyImage(key, width, height);
            await held.deck.fillKeyBuffer(index, image.data, { format: 'rgba' });
            held.painted.set(index, this.sigOf(key, width));
          } catch (e) {
            held.info.paintError = e.message || String(e);
          }
        }
      }
    }
    await this.paintStrip(held, face);
    return true;
  }

  async paintStrip(held, face) {
    const controls = this.controlsOf(held.deck);
    const lcd = controls.find((c) => c.type === 'lcd-segment');
    if (!lcd || typeof held.deck.fillLcd !== 'function') return;
    const size = lcd.pixelSize || { width: 800, height: 100 };
    const dials = (face && face.dials) || [];
    const sig = `${size.width}x${size.height}:${dialSignature(dials, face && face.snap)}`;
    if (held.stripSig === sig) return;
    const image = stripImage(size.width, size.height, dials, face && face.snap);
    try {
      await held.deck.fillLcd(lcd.id != null ? lcd.id : 0, image.data, { format: 'rgba' });
      held.stripSig = sig;
    } catch (e) {
      held.info.paintError = held.info.paintError || e.message || String(e);
    }
  }

  async closeId(id) {
    for (const [key, held] of this.open) {
      if (held.info.id !== id && key !== id) continue;
      try { await held.deck.close(); } catch { /* already closed */ }
      this.open.delete(key);
      return true;
    }
    return false;
  }

  async close() {
    for (const held of this.open.values()) {
      try { await held.deck.close(); } catch { /* ignore */ }
    }
    this.open.clear();
  }
}

function deckOpenKind(err) {
  const code = String((err && (err.code || err.errno)) || '');
  const msg = err && err.message ? err.message : String(err || '');
  const blob = `${code} ${msg}`;
  if (/EACCES|EPERM|PERMISSION/i.test(blob)) return 'EACCES';
  if (/EBUSY|BUSY|CLAIMED|IN USE|LIBUSB_ERROR_BUSY|RESOURCE BUSY/i.test(blob)) return 'busy';
  if (/cannot open|could not open|libusb|hidapi|access/i.test(blob)) return 'busy';
  return '';
}

function deckOpenMessage(where, err) {
  const msg = err && err.message ? err.message : String(err || 'unknown error');
  const kind = deckOpenKind(err);
  if (kind === 'EACCES') {
    return `cannot open ${where}: EACCES (${msg}). The service cannot write the hidraw node. Install tools/udev/50-control-center-streamdeck.rules as /etc/udev/rules.d/99-control-center-streamdeck.rules (MODE 0660, GROUP plugdev), run sudo udevadm control --reload-rules && sudo udevadm trigger, replug the deck, and sudo systemctl restart control-center. The + on crw-rw----+ is a login-seat ACL and does not apply to a systemd service. Group companion is Companion's udev rule. usermod does not change a process that is already running.`;
  }
  if (kind === 'busy') {
    return `cannot open ${where}: busy (${msg}). Another program has the deck. In Companion, turn off Settings → Surfaces → "Enable direct connection to Stream Decks", unplug the deck, and plug it back in. See who holds it with: sudo node tools/deck-diag.js`;
  }
  return `cannot open ${where}: ${msg}`;
}

module.exports = { UsbDecks, loadDriver, deckOpenMessage };
