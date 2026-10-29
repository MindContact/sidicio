# sidicio

*[Italiano](README.it.md)*

The SID, the Commodore 64 sound chip, emulated in plain JavaScript: three
voices, the filter, the envelopes with their exponential tail. On top of the
chip it has a music player and a sound-effect player that work like a C64
player routine (one tick per PAL frame, 50 Hz), and a text format for writing
songs the way a tracker musician does.

No dependencies, no build: ES modules that run in an AudioWorklet in the
browser and in Node, where you can test and render offline.

The name: **SID** + *s**ilicio*** ("silicon" in Italian).

## What it does

* **The chip.** Triangle, sawtooth, pulse with variable width, noise, and their
  combinations; ring modulation and hard sync between neighbouring voices; ADSR
  envelopes with the datasheet's timings and the exponential decay; multimode
  LP/BP/HP filter with resonance. Two models: 6581 (the gritty filter of early
  C64s) and 8580 (clean). 4x oversampling with a decimation filter.
* **Music player.** Three voices of rows; per-instrument arpeggio, vibrato,
  glide, pulse-width sweep, wave tables for drums, filter routing; a song-wide
  filter with an LFO on the cutoff. Songs loop or play once (jingles).
* **Effect player.** Effects are frame programs (wave, frequency, pulse width
  per frame); three can overlap, a fourth steals the oldest voice of equal or
  lower priority.
* **Dual SID in a worklet.** One chip plays the music, one the effects, like a
  dual-SID cartridge: the tune never loses a voice to a jump sound.

## Quick start

```bash
npm install sidicio
```

or, with no package manager, copy the `src/` folder (or add the repository as a
git submodule) and import it by relative path.

```js
import { createSidicioNode, compileSong, PULSE, NOISE, sweep } from 'sidicio';

const instruments = {
  bass: { wave: PULSE, adsr: [0, 8, 9, 2], pw: 0x300 },
  lead: { wave: PULSE, adsr: [1, 9, 10, 6], pw: 0x500, vib: [10, 0.2, 0.6] },
};
const song = {
  speed: 6,
  sections: [{ v: ['@bass A2 . A3 . F2 . G2 .', '@lead A4 . . . C5 . E5 .', ''] }],
  loop: 0,
};
const sfx = { boom: { prio: 1, adsr: [0, 9, 0, 0], frames: sweep(NOISE, 900, 100, 20) } };

// After a user gesture: browsers keep audio suspended until one.
const ctx = new AudioContext();
const node = await createSidicioNode(ctx);
node.connect(ctx.destination);
node.port.postMessage({ type: 'songs', songs: { theme: compileSong(song, instruments) } });
node.port.postMessage({ type: 'sfxDefs', defs: sfx });
node.port.postMessage({ type: 'play', name: 'theme' });
node.port.postMessage({ type: 'sfx', name: 'boom' });
```

The page in `examples/` plays four example songs and a jingle (all written
for it, in `examples/demo.js`), five effects, and has separate volume
sliders for music and effects: `npm run demo`, then open
`http://localhost:8138/examples/`.

## The worklet

`createSidicioNode(ctx)` loads `src/worklet.js` and returns an
`AudioWorkletNode` (registered as `'sidicio'`, stereo output, no inputs),
connected to nothing. You talk to it with `node.port.postMessage`:

| Message | Effect |
|---|---|
| `{ type: 'songs', songs }` | compiled songs by name |
| `{ type: 'sfxDefs', defs }` | effect definitions by name |
| `{ type: 'play', name }` | start a song from its first row |
| `{ type: 'stop' }` | stop the music |
| `{ type: 'pause', paused }` | pause or resume the music |
| `{ type: 'sfx', name }` | trigger an effect |
| `{ type: 'gain', music, sfx }` | linear output gains (default 0.8 each) |
| `{ type: 'model', model }` | `6581` or `8580`, both chips |

The node posts back `{ type: 'songEnd' }` when a song that does not loop
finishes.

## Songs

A song is plain data:

```js
{
  speed: 6,                 // frames (1/50 s) per row
  sections: [{ v: [voice1, voice2, voice3] }, ...],
  loop: 0,                  // section to loop back to; -1 plays once
  filter: { cutoff, resonance, mode, lfo: { min, max, period } },  // optional
}
```

Each voice is a string of whitespace-separated tokens, one per row:

| Token | Meaning |
|---|---|
| `C4`, `D#5` | note (C4 = MIDI 60) with the voice's current instrument |
| `C4@lead` | one note with another instrument |
| `C4~` | slide into the note without re-striking it (needs `glide`) |
| `.` | hold |
| `-` | release (gate off) |
| `@name` | switch the current instrument (takes no row) |

`compileSong(song, instruments, options)` turns it into the rows the player
reads, and throws on unknown tokens or instruments. Options:

* `drums`: single-letter tokens mapped to instrument names, e.g.
  `{ K: 'kick', S: 'snare' }`; a drum plays its instrument at C4.
* `defaults`: the instrument each voice starts every section with, e.g.
  `['bass', 'lead', 'arp']`. Without it, a voice must name its instrument.
* `name`: used in error messages.

Sections are padded to their longest voice with holds.

## Instruments

| Field | Meaning |
|---|---|
| `wave` | `TRI`, `SAW`, `PULSE`, `NOISE`, or an OR of them |
| `adsr` | `[attack, decay, sustain, release]`, 0–15 as on the chip |
| `pw` | starting pulse width, 0–0xfff |
| `pwSpeed`, `pwMin`, `pwMax` | pulse-width sweep per frame, bouncing between the limits |
| `arp` | semitone offsets cycled every frame (`arpSpeed` frames per step) |
| `vib` | `[delay, depth, speed]`: vibrato after `delay` frames, `depth` semitones |
| `glide` | frames a `~` slide takes |
| `table` | per-frame `[wave, note, absolute]` entries, the last one held; `note` is absolute if the third value is truthy, else an offset (drums) |
| `filter` | route this voice through the song's filter |
| `ring`, `sync` | ring modulation / hard sync with the previous voice |
| `gateFrames` | release the gate after this many frames |

## Effects

```js
{ prio: 1, adsr: [0, 6, 0, 0], frames: [[wave, hz, pw], ...], cutoff: [...] }
```

One entry per frame. `null` drops the gate for that frame; a wave ORed with
`RETRIGGER` strikes the envelope again. `cutoff`, if present, routes the voice
through the low-pass filter with one cutoff (0–2047) per frame. Helpers:
`sweep(wave, fromHz, toHz, frames, pw)` for an exponential pitch sweep,
`notes(wave, hzList, framesEach, pw)` for a re-struck sequence, `midiToHz`.

## Using the chip directly

Everything above the chip is optional. `SidChip` takes register-level calls
and returns one sample per `render()`:

```js
import { SidChip, PULSE, LOW_PASS, noteToReg } from 'sidicio';

const chip = new SidChip(48000);
chip.setEnvelope(0, 0, 9, 8, 6);
chip.setWaveform(0, PULSE);
chip.setPulseWidth(0, 0x400);
chip.setFrequency(0, noteToReg(45));
chip.setFilter(900, 10, LOW_PASS, 1);   // cutoff 0–2047, resonance 0–15, mode, voice mask
chip.setGate(0, true);
const sample = chip.render();           // in [-1, 1]
```

Also: `setRing`, `setSync`, `setVolume`, `setModel`, `setSampleRate`,
`hzToReg`. `MusicPlayer` and `SfxPlayer` take a chip and need `tick()` 50
times a second; in Node that is how you render to a file (see
`test/render.mjs`).

## Development

```bash
npm test        # node:test, no dependencies
npm run demo    # serves the repo on :8138, open /examples/ (node tools/serve.mjs [port])
```

The demo server sends `Cache-Control: no-store`: with a default static
server Chrome keeps the modules and the worklet in cache, and a reload does
not pick up an edit.

The tests include a hash of a fixed patch rendered on both models: if it
changes, the emulation changed. That is fine when meant; update the hash in the
same commit.

sidicio is a port of `native/sid_chip.cpp` from **Chip**, a SID synthesizer app
for Android by the same author. A fix to the emulation in one is worth checking
in the other.

### Releasing

1. Bump `version` in `package.json` and commit.
2. `git tag vX.Y.Z && git push origin main vX.Y.Z`.
3. The `release` workflow runs the tests and stages the version on npm
   through trusted publishing (no token in the repository).
4. Approve it on npmjs.com, *Staged Packages* tab, with 2FA. Until then
   nothing is public.

## License

[MIT](LICENSE) © MindContact | Roberto Luttino
