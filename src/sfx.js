// The sound-effect player, and two helpers to write effects with.
//
// A sound effect is a frame program: one [wave, hz, pulseWidth] entry per
// 50 Hz frame, written into a voice of the chip. `null` drops the gate for a
// frame; a wave with RETRIGGER set strikes the envelope again. Three voices,
// so three effects can overlap; a fourth steals the oldest voice of equal or
// lower priority.
//
// An effect definition: { prio, adsr: [a, d, s, r], frames, cutoff? }, where
// `cutoff`, if present, routes the voice through the low-pass filter with one
// cutoff value per frame.

import { LOW_PASS, RETRIGGER, hzToReg } from './chip.js';

export class SfxPlayer {
  constructor(chip) {
    this.chip = chip;
    this.defs = {};
    this.clock = 0;
    this.voices = [0, 1, 2].map(() => ({ prog: null, frame: 0, prio: 0, started: 0 }));
    chip.setVolume(15);
  }

  play(name) {
    const def = this.defs[name];
    if (!def) return;
    let best = -1;
    for (let i = 0; i < 3; i++) {
      const v = this.voices[i];
      if (!v.prog) { best = i; break; }
      if (v.prio > def.prio) continue;
      if (best < 0 || v.started < this.voices[best].started) best = i;
    }
    if (best < 0) return;
    const v = this.voices[best];
    v.prog = def;
    v.frame = 0;
    v.prio = def.prio;
    v.started = this.clock;
    this.chip.setEnvelope(best, def.adsr[0], def.adsr[1], def.adsr[2], def.adsr[3]);
    this.chip.setGate(best, false);
    this.chip.setGate(best, true);
  }

  tick() {
    this.clock++;
    let routing = 0;
    let cutoff = -1;
    for (let i = 0; i < 3; i++) {
      const v = this.voices[i];
      if (!v.prog) continue;
      const frames = v.prog.frames;
      if (v.frame >= frames.length) {
        this.chip.setGate(i, false);
        v.prog = null;
        continue;
      }
      const f = frames[v.frame];
      if (f === null) {
        this.chip.setGate(i, false);
      } else {
        if (f[0] & RETRIGGER) {
          this.chip.setGate(i, false);
          this.chip.setGate(i, true);
        } else if (!this.chip.gate(i)) {
          this.chip.setGate(i, true);
        }
        this.chip.setWaveform(i, f[0] & 15);
        this.chip.setFrequency(i, hzToReg(f[1]));
        this.chip.setPulseWidth(i, f[2] === undefined ? 0x800 : f[2]);
        if (v.prog.cutoff) {
          routing |= 1 << i;
          cutoff = v.prog.cutoff[Math.min(v.frame, v.prog.cutoff.length - 1)];
        }
      }
      v.frame++;
    }
    if (routing) this.chip.setFilter(cutoff, 6, LOW_PASS, routing);
    else this.chip.setFilter(2047, 0, LOW_PASS, 0);
  }
}

// --- writing effects -----------------------------------------------------------

// An exponential pitch sweep over `frames` frames.
export function sweep(wave, fromHz, toHz, frames, pw = 0x800) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    const t = frames > 1 ? i / (frames - 1) : 0;
    out.push([wave, fromHz * Math.pow(toHz / fromHz, t), pw]);
  }
  return out;
}

// Notes held for `frames` each, re-striking the envelope on every note.
export function notes(wave, hzList, frames, pw = 0x800) {
  const out = [];
  for (const hz of hzList) {
    for (let i = 0; i < frames; i++) out.push([i === 0 ? wave | RETRIGGER : wave, hz, pw]);
  }
  return out;
}

export const midiToHz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
