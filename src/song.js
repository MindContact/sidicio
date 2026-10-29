// Songs written the way a tracker musician would: one string of rows per
// voice, compiled to the numeric rows MusicPlayer reads.
//
// Row tokens (whitespace-separated, one per row; a row is one `speed` frames
// at 50 Hz):
//   C4 D#5 ...   note (C4 = MIDI 60), played with the voice's current
//                instrument; `C4@lead` plays one note with another instrument
//   C4~          slide into the note without re-striking it (needs `glide`)
//   .            hold
//   -            release (gate off)
//   @name        switch the current instrument (takes no row)
//   K S ...      drum shortcuts, if the caller maps them to instruments
//
// A song: { speed, sections: [{ v: [voice1, voice2, voice3] }], loop, filter? }
// where `loop` is the section index to loop back to, or -1 for a jingle that
// plays once.

import { HOLD, OFF } from './music.js';

const NOTE_RE = /^([A-G])(#?)(-?\d)(~?)(?:@(\w+))?$/;
const SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function parseVoice(text, instruments, drums, instIndex, songName) {
  const cells = [];
  let current = null;
  for (const tok of text.trim().split(/\s+/)) {
    if (tok === '') continue;
    if (tok === '.') { cells.push(HOLD); continue; }
    if (tok === '-') { cells.push(OFF); continue; }
    if (tok.startsWith('@')) {
      current = tok.slice(1);
      if (!(current in instruments)) throw new Error(`${songName}: unknown instrument ${tok}`);
      continue;
    }
    if (drums[tok]) {
      cells.push(60 | (instIndex(drums[tok]) << 7));
      continue;
    }
    const m = NOTE_RE.exec(tok);
    if (!m) throw new Error(`${songName}: bad token "${tok}"`);
    const note = (+m[3] + 1) * 12 + SEMITONE[m[1]] + (m[2] ? 1 : 0);
    const inst = m[5] || current;
    if (!inst) throw new Error(`${songName}: note ${tok} has no instrument`);
    if (!(inst in instruments)) throw new Error(`${songName}: unknown instrument ${inst}`);
    cells.push(note | (instIndex(inst) << 7) | (m[4] ? 1 << 14 : 0));
  }
  return cells;
}

// `instruments` maps names to instrument definitions (see MusicPlayer).
// Options: `drums` maps single-letter tokens to instrument names; `defaults`
// names the instrument each voice starts every section with, so a voice that
// names none still plays; `name` labels errors.
export function compileSong(song, instruments, { drums = {}, defaults = [], name = 'song' } = {}) {
  const names = [];
  const instIndex = (n) => {
    let i = names.indexOf(n);
    if (i < 0) { i = names.length; names.push(n); }
    return i;
  };
  const voices = [[], [], []];
  let loopRow = -1;
  song.sections.forEach((section, si) => {
    if (si === song.loop) loopRow = voices[0].length;
    // A voice keeps its instrument across sections only if it names it again.
    const parsed = section.v.map((text, vi) => {
      const start = defaults[vi] ? `@${defaults[vi]} ` : '';
      return parseVoice(start + text, instruments, drums, instIndex, name);
    });
    const len = Math.max(...parsed.map((p) => p.length));
    parsed.forEach((p, vi) => {
      while (p.length < len) p.push(HOLD);
      voices[vi].push(...p);
    });
  });
  return {
    speed: song.speed,
    filter: song.filter || null,
    rows: voices.map((v) => Int32Array.from(v)),
    loopRow,
    instruments: names.map((n) => instruments[n]),
  };
}
