# sidicio — technical guide

How to use sidicio in a page and in Node, how to write and debug sound with
it, how to test and change the emulation, and how to release. The formats and
the API are in the [README](../README.md); how it works inside is in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Requirements

| What | Version | Why |
| --- | --- | --- |
| Browser | any current Chrome, Firefox, Safari, Edge | `AudioWorklet`, ES modules |
| Page origin | `https://` or `http://localhost` | AudioWorklet needs a secure context; `file://` does not work |
| Node | 18 or later (CI: 22, 24, 26) | tests and offline rendering |

No dependencies, nothing to build.

## Adding sidicio to a project

| How | Import |
| --- | --- |
| `npm install sidicio` | `import { … } from 'sidicio'` (bundler or import map) |
| git submodule in `lib/sidicio`, pinned to a tag | `import { … } from './lib/sidicio/src/index.js'` |
| copy of `src/` | `import { … } from './sidicio/index.js'` |

Pin a version: the sound of a song depends on the emulation, and a new
version may change it (see *The golden hash* below).

The worklet file is found relative to `node.js`
(`new URL('./worklet.js', import.meta.url)`), so it works from any folder.
A bundler must keep `src/worklet.js` as a separate file next to `node.js`;
with Vite or webpack that means treating it as an asset URL, not inlining it.

## In the browser

### Starting audio

Browsers keep an `AudioContext` suspended until a user gesture. The pattern
that plays as early as allowed:

```js
let ctx = null;
let node = null;

async function startAudio() {
  if (ctx) { if (ctx.state === 'suspended') await ctx.resume(); return; }
  ctx = new AudioContext({ latencyHint: 'interactive' });
  node = await createSidicioNode(ctx);
  node.connect(ctx.destination);
  node.port.postMessage({ type: 'songs', songs: SONGS });
  node.port.postMessage({ type: 'sfxDefs', defs: SFX });
  node.port.postMessage({ type: 'play', name: 'title' });
  if (ctx.state === 'suspended') await ctx.resume();
}

startAudio();                                            // where allowed, at once
addEventListener('keydown', startAudio, { once: true }); // elsewhere, at the first key
addEventListener('pointerdown', startAudio, { once: true });
```

Compile songs once, on the main thread, and send them once; after that a
`play` carries only a name.

### Volume, mute, model

```js
// Sliders 0..10, squared so the low end is actually quiet.
const gain = (v) => (v / 10) ** 2 * 0.9;
node.port.postMessage({ type: 'gain', music: gain(7), sfx: gain(8) });
node.port.postMessage({ type: 'gain', music: 0, sfx: 0 });   // mute
node.port.postMessage({ type: 'model', model: 8580 });       // or 6581
```

### When the page hides

The worklet costs the same CPU playing or silent. Suspend the context when
the tab is hidden and resume it when it comes back:

```js
document.addEventListener('visibilitychange', () => {
  if (!ctx) return;
  if (document.hidden) ctx.suspend(); else ctx.resume();
});
```

### Knowing when a jingle ends

```js
node.port.onmessage = (e) => {
  if (e.data.type === 'songEnd') node.port.postMessage({ type: 'play', name: 'level' });
};
```

### The motorino engine

The motorino game engine wraps all of the above in its `Audio` class
(`createNode` is `createSidicioNode`); it does not import sidicio itself, so
each game pins its own version.

## In Node: rendering offline

The chip and the players are plain computation. To render, drive the player
at 50 Hz exactly as the worklet does: a countdown of `rate / 50` samples.

```js
import { writeFileSync } from 'node:fs';
import { SidChip, MusicPlayer, compileSong, PULSE } from 'sidicio';

const RATE = 48000;
const instruments = { lead: { wave: PULSE, adsr: [1, 9, 10, 6], pw: 0x500, vib: [10, 0.2, 0.6] } };
const song = compileSong({ speed: 6, sections: [{ v: ['@lead A4 . C5 . E5 . - .', '', ''] }], loop: -1 }, instruments);

const chip = new SidChip(RATE);
const player = new MusicPlayer(chip);
player.play(song);
const samples = new Float32Array(RATE * 2);
let countdown = 0;
for (let i = 0; i < samples.length; i++) {
  if (--countdown <= 0) { countdown += RATE / 50; player.tick(); }
  samples[i] = chip.render();
}

// 16-bit mono PCM WAV.
const data = Buffer.alloc(samples.length * 2);
samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
const head = Buffer.alloc(44);
head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
head.write('data', 36); head.writeUInt32LE(data.length, 40);
writeFileSync('song.wav', Buffer.concat([head, data]));
```

The same loop with `SfxPlayer` and `player.play(name)` renders an effect.
`test/render.mjs` has both as `renderSong` and `renderSfx`. To reproduce what
the worklet outputs, render the music and the effects on two chips and sum
them with the gains.

Offline rendering is how to:

* compare a change to the emulation by ear: render the same songs before and
  after, and listen to or diff the WAV files;
* check that a song is not silent, does not clip, ends when it should (the
  tests do this with an RMS and `onEnd`);
* make audio for a trailer or a store page without recording the browser.

## Writing sound

### Songs

* Speed 6 (6 frames per row, 8.3 rows per second) with 16 rows per bar is
  125 BPM in 4/4 with sixteenth-note rows; speed 5 is 150 BPM, speed 7 about
  107.
* Keep the three voices of a section the same number of rows: the compiler
  pads the short ones with holds, which hides a missing note. The tests of
  the example songs check equal lengths and whole bars (multiples of 16).
* Name every instrument with `@name` at the start of each voice of each
  section, or give `defaults`: a voice does not carry its instrument into the
  next section, so a section reads on its own.
* Use `drums` for the drum voice (`K S H`), and a `table` for each drum:
  a noise frame, then a pulse falling in pitch is a kick; noise with a short
  release is a hat.
* A jingle (`loop: -1`) should end with `-` on every voice, so the release
  is heard before `songEnd`.

### Instruments: where each sound comes from

| Sound | Recipe |
| --- | --- |
| Thick bass | `PULSE`, `pw` 0x300, `pwSpeed` 20 between 0x200 and 0x900, `filter: true` with a low-pass song filter |
| Plucked bass | `SAW`, `adsr [0, 7, 4, 1]` |
| Singing lead | `PULSE` or `SAW`, `vib [8–10, 0.15–0.2, 0.6–0.7]`, `glide` 3 for `~` slides |
| Chord on one voice | `arp [0, 3, 7]` (minor) or `[0, 4, 7]` (major), every frame |
| Slow pad | `SAW`, `adsr [6, 10, 10, 9]`, `arp [0, 4, 7, 12]` with `arpSpeed` 3, filtered |
| Bell | `TRI`, `adsr [0, 10, 0, 10]`, light vibrato after 16 frames |
| Metallic | `ring: true` on a `TRI` voice, the previous voice an octave and a fifth away |

The demo (`examples/demo.js`) has these and more, used in four songs.

### Effects

* Priority: 1 for small things (steps, pickups), 2 for actions (jump,
  shot), 3 for what must be heard (hit, death). Equal priority steals the
  oldest.
* Keep them short: 6–24 frames (120–480 ms). A long effect holds its voice,
  and when three higher-priority effects hold all three, a new one is
  dropped.
* From the demo: `sweep(PULSE, 190, 620, 9, 0x300)` is a jump;
  `notes(PULSE, [midiToHz(84), midiToHz(91)], 3, 0x400)` a coin;
  `sweep(NOISE, 900, 110, 24)` with a falling `cutoff` an explosion.
* A `cutoff` list makes an effect darker over time: falling values close
  the low-pass.

## Working on sidicio

```bash
npm test        # node --test, about 1.5 s
npm run demo    # http://localhost:8138/examples/
```

| Test | What it guards |
| --- | --- |
| `chip output is unchanged (6581)` / `(8580)` | the golden hash of a fixed patch |
| `noteToReg follows the PAL clock` | A4 = 440 Hz = register 7493 |
| `compileSong builds three equal voices` | padding, the cell encoding, slides |
| `compileSong reports bad input` | unknown instruments, bad tokens, notes with no instrument |
| `the demo song plays and loops`, `a jingle ends and calls onEnd` | the player's end and loop logic, on both models |
| `the example songs are whole bars and play` | the demo songs are aligned, whole bars, not silent |
| `every effect sounds` | every demo effect is audible |
| `the English and Italian READMEs have the same shape` | `README.md` and `README.it.md` stay in step |

### The golden hash

The test renders half a second of a fixed patch (a filtered pulse bass and a
saw, gate released halfway) on each model and compares the SHA-256 of the
raw float samples with a stored value. Any change to the oscillators,
envelope, filter or output stage changes it, even one no one would hear.

That is the point: a change to the sound is never accidental. When a change
is meant:

1. Render the example songs before and after (see *Rendering offline*) and
   listen to both on both models.
2. Check whether the same change applies to the C++ engine of the *Chip*
   app (`native/sid_chip.cpp`), which this code is a port of: the two
   should keep sounding the same.
3. Update the hash in `test/sidicio.test.mjs` in the same commit, and say in
   the message what changed in the sound.
4. Release it as a minor version (before 1.0) and say so in the notes:
   projects that pin sidicio will hear the difference.

The hash depends on floating-point results. Arithmetic is exact in
JavaScript, but `Math.tan`, `Math.exp` and `Math.pow` (filter and decimation
coefficients, `noteToReg`) are not required to be bit-exact: the hash is the
same on the Node versions in the CI, and a new JavaScript engine could in
principle move it without any change here. If the hash fails only on one
platform, that is the first suspect.

### The demo

`examples/index.html` plays the four example songs and a jingle, five
effects, with separate volume sliders for music and effects and a model
switch. The server (`tools/serve.mjs`) sends `Cache-Control: no-store`:
with a default static server Chrome keeps the modules and the worklet in
cache, and a reload does not pick up an edit to `chip.js`. If the worklet
still looks stale, close the tab: an AudioWorklet module is loaded once per
`AudioContext`.

### Rules for changes

* `chip.js`, `music.js`, `sfx.js` and `song.js` use **no Web API**: they
  must run in Node and in the worklet scope, which has no DOM, no `window`
  and no `fetch`.
* No allocation inside `render()` and `tick()`: they run 48 000 and 50
  times a second on the audio thread, and garbage collection there is heard
  as a click.
* Every module starts with a comment that says what it does, its formats
  and units; change it with the code.
* `README.md` and `README.it.md` say the same things; change both in the
  same commit.
* Code, identifiers and comments in English.

### Versioning

Semantic versioning. Until 1.0 a minor version may change the API or the
sound; a patch changes neither. A different golden hash is at least a minor
version.

## Releasing

1. Bump `version` in `package.json` and commit.
2. `git tag vX.Y.Z && git push origin main vX.Y.Z`.
3. The `release` workflow checks that the tag matches `package.json`, runs
   the tests and **stages** the version on npm through trusted publishing
   (OIDC, no token in the repository). Staged publishing needs npm 11.15 or
   later, which ships with Node 26.
4. A maintainer approves it on npmjs.com, *Staged Packages* tab, with 2FA.
   Until then nothing is public.

`ci.yml` runs the tests on every push to `main` and every pull request, on
Node 22, 24 and 26. The npm package contains `src/`, the READMEs and the
licence; tests, demo and these documents stay in the repository.
