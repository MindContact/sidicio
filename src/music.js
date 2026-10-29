// The music player: what a C64 player routine does once per PAL frame
// (50 Hz). Read the next row of each voice when the row timer runs out, then
// for every voice work out this frame's pitch (arpeggio, vibrato, slide, wave
// table), waveform and pulse width, and poke them into the chip.
//
// A compiled song (see song.js) is plain data:
//   { speed, rows: [Int32Array x3], loopRow, instruments: [...], filter }
// A row cell is HOLD, OFF, or note | inst << 7 | slide << 14.

import { LOW_PASS, noteToReg } from './chip.js';

export const HOLD = -1;
export const OFF = -2;

export class MusicPlayer {
  constructor(chip) {
    this.chip = chip;
    this.song = null;
    this.paused = false;
    this.onEnd = null;
    this.voices = [0, 1, 2].map(() => ({
      active: false, note: 0, from: 0, slide: false, inst: null,
      frame: 0, pw: 0x800, pwDir: 1,
    }));
  }

  play(song) {
    this.song = song;
    this.row = 0;
    this.timer = 0;
    this.frame = 0;
    this.paused = false;
    for (let i = 0; i < 3; i++) {
      this.voices[i].active = false;
      this.chip.setGate(i, false);
      this.chip.setRing(i, false);
      this.chip.setSync(i, false);
    }
    this.chip.setVolume(15);
    this.routing = 0;
    this.applyFilter();
  }

  stop() {
    this.song = null;
    for (let i = 0; i < 3; i++) {
      this.voices[i].active = false;
      this.chip.setGate(i, false);
    }
  }

  setPaused(paused) {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) for (let i = 0; i < 3; i++) this.chip.setGate(i, false);
  }

  applyFilter() {
    const f = this.song && this.song.filter;
    if (!f) {
      this.chip.setFilter(1024, 0, LOW_PASS, 0);
      return;
    }
    let cutoff = f.cutoff;
    if (f.lfo) {
      const t = (this.frame % f.lfo.period) / f.lfo.period;
      cutoff = f.lfo.min + (f.lfo.max - f.lfo.min) * (0.5 - 0.5 * Math.cos(2 * Math.PI * t));
    }
    this.chip.setFilter(cutoff, f.resonance, f.mode, this.routing);
  }

  readRow() {
    const song = this.song;
    for (let i = 0; i < 3; i++) {
      const cell = song.rows[i][this.row];
      const v = this.voices[i];
      if (cell === HOLD) continue;
      if (cell === OFF) {
        this.chip.setGate(i, false);
        continue;
      }
      const note = cell & 127;
      const inst = song.instruments[(cell >> 7) & 127];
      const slide = ((cell >> 14) & 1) === 1 && v.active;
      v.from = slide ? v.note : note;
      v.note = note;
      v.slide = slide;
      v.inst = inst;
      v.frame = 0;
      v.active = true;
      if (!slide) {
        v.pw = inst.pw;
        v.pwDir = 1;
        this.chip.setEnvelope(i, inst.adsr[0], inst.adsr[1], inst.adsr[2], inst.adsr[3]);
        // Gate off then on in the same frame re-enters the attack from the
        // current level, which is how a player routine re-strikes a note.
        this.chip.setGate(i, false);
        this.chip.setGate(i, true);
      }
      this.chip.setRing(i, !!inst.ring);
      this.chip.setSync(i, !!inst.sync);
      if (inst.filter) this.routing |= 1 << i;
      else this.routing &= ~(1 << i);
    }
    this.row++;
    if (this.row >= song.rows[0].length) {
      if (song.loopRow >= 0) {
        this.row = song.loopRow;
      } else {
        this.stop();
        if (this.onEnd) this.onEnd();
      }
    }
  }

  tick() {
    if (!this.song || this.paused) return;
    if (this.timer <= 0) {
      this.timer = this.song.speed;
      this.readRow();
      if (!this.song) return;
    }
    this.timer--;
    this.frame++;
    this.applyFilter();

    for (let i = 0; i < 3; i++) {
      const v = this.voices[i];
      if (!v.active) continue;
      const ins = v.inst;
      let wave = ins.wave;
      let note = v.note;
      if (v.slide && ins.glide) {
        const t = Math.min(1, v.frame / ins.glide);
        note = v.from + (v.note - v.from) * t;
      }
      if (ins.table) {
        const e = ins.table[Math.min(v.frame, ins.table.length - 1)];
        wave = e[0];
        note = e[2] ? e[1] : note + e[1];
      } else if (ins.arp) {
        note += ins.arp[Math.floor(v.frame / (ins.arpSpeed || 1)) % ins.arp.length];
      }
      if (ins.vib && v.frame >= ins.vib[0]) {
        note += Math.sin((v.frame - ins.vib[0]) * ins.vib[2]) * ins.vib[1];
      }
      this.chip.setFrequency(i, noteToReg(note));
      this.chip.setWaveform(i, wave);
      if (ins.pwSpeed) {
        v.pw += ins.pwSpeed * v.pwDir;
        if (v.pw > ins.pwMax) { v.pw = ins.pwMax; v.pwDir = -1; }
        if (v.pw < ins.pwMin) { v.pw = ins.pwMin; v.pwDir = 1; }
      }
      this.chip.setPulseWidth(i, v.pw);
      if (ins.gateFrames && v.frame === ins.gateFrames && !v.slide) this.chip.setGate(i, false);
      v.frame++;
    }
  }
}
