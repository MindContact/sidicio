import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SidChip, PULSE, SAW, LOW_PASS, noteToReg, compileSong, HOLD, OFF } from '../src/index.js';
import { RATE, renderSong, renderSfx } from './render.mjs';
import { INSTRUMENTS, DRUMS, DEFAULTS, DEMO, SONGS, SFX } from '../examples/demo.js';

function rms(samples) {
  let sum = 0;
  for (const s of samples) {
    assert.ok(Number.isFinite(s), 'NaN or Infinity in output');
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

// A fixed patch rendered to a hash. If this changes, the emulation changed:
// make sure that was meant, check the same fix against mcma-chip's
// sid_chip.cpp, then update the hash.
const GOLDEN = {
  6581: '465c6f84259305d0d97b2b0de8cadb69b50019fbe312a3669aa3a3f90cd5a341',
  8580: '29c33164fff240be0055a76fcbc3daeb83bf466bb99013f5d3a87a6fa440467c',
};

function goldenRender(model) {
  const chip = new SidChip(RATE);
  chip.setModel(model);
  chip.setVolume(15);
  chip.setFilter(900, 10, LOW_PASS, 1);
  chip.setEnvelope(0, 0, 9, 8, 6);
  chip.setWaveform(0, PULSE);
  chip.setPulseWidth(0, 0x400);
  chip.setFrequency(0, noteToReg(45));
  chip.setEnvelope(1, 2, 8, 10, 4);
  chip.setWaveform(1, SAW);
  chip.setFrequency(1, noteToReg(69));
  chip.setGate(0, true);
  chip.setGate(1, true);
  const out = new Float32Array(RATE / 2);
  for (let i = 0; i < out.length; i++) {
    if (i === RATE / 4) { chip.setGate(0, false); chip.setGate(1, false); }
    out[i] = chip.render();
  }
  return createHash('sha256').update(Buffer.from(out.buffer)).digest('hex');
}

for (const model of [6581, 8580]) {
  test(`chip output is unchanged (${model})`, () => {
    assert.equal(goldenRender(model), GOLDEN[model]);
  });
}

test('noteToReg follows the PAL clock', () => {
  // A4 = 440 Hz is register 7493 on a PAL C64.
  assert.equal(noteToReg(69), 7493);
});

test('compileSong builds three equal voices', () => {
  const song = compileSong(DEMO, INSTRUMENTS, { drums: DRUMS, name: 'demo' });
  assert.equal(song.rows.length, 3);
  assert.equal(new Set(song.rows.map((r) => r.length)).size, 1);
  assert.equal(song.loopRow, 0);
  assert.equal(song.rows[0][0] & 127, 45); // A2
  assert.equal(song.rows[0][1], HOLD);
  assert.ok(song.rows[1][11] & (1 << 14), 'C5~ is a slide');
});

test('compileSong reports bad input', () => {
  const one = (v) => ({ speed: 6, sections: [{ v: [v, '', ''] }], loop: 0 });
  assert.throws(() => compileSong(one('@nope C4'), INSTRUMENTS), /unknown instrument/);
  assert.throws(() => compileSong(one('@bass X9'), INSTRUMENTS), /bad token/);
  assert.throws(() => compileSong(one('C4'), INSTRUMENTS), /no instrument/);
  assert.equal(compileSong(one('C4'), INSTRUMENTS, { defaults: ['bass'] }).rows[0][0] & 127, 60);
  assert.equal(compileSong(one('@bass C4 -'), INSTRUMENTS).rows[0][1], OFF);
});

test('the demo song plays and loops', () => {
  const song = compileSong(DEMO, INSTRUMENTS, { drums: DRUMS });
  for (const model of [6581, 8580]) {
    const { out, ended } = renderSong(song, 3, model);
    assert.ok(rms(out) > 0.01, 'nearly silent');
    assert.equal(ended, false);
  }
});

test('a jingle ends and calls onEnd', () => {
  const song = compileSong({ ...DEMO, loop: -1 }, INSTRUMENTS, { drums: DRUMS });
  const { ended } = renderSong(song, 3);
  assert.equal(ended, true);
});

test('the example songs are whole bars and play', () => {
  for (const [name, song] of Object.entries(SONGS)) {
    song.sections.forEach((section, i) => {
      const counts = section.v.map((t) => t.trim().split(/\s+/).filter((x) => !x.startsWith('@')).length);
      assert.equal(new Set(counts).size, 1, `${name} section ${i}: voice lengths ${counts.join('/')}`);
      assert.equal(counts[0] % 16, 0, `${name} section ${i}: ${counts[0]} rows is not whole bars`);
    });
    const compiled = compileSong(song, INSTRUMENTS, { drums: DRUMS, defaults: DEFAULTS, name });
    const seconds = Math.min(20, (compiled.rows[0].length * compiled.speed) / 50 + 2);
    const { out, ended } = renderSong(compiled, seconds);
    assert.ok(rms(out) > 0.01, `${name} nearly silent`);
    assert.equal(ended, song.loop < 0, `${name}: ended ${ended}, loop ${song.loop}`);
  }
});

test('every effect sounds', () => {
  for (const name of Object.keys(SFX)) assert.ok(rms(renderSfx(SFX, name)) > 0.01, `${name} nearly silent`);
});
