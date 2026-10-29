// MOS 6581 / 8580 SID emulation: three oscillators, ADSR with the exponential
// decay divider, ring mod, hard sync, a multimode state-variable filter, 4x
// oversampling. Registers in, one float sample out per `render()` call.
//
// A JavaScript port of mcma-chip's `native/sid_chip.cpp` (written from the
// datasheet and public reverse-engineering notes, not from reSID). Pure
// computation, no Web API: it runs the same in an AudioWorklet and in Node.

export const PAL_CLOCK = 985248;
export const TRI = 1;
export const SAW = 2;
export const PULSE = 4;
export const NOISE = 8;
// Marks a sound-effect frame that re-strikes the envelope (gate off then on).
export const RETRIGGER = 0x80;

export const LOW_PASS = 1;
export const BAND_PASS = 2;
export const HIGH_PASS = 4;

const OVERSAMPLE = 4;

// Chip cycles between two envelope steps, per rate register value.
const RATE_PERIODS = [
  9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532,
  31251,
];

const ATTACK = 0;
const DECAY_SUSTAIN = 1;
const RELEASE = 2;

function softClip(x) {
  if (x < -3) x = -3;
  else if (x > 3) x = 3;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

class Envelope {
  constructor() {
    this.attack = 0;
    this.decay = 0;
    this.sustain = 0;
    this.release = 0;
    this.state = RELEASE;
    this.gate = false;
    this.level = 0;
    this.rateCounter = 0;
    this.expCounter = 0;
    this.expPeriod = 1;
  }

  setRates(a, d, s, r) {
    this.attack = a & 15;
    this.decay = d & 15;
    this.sustain = s & 15;
    this.release = r & 15;
  }

  setGate(on) {
    if (on && !this.gate) this.state = ATTACK;
    else if (!on && this.gate) this.state = RELEASE;
    this.gate = on;
  }

  period() {
    if (this.state === ATTACK) return RATE_PERIODS[this.attack];
    if (this.state === DECAY_SUSTAIN) return RATE_PERIODS[this.decay];
    return RATE_PERIODS[this.release];
  }

  clock(cycles) {
    this.rateCounter += cycles;
    for (;;) {
      const p = this.period();
      if (this.rateCounter < p) break;
      this.rateCounter -= p;

      if (this.state === ATTACK) {
        // The attack is linear: one step per period, no divider.
        this.expCounter = 0;
        if (this.level === 0xff) {
          this.state = DECAY_SUSTAIN;
          continue;
        }
        this.level++;
        if (this.level === 0xff) this.state = DECAY_SUSTAIN;
      } else {
        // Decay and release go through a second divider whose period grows as
        // the level falls: the piecewise-exponential tail of a SID release.
        if (++this.expCounter < this.expPeriod) continue;
        this.expCounter = 0;
        if (this.state === DECAY_SUSTAIN) {
          if (this.level > this.sustain * 0x11) this.level--;
        } else if (this.level > 0) {
          this.level--;
        }
      }

      switch (this.level) {
        case 0xff: this.expPeriod = 1; break;
        case 0x5d: this.expPeriod = 2; break;
        case 0x36: this.expPeriod = 4; break;
        case 0x1a: this.expPeriod = 8; break;
        case 0x0e: this.expPeriod = 16; break;
        case 0x06: this.expPeriod = 30; break;
        case 0x00: this.expPeriod = 1; break;
        default: break;
      }
    }
  }
}

class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }

  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

function makeVoice() {
  return {
    acc: 0, // 24-bit phase accumulator
    frac: 0, // sub-cycle remainder, 16 bits
    freq: 0,
    pw: 0x800,
    waves: 0,
    ring: false,
    sync: false,
    msbRose: false,
    noise: 0x7ffff8,
    env: new Envelope(),
  };
}

export class SidChip {
  constructor(sampleRate = 48000) {
    this.voices = [makeVoice(), makeVoice(), makeVoice()];
    this.model = 6581;
    this.cutoff = 1024;
    this.resonance = 0;
    this.mode = LOW_PASS;
    this.routing = 0;
    this.volume = 1;
    this.g = 0; this.k = 1.4142; this.fa1 = 0; this.fa2 = 0; this.fa3 = 0;
    this.ic1 = 0; this.ic2 = 0;
    this.decimate = [new Biquad(), new Biquad()];
    this.dcIn = 0; this.dcOut = 0; this.dcPole = 0.999;
    this.cycleCarry = 0;
    this.setSampleRate(sampleRate);
  }

  setSampleRate(sampleRate) {
    this.sampleRate = sampleRate > 0 ? sampleRate : 48000;
    const internal = this.sampleRate * OVERSAMPLE;
    this.cyclesPerSample = PAL_CLOCK / this.sampleRate;
    this.cyclesPerStepFixed = Math.round((PAL_CLOCK / internal) * 65536);

    // Fourth-order Butterworth as two biquads, at the oversampled rate.
    const fc = Math.min(20000, 0.45 * this.sampleRate);
    const qs = [0.5411961, 1.30656296];
    for (let i = 0; i < 2; i++) {
      const w0 = (2 * Math.PI * fc) / internal;
      const alpha = Math.sin(w0) / (2 * qs[i]);
      const cosw = Math.cos(w0);
      const a0 = 1 + alpha;
      const b = this.decimate[i];
      b.b0 = (1 - cosw) / 2 / a0;
      b.b1 = (1 - cosw) / a0;
      b.b2 = b.b0;
      b.a1 = (-2 * cosw) / a0;
      b.a2 = (1 - alpha) / a0;
      b.z1 = b.z2 = 0;
    }
    this.dcPole = 1 - (2 * Math.PI * 10) / this.sampleRate;
    this.updateFilterCoefficients();
  }

  setFrequency(v, reg) { this.voices[v].freq = reg & 0xffff; }
  setPulseWidth(v, reg) { this.voices[v].pw = reg & 0x0fff; }
  setWaveform(v, waves) { this.voices[v].waves = waves & 0x0f; }
  setRing(v, on) { this.voices[v].ring = on; }
  setSync(v, on) { this.voices[v].sync = on; }
  setEnvelope(v, a, d, s, r) { this.voices[v].env.setRates(a, d, s, r); }
  setGate(v, on) { this.voices[v].env.setGate(on); }
  gate(v) { return this.voices[v].env.gate; }

  // cutoff 0..2047, resonance 0..15, routing is a bitmask of voices.
  setFilter(cutoff, resonance, mode, routing) {
    const c = Math.max(0, Math.min(2047, cutoff | 0));
    const r = resonance & 15;
    this.routing = routing & 7;
    this.mode = mode & 7;
    if (c === this.cutoff && r === this.resonance) return;
    this.cutoff = c;
    this.resonance = r;
    this.updateFilterCoefficients();
  }

  setVolume(volume) { this.volume = (volume & 15) / 15; }

  setModel(model) {
    if (model === this.model) return;
    this.model = model;
    this.updateFilterCoefficients();
  }

  updateFilterCoefficients() {
    const x = this.cutoff / 2047;
    const internal = this.sampleRate * OVERSAMPLE;
    let fc;
    let q;
    if (this.model === 8580) {
      // Close to linear in the register, about 30 Hz to 12 kHz; strong,
      // clean resonance.
      fc = 30 + x * 12000;
      q = 0.707 + (this.resonance / 15) * 5;
    } else {
      // The 6581 never closes fully and opens much higher, with most of the
      // movement in the upper half of the register; milder resonance.
      fc = 200 * Math.exp(x * Math.log(90));
      q = 0.707 + (this.resonance / 15) * 2.3;
    }
    fc = Math.min(fc, 0.45 * internal);
    this.g = Math.tan((Math.PI * fc) / internal);
    this.k = 1 / q;
    this.fa1 = 1 / (1 + this.g * (this.g + this.k));
    this.fa2 = this.g * this.fa1;
    this.fa3 = this.g * this.fa2;
  }

  advance(v) {
    // freq * cyclesPerStepFixed overflows 32 bits, but stays far inside the
    // 53 bits a double holds exactly.
    const step = v.freq * this.cyclesPerStepFixed + v.frac;
    const inc = Math.floor(step / 65536);
    v.frac = step - inc * 65536;

    const prev = v.acc;
    const sum = prev + inc;
    v.msbRose = (prev & 0x800000) === 0 && ((sum & 0x800000) !== 0 || sum >= 0x1000000);

    // The noise LFSR is clocked by bit 19 of the accumulator going high, which
    // at high pitches happens more than once per step.
    let clocks = ((sum + 0x80000) >>> 20) - ((prev + 0x80000) >>> 20);
    if (clocks > 32) clocks = 32;
    while (clocks-- > 0) {
      const bit = ((v.noise >>> 22) ^ (v.noise >>> 17)) & 1;
      v.noise = ((v.noise << 1) | bit) & 0x7fffff;
    }
    v.acc = sum & 0xffffff;
  }

  waveOutput(v, source) {
    if (v.waves === 0) return 0x800;
    let out = 0x0fff;
    if (v.waves & TRI) {
      let msb = v.acc & 0x800000;
      if (v.ring) msb ^= source.acc & 0x800000;
      const folded = msb ? ~v.acc & 0x7fffff : v.acc & 0x7fffff;
      out &= (folded >>> 11) & 0x0fff;
    }
    if (v.waves & SAW) out &= v.acc >>> 12;
    if (v.waves & PULSE) out &= v.acc >>> 12 >= v.pw ? 0x0fff : 0;
    if (v.waves & NOISE) {
      const n = v.noise;
      out &=
        (((n >>> 20) & 1) << 11) | (((n >>> 18) & 1) << 10) |
        (((n >>> 14) & 1) << 9) | (((n >>> 11) & 1) << 8) |
        (((n >>> 9) & 1) << 7) | (((n >>> 5) & 1) << 6) |
        (((n >>> 2) & 1) << 5) | ((n & 1) << 4);
    }
    // Combined waveforms are approximated by the AND of their parts.
    return out;
  }

  // One output sample, in [-1, 1].
  render() {
    this.cycleCarry += this.cyclesPerSample;
    const cycles = Math.floor(this.cycleCarry);
    this.cycleCarry -= cycles;
    const [v0, v1, v2] = this.voices;
    v0.env.clock(cycles);
    v1.env.clock(cycles);
    v2.env.clock(cycles);

    const mos6581 = this.model !== 8580;
    const routing = this.routing;
    const e0 = v0.env.level / 255;
    const e1 = v1.env.level / 255;
    const e2 = v2.env.level / 255;
    let decimated = 0;

    for (let s = 0; s < OVERSAMPLE; s++) {
      this.advance(v0);
      this.advance(v1);
      this.advance(v2);
      // Voice 1 follows voice 3, 2 follows 1, 3 follows 2. Read every flag
      // before any reset, so one reset cannot hide another's edge.
      const r0 = v0.sync && v2.msbRose;
      const r1 = v1.sync && v0.msbRose;
      const r2 = v2.sync && v1.msbRose;
      if (r0) v0.acc = 0;
      if (r1) v1.acc = 0;
      if (r2) v2.acc = 0;

      const o0 = ((this.waveOutput(v0, v2) - 2048) / 2048) * e0;
      const o1 = ((this.waveOutput(v1, v0) - 2048) / 2048) * e1;
      const o2 = ((this.waveOutput(v2, v1) - 2048) / 2048) * e2;
      let filterIn = 0;
      let direct = 0;
      if (routing & 1) filterIn += o0; else direct += o0;
      if (routing & 2) filterIn += o1; else direct += o1;
      if (routing & 4) filterIn += o2; else direct += o2;

      let filtered = 0;
      if (routing !== 0) {
        let x = filterIn / 3;
        if (mos6581) x = softClip(x * 1.6) / 1.6;
        const x3 = x - this.ic2;
        const x1 = this.fa1 * this.ic1 + this.fa2 * x3;
        const x2 = this.ic2 + this.fa2 * this.ic1 + this.fa3 * x3;
        this.ic1 = 2 * x1 - this.ic1;
        this.ic2 = 2 * x2 - this.ic2;
        if (this.mode & LOW_PASS) filtered += x2;
        if (this.mode & BAND_PASS) filtered += x1;
        if (this.mode & HIGH_PASS) filtered += x - this.k * x1 - x2;
        filtered *= 3;
      } else {
        this.ic1 = this.ic2 = 0;
      }

      const mix = ((filtered + direct) / 3) * this.volume;
      decimated = this.decimate[1].process(this.decimate[0].process(mix));
    }

    // DC blocker: an extreme pulse width or a held sustain level would
    // otherwise park the speaker cone off-centre.
    const y = decimated - this.dcIn + this.dcPole * this.dcOut;
    this.dcIn = decimated;
    this.dcOut = y;
    return softClip(y * 1.2) * 0.85;
  }
}

// MIDI note (may be fractional, for vibrato and slides) to a SID frequency
// register value.
export function noteToReg(note) {
  const hz = 440 * Math.pow(2, (note - 69) / 12);
  return hzToReg(hz);
}

export function hzToReg(hz) {
  const reg = Math.round((hz * 16777216) / PAL_CLOCK);
  return reg < 0 ? 0 : reg > 0xffff ? 0xffff : reg;
}
