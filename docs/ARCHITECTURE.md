# sidicio — architecture

How sidicio works inside: the layers, the chip emulation step by step, the
two players, the song compiler and the worklet. The public API and the data
formats are in the [README](../README.md); how to work with the code is in
[TECHNICAL.md](TECHNICAL.md).

## Layers

```
 main thread                          audio thread (AudioWorklet)
 ───────────                          ───────────────────────────
 compileSong(song, instruments) ──┐
 effect definitions ──────────────┤   worklet.js  SidicioProcessor
                                  │     ├─ MusicPlayer ── SidChip (music)
 createSidicioNode(ctx)  node.js  │     └─ SfxPlayer   ── SidChip (effects)
   └─ node.port.postMessage ──────┘            │ 50 Hz tick
                                               ▼ one sample per render()
                                          output, mono to both channels
```

| Module | Role | Web API |
| --- | --- | --- |
| `chip.js` | `SidChip`: registers in, samples out; `noteToReg`, `hzToReg`; constants | none |
| `music.js` | `MusicPlayer`: the per-frame player routine for songs | none |
| `sfx.js` | `SfxPlayer`: frame programs for effects; `sweep`, `notes`, `midiToHz` | none |
| `song.js` | `compileSong`: the text song format to numeric rows | none |
| `worklet.js` | `SidicioProcessor`, registered as `'sidicio'` | `AudioWorkletProcessor`, guarded |
| `node.js` | `createSidicioNode(ctx)`: loads the worklet, returns the node | `AudioContext` |
| `index.js` | re-exports everything | — |

The split follows one rule: **everything that makes sound is pure
computation.** `chip.js`, `music.js`, `sfx.js` and `song.js` use no Web API,
so the same code renders in the browser's audio thread and in Node, where the
tests hash its output and tools write WAV files. `worklet.js` calls
`registerProcessor` only if it exists, so importing `index.js` in Node is
safe.

Dependencies are one-way: `music.js` and `sfx.js` depend on `chip.js`;
`song.js` depends on `music.js` for the `HOLD` and `OFF` markers; nothing
depends on `worklet.js` or `node.js`.

## The chip

`SidChip` emulates the MOS 6581 and 8580 at the level a player routine sees:
three voices, each with an oscillator and an envelope, a shared multimode
filter and a master volume. It is a JavaScript port of `native/sid_chip.cpp`
from the Android synthesizer app *Chip*, written from the datasheet and
public reverse-engineering notes, not from reSID.

### Clocks and rates

The chip runs on the PAL clock, 985 248 Hz (`PAL_CLOCK`). Audio leaves at the
host's sample rate (48 kHz typically) and is computed internally at 4× that
(`OVERSAMPLE`), 192 kHz at 48 kHz.

* Per output sample the chip advances `PAL_CLOCK / sampleRate` cycles
  (20.53 at 48 kHz); the fractional part is carried (`cycleCarry`), so over a
  second exactly 985 248 cycles elapse.
* Per internal step each oscillator advances by
  `freq × cyclesPerStepFixed`, where `cyclesPerStepFixed` is the cycles per
  internal step in 16.16 fixed point. The product overflows 32 bits but stays
  far inside the 53 bits a double holds exactly; the 16-bit remainder is
  kept in `frac`, so phase does not drift. Rounding the step to 1/65536 of a
  cycle puts pitch within 3 ppm of the register value.

### Oscillator

Each voice has a 24-bit phase accumulator (`acc`) and a 16-bit frequency
register: the output frequency is `freq × 985 248 / 2²⁴`, a resolution of
0.0587 Hz and a top of 3 848 Hz (`freq = 0xffff`). `noteToReg(midi)` and
`hzToReg(hz)` convert, clamping to 0–0xffff; `noteToReg` takes fractional
notes, which is how vibrato and slides are computed.

The waveforms are read from the accumulator as 12-bit values:

| Wave | Bits |
| --- | --- |
| `SAW` | the top 12 bits of the accumulator |
| `TRI` | the low 23 bits, folded by the MSB (inverted when it is set), top 12 |
| `PULSE` | all ones when the top 12 bits ≥ the 12-bit pulse width, else zero |
| `NOISE` | 8 bits of a 23-bit LFSR (taps 22 and 17) placed in the top byte |

**Combined waveforms** (several bits set) are the bitwise AND of their
parts. On the real chip they come from the analogue interaction of the
waveform outputs, and their timbre differs between chips; the AND is a
known, stable approximation, quieter than the original for some pairs.

**Noise** is clocked by bit 19 of the accumulator going high. At high
pitches that happens more than once per internal step, so the code counts
the crossings and clocks the LFSR that many times (capped at 32). Without
this, high noise would sound lower than its register says.

**Ring modulation** replaces the triangle's MSB with its XOR with the MSB of
the previous voice (voice 1 takes voice 3, 2 takes 1, 3 takes 2), which is
what the chip does: it only affects the triangle.

**Hard sync** resets a voice's accumulator when the previous voice's MSB
rises. All three "MSB rose" flags are computed before any reset, so one
reset cannot hide another voice's edge in the same step.

### Envelope

Each voice has the SID's ADSR generator, emulated as the chip counts it
rather than as curves:

* A **rate counter** counts chip cycles up to a period chosen by the attack,
  decay or release register (`RATE_PERIODS`, 9 to 31 251 cycles per step).
  With 255 steps from silence to full, attack 0 takes 2.3 ms and attack 15
  takes 8.1 s, the datasheet's 2 ms and 8 s.
* **Attack** is linear: one step up per period.
* **Decay and release** go through a second divider, `expPeriod`, which
  grows as the level falls past 0x5d, 0x36, 0x1a, 0x0e and 0x06 (periods 2,
  4, 8, 16, 30). That is the piecewise-exponential tail of the SID; with the
  same register value decay and release last about three times the attack.
* **Sustain** is the level decay stops at, `sustain × 0x11` (0–255 in 16
  steps).
* **Gate** on enters attack *from the current level*; gate off enters
  release. Gate off then on within one frame re-strikes a note without a
  click, which is what the players do.

The envelope is clocked once per output sample with the cycles of that
sample (20.5 at 48 kHz), not once per internal step. `clock()` loops, so
every envelope step still happens, even at the shortest period of 9
cycles; only where inside the sample it happened is lost, which is not
audible, and the work is a quarter.

### Filter

The voices whose bit is set in `routing` are summed into the filter; the
others go straight to the mix.

* **Topology**: a state-variable filter in the trapezoidal (TPT) form, with
  `g = tan(π·fc / fs)` and damping `k = 1/q`. Low-pass, band-pass and
  high-pass outputs come from the same state and are summed by the `mode`
  bits, as on the chip (LP+HP is a notch).
* **Cutoff curve** (the 11-bit register mapped to Hz):

| Model | Cutoff | Resonance (q) | Character |
| --- | --- | --- | --- |
| 8580 | `30 + x·12 000` Hz, about linear, 30 Hz – 12 kHz | 0.707 – 5.7 | clean, strong resonance |
| 6581 | `200 · 90ˣ` Hz, 200 Hz – 18 kHz | 0.707 – 3.0 | never fully closes, most movement in the upper half, mild resonance, soft-clipped input |

  where `x = cutoff / 2047`. The cutoff is capped at 0.45 of the internal
  rate.
* **6581 grit**: before the filter the input goes through a soft clipper
  (`softClip(x·1.6)/1.6`), the distortion that makes early C64 filters
  sound dirty when driven.
* Coefficients are recomputed only when cutoff, resonance, model or sample
  rate change; a filter LFO in a song changes the cutoff at 50 Hz, not per
  sample.
* With no voice routed, the filter state is reset, so turning it on later
  does not release a stale charge.

### Output stage

Per internal step: `mix = (filtered + direct) / 3 × volume`. Then:

1. **Decimation**: a fourth-order Butterworth low-pass, two biquads with
   q 0.541 and 1.307, at `min(20 kHz, 0.45 × sampleRate)`, run at the
   internal rate; the last internal sample is kept. That removes the
   aliasing that pulse and saw edges at 192 kHz would fold into the audible
   band.
2. **DC blocker**: a one-pole high-pass at 10 Hz. An extreme pulse width or
   a held sustain level would otherwise leave the output off-centre.
3. **Soft clip**: `softClip(y × 1.2) × 0.85`, a rational tanh-like curve,
   so three voices at full level with resonance saturate instead of
   wrapping.

The result is one float sample in [−1, 1] per `render()`.

### Cost

Measured on 2026-10-29 with Node 26 on the development machine, three voices
gated and filtered: one chip renders a second of 48 kHz audio in 12.5 ms on
the 6581 model and 9.3 ms on the 8580, that is about 1.3% and 0.9% of one
core. The worklet runs two chips, so about 2–2.5%. The cost is per sample
and does not depend on what plays; a silent chip costs the same as a busy
one.

## The music player

`MusicPlayer.tick()` does what a C64 player routine does once per PAL frame
(50 Hz):

1. When the row timer runs out, reset it to `song.speed` frames and read the
   next row of each voice (`readRow`).
2. Update the song filter (with its LFO, a raised cosine between `min` and
   `max` over `period` frames).
3. For every active voice compute this frame's pitch, waveform and pulse
   width, and write them to the chip.

### Rows

A compiled song has one `Int32Array` per voice, all the same length. A cell
is:

| Value | Meaning |
| --- | --- |
| `HOLD` (−1) | nothing happens; the note goes on |
| `OFF` (−2) | gate off: the note enters release |
| `note \| inst << 7 \| slide << 14` | MIDI note (7 bits), instrument index (7 bits, up to 128), slide flag |

A new note (not a slide) loads the instrument's envelope and pulse width and
re-strikes the gate (off then on in the same frame). A slide keeps the
envelope and the pulse sweep running and moves the pitch from the old note
to the new one over `glide` frames. Ring, sync and filter routing follow
the instrument of the last note on each voice.

At the end of the rows the song jumps to `loopRow`, or, for a jingle
(`loop: -1`), stops and calls `onEnd`.

### Per-frame pitch and timbre

In order, per voice and frame (`v.frame` counts frames since the note):

1. **Glide**: linear interpolation from the previous note.
2. **Wave table** (`table`), if any: entry `min(frame, last)` gives the wave
   and either an absolute note or an offset. This is how drums are written:
   a noise burst, then a falling pulse.
3. Otherwise **arpeggio** (`arp`): an offset from the list, advancing every
   `arpSpeed` frames.
4. **Vibrato** (`vib: [delay, depth, speed]`): after `delay` frames a sine of
   `depth` semitones.
5. **Pulse-width sweep**: `pwSpeed` per frame, bouncing between `pwMin` and
   `pwMax`.
6. **Gate length**: with `gateFrames`, the gate drops after that many frames
   (staccato without writing `-`).

Pitch is computed in fractional semitones and converted once with
`noteToReg`, so vibrato and glide are smooth.

## The effect player

An effect is a frame program: one `[wave, hz, pw]` per frame. `SfxPlayer`:

* **Allocates** a voice on `play(name)`: a free one if any, otherwise the
  oldest playing effect with equal or lower priority; if every voice holds a
  higher-priority effect, the new one is dropped. A pickup sound never cuts
  a death sound.
* **Ticks** at 50 Hz: writes the frame's wave, frequency and pulse width;
  `null` drops the gate for a frame; `RETRIGGER` (0x80 ORed into the wave)
  re-strikes the envelope; at the end of the program the gate drops and the
  voice is freed.
* **Filters** an effect with a `cutoff` list through the low-pass, one value
  per frame. The filter is shared, so when several filtered effects overlap
  the cutoff of the highest-numbered voice wins for that frame.

`sweep` (exponential pitch glide), `notes` (re-struck sequence) and
`midiToHz` build frame programs from a few numbers.

## The song compiler

`compileSong` turns sections of text into rows:

1. Each voice string is split on whitespace; each token is one row except
   `@name`, which switches the current instrument.
2. A token is `.` (HOLD), `-` (OFF), a drum letter from `drums` (C4 with
   that instrument), or a note matching `^[A-G]#?-?\d~?(@\w+)?$`
   (`C4` = MIDI 60, octave −1 to 9). Notes above G9 (MIDI 127) do not
   fit the 7 bits of a cell and are not checked.
3. `defaults[v]` is prepended as `@name` to every section of voice `v`, so a
   voice that names no instrument still plays, and a voice does not carry an
   instrument across sections unless it names it again (each section reads
   alone).
4. Each section is padded with HOLD to its longest voice, so the three
   voices stay aligned.
5. Instruments are numbered in order of first use; only used ones are kept.

Errors throw at compile time with the song name and the token: unknown
instrument, a note before any instrument, a token that is not a note.

## The worklet

`SidicioProcessor` holds **two chips**, one for music and one for effects,
like a dual-SID cartridge. A single C64 SID must steal a music voice for
each effect; with two, the tune never drops a note and the effects have
three voices of their own. The price is twice the CPU of one chip.

* The 50 Hz tick is a sample countdown of `sampleRate / 50` (960 samples at
  48 kHz), fractional, so the frame rate is exact at any sample rate. It
  ticks both players on the same sample.
* Each sample is `music × musicGain + sfx × sfxGain` (0.8 each by default),
  written to channel 0 and copied to the others: the SID is mono.
* Messages (`songs`, `sfxDefs`, `play`, `stop`, `pause`, `sfx`, `gain`,
  `model`) are handled between render quanta, so a change lands within 128
  samples (2.7 ms at 48 kHz). The only message back is `songEnd`.
* Songs and effects are sent once as plain data (structured clone);
  `play` and `sfx` then carry only a name.
* `process` always returns `true`: the node stays alive while connected,
  and silence costs the same as sound (see Cost). Suspend the
  `AudioContext` when the page hides.

`createSidicioNode(ctx)` resolves the worklet file with
`new URL('./worklet.js', import.meta.url)`, so it works from any folder,
`node_modules` or a submodule, without configuration.

## Choices and limits

| Choice | Why | Price |
| --- | --- | --- |
| Register-level emulation, not sample playback | real envelopes, filter sweeps, ring and sync, tiny songs | CPU per sample, about 1% of a core per chip |
| Written from the datasheet, not reSID | MIT licence, small code, the same model as the C++ engine | combined waveforms and the 6581 filter are approximations |
| 4× oversampling with decimation | no audible aliasing on pulse and saw | four oscillator steps per sample |
| Envelope clocked per sample | a quarter of the work | sub-sample envelope timing is lost (inaudible) |
| 50 Hz players | the C64's own timing, songs port in both directions | effects and notes cannot start between frames (20 ms grid) |
| Two chips in the worklet | music never loses a voice | twice the CPU |
| Mono output | the SID is mono | no stereo placement |
| Golden hash test | any change in sound is caught | a deliberate change must update the hash |
