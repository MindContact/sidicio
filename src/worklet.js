// The AudioWorklet processor: two SID chips side by side, like a dual-SID
// cartridge, one for the music and one for sound effects. A single C64 SID
// would have to steal a music voice for every effect; with two, the tune
// never drops a note. Both players tick at 50 Hz, like a PAL C64 player.
//
// Registered as 'sidicio'. Messages it accepts on its port:
//   { type: 'songs', songs }       compiled songs by name (see song.js)
//   { type: 'sfxDefs', defs }      effect definitions by name (see sfx.js)
//   { type: 'play', name }         start a song from its first row
//   { type: 'stop' }               { type: 'pause', paused }
//   { type: 'sfx', name }          trigger an effect
//   { type: 'gain', music, sfx }   linear output gains
//   { type: 'model', model }       6581 or 8580, both chips
// and posts back { type: 'songEnd' } when a non-looping song finishes.
//
// Registration is guarded so the file can be imported outside a worklet.

import { SidChip } from './chip.js';
import { MusicPlayer } from './music.js';
import { SfxPlayer } from './sfx.js';

if (typeof registerProcessor === 'function') {
  class SidicioProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.musicChip = new SidChip(sampleRate);
      this.sfxChip = new SidChip(sampleRate);
      this.music = new MusicPlayer(this.musicChip);
      this.sfx = new SfxPlayer(this.sfxChip);
      this.songs = {};
      this.musicGain = 0.8;
      this.sfxGain = 0.8;
      this.frameLength = sampleRate / 50;
      this.countdown = 0;
      this.music.onEnd = () => this.port.postMessage({ type: 'songEnd' });
      this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(m) {
      switch (m.type) {
        case 'songs': this.songs = m.songs; break;
        case 'sfxDefs': this.sfx.defs = m.defs; break;
        case 'play': {
          const song = this.songs[m.name];
          if (song) this.music.play(song);
          break;
        }
        case 'stop': this.music.stop(); break;
        case 'pause': this.music.setPaused(m.paused); break;
        case 'sfx': this.sfx.play(m.name); break;
        case 'gain':
          this.musicGain = m.music;
          this.sfxGain = m.sfx;
          break;
        case 'model':
          this.musicChip.setModel(m.model);
          this.sfxChip.setModel(m.model);
          break;
        default: break;
      }
    }

    process(_inputs, outputs) {
      const out = outputs[0];
      const left = out[0];
      const n = left.length;
      for (let i = 0; i < n; i++) {
        if (--this.countdown <= 0) {
          this.countdown += this.frameLength;
          this.music.tick();
          this.sfx.tick();
        }
        left[i] = this.musicChip.render() * this.musicGain + this.sfxChip.render() * this.sfxGain;
      }
      for (let c = 1; c < out.length; c++) out[c].set(left);
      return true;
    }
  }

  registerProcessor('sidicio', SidicioProcessor);
}
