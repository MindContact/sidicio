// Offline rendering shared by the tests and the example WAV writer: drives a
// player at 50 Hz the way the worklet does, into a Float32Array.

import { SidChip, MusicPlayer, SfxPlayer } from '../src/index.js';

export const RATE = 48000;

function render(chip, tick, seconds) {
  const out = new Float32Array(Math.floor(seconds * RATE));
  let countdown = 0;
  for (let i = 0; i < out.length; i++) {
    if (--countdown <= 0) { countdown += RATE / 50; tick(); }
    out[i] = chip.render();
  }
  return out;
}

export function renderSong(song, seconds, model = 6581) {
  const chip = new SidChip(RATE);
  chip.setModel(model);
  const player = new MusicPlayer(chip);
  let ended = false;
  player.onEnd = () => { ended = true; };
  player.play(song);
  const out = render(chip, () => player.tick(), seconds);
  return { out, ended };
}

export function renderSfx(defs, name, seconds = 1) {
  const chip = new SidChip(RATE);
  const player = new SfxPlayer(chip);
  player.defs = defs;
  player.play(name);
  return render(chip, () => player.tick(), seconds);
}
