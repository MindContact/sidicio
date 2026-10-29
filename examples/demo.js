// Example songs and effects for the demo page, also played by the tests.
//
// Every song is original and written for this page. They show the song
// format at work: bass, lead and an arpeggio or pad on the three voices, drums
// sharing voice 3 with the chords (as on many C64 tunes: the chord rings until
// the next hit cuts it), a filter LFO, slides, a jingle that ends.

import { TRI, SAW, PULSE, NOISE, sweep, notes, midiToHz } from '../src/index.js';

export const INSTRUMENTS = {
  bass: { wave: PULSE, adsr: [0, 8, 9, 2], pw: 0x300, pwSpeed: 20, pwMin: 0x200, pwMax: 0x900, filter: true },
  bassPluck: { wave: SAW, adsr: [0, 7, 4, 1], filter: true },
  lead: {
    wave: PULSE, adsr: [1, 9, 10, 6], pw: 0x500, pwSpeed: 12, pwMin: 0x300, pwMax: 0xb00,
    vib: [10, 0.22, 0.6], glide: 4,
  },
  leadSaw: { wave: SAW, adsr: [0, 9, 9, 5], vib: [8, 0.18, 0.7], glide: 3 },
  bell: { wave: TRI, adsr: [0, 10, 0, 10], vib: [16, 0.12, 0.5] },
  arp: { wave: PULSE, adsr: [0, 7, 7, 3], pw: 0x600, arp: [0, 3, 7] },
  arpMin: { wave: PULSE, adsr: [0, 7, 7, 3], pw: 0x600, pwSpeed: 8, pwMin: 0x400, pwMax: 0x900, arp: [0, 3, 7] },
  arpMaj: { wave: PULSE, adsr: [0, 7, 7, 3], pw: 0x600, pwSpeed: 8, pwMin: 0x400, pwMax: 0x900, arp: [0, 4, 7] },
  padMin: { wave: SAW, adsr: [6, 10, 10, 9], arp: [0, 3, 7, 12], arpSpeed: 3, filter: true },
  padMaj: { wave: SAW, adsr: [6, 10, 10, 9], arp: [0, 4, 7, 12], arpSpeed: 3, filter: true },
  kick: {
    wave: PULSE, adsr: [0, 6, 0, 0], pw: 0x800,
    table: [[NOISE, 84, 1], [PULSE, 52, 1], [PULSE, 46, 1], [PULSE, 41, 1], [PULSE, 37, 1], [PULSE, 34, 1], [TRI, 31, 1]],
  },
  snare: {
    wave: NOISE, adsr: [0, 7, 0, 0], pw: 0x800,
    table: [[NOISE, 88, 1], [PULSE, 58, 1], [NOISE, 82, 1], [NOISE, 80, 1], [NOISE, 79, 1]],
  },
  hat: { wave: NOISE, adsr: [0, 3, 0, 0], table: [[NOISE, 104, 1]] },
};

export const DRUMS = { K: 'kick', S: 'snare', H: 'hat' };

// An unnamed voice starts each section with the bass on 1, the lead on 2.
export const DEFAULTS = ['bass', 'lead', 'arpMin'];

// --- composing helpers -------------------------------------------------------
//
// Each returns one bar (16 rows) per root or chord. Chords are written "A4m"
// (minor) or "F4" (major).

const rep = (s, n) => Array(n).fill(s).join(' ');
const rest = (bars) => `- ${rep('.', bars * 16 - 1)}`;

function octaves(root) {
  const m = /^([A-G]#?)(\d)$/.exec(root);
  return [`${m[1]}${m[2]}`, `${m[1]}${+m[2] + 1}`];
}

function chord(c, minor, major) {
  return c.endsWith('m') ? `${c.slice(0, -1)}@${minor}` : `${c}@${major}`;
}

const bassEighths = (...roots) => roots.map((r) => {
  const [lo, hi] = octaves(r);
  return rep(`${lo} . ${hi} .`, 4);
}).join(' ');

const bassGallop = (...roots) => roots.map((r) => {
  const [lo, hi] = octaves(r);
  return rep(`${lo} . ${lo} ${hi}`, 4);
}).join(' ');

const bassSlow = (...roots) => roots.map((r) => {
  const [lo, hi] = octaves(r);
  return `${lo} . . . . . . . ${lo} . . . ${hi} . ${lo} .`;
}).join(' ');

const bassDrive = (...roots) => roots.map((r) => {
  const [lo, hi] = octaves(r);
  return rep(`${lo} ${lo} . ${lo} ${hi} . ${lo} .`, 2);
}).join(' ');

const drumChords = (...chords) => chords.map((c) => {
  const a = chord(c, 'arpMin', 'arpMaj');
  return `K ${a} . . S ${a} . . K ${a} K ${a} S ${a} . H`;
}).join(' ');

const drumDrive = (...chords) => chords.map((c) => {
  const a = chord(c, 'arpMin', 'arpMaj');
  return `K ${a} K . S ${a} . K K ${a} . K S ${a} S H`;
}).join(' ');

const padChords = (...chords) => chords.map((c) => `${chord(c, 'padMin', 'padMaj')} ${rep('.', 15)}`).join(' ');

// --- the songs -----------------------------------------------------------------

// A minor, 125 BPM: two bars of groove, then the tune.
const crystalCaves = {
  title: 'Crystal Caves',
  speed: 6,
  filter: { cutoff: 600, resonance: 9, mode: 1, lfo: { min: 250, max: 1100, period: 400 } },
  sections: [
    { v: [bassEighths('A2', 'A2'), rest(2), drumChords('A4m', 'A4m')] },
    {
      v: [
        bassEighths('A2', 'F2', 'C3', 'G2'),
        'A4 . . . C5 . E5 . D5 . C5 . B4 . A4 . F4 . . . A4 . C5 . A4 . . . G4 . F4 . ' +
        'E4 . G4 . C5 . . . E5 . D5 . C5 . G4 . B4 . . . D5 . . . G5 . . . F5 . D5 .',
        drumChords('A4m', 'F4', 'C4', 'G4'),
      ],
    },
    {
      v: [
        bassEighths('A2', 'F2', 'C3', 'G2'),
        'E5 . . . A5 . . . G5 . E5 . C5 . . . F5 . . . E5 . C5 . A4 . . . C5 . . . ' +
        'G5 . . . E5 . . . C5 . D5 . E5 . G5~ . D5 . . . . . . . B4 . . . - . . .',
        drumChords('A4m', 'F4', 'C4', 'G4'),
      ],
    },
  ],
  loop: 1,
};

// E minor, fast: galloping bass and a sawtooth lead.
const neonRun = {
  title: 'Neon Run',
  speed: 5,
  filter: { cutoff: 700, resonance: 11, mode: 1, lfo: { min: 300, max: 1400, period: 160 } },
  sections: [
    {
      v: [
        bassGallop('E2', 'C2', 'D2', 'E2'),
        '@leadSaw E5 . G5 . B5 . G5 . E5 . G5 . B5 . E6 . C6 . B5 . G5 . E5 . C5 . E5 . G5 . C6 . ' +
        'D6 . C6 . A5 . F#5 . D5 . F#5 . A5 . D6 . B5 . . . G5 . . . E5 . . . . . . .',
        drumChords('E4m', 'C4', 'D4', 'E4m'),
      ],
    },
    {
      v: [
        bassGallop('E2', 'C2', 'D2', 'B1'),
        '@leadSaw G5 . . . F#5 . E5 . F#5 . . . B4 . . . E5 . . . D5 . C5 . D5 . . . G4 . . . ' +
        'A4 . B4 . C5 . D5 . E5 . F#5 . G5 . A5 . B5 . . . . . . . D#5 . . . F#5 . . .',
        drumChords('E4m', 'C4', 'D4', 'B3'),
      ],
    },
  ],
  loop: 0,
};

// C major, slow: a bell over a filtered pad. Best on the 8580.
const starlight = {
  title: 'Starlight',
  speed: 8,
  filter: { cutoff: 500, resonance: 8, mode: 1, lfo: { min: 300, max: 1200, period: 800 } },
  sections: [
    {
      v: [
        bassSlow('C3', 'A2', 'F2', 'G2'),
        '@bell E5 . . . G5 . . . C6 . . . B5 . . . A5 . . . . . . . E5 . . . C5 . . . ' +
        'F5 . . . A5 . . . C6 . . . A5 . . . G5 . . . . . . . . . . . D5 . . .',
        padChords('C4', 'A3m', 'F3', 'G3'),
      ],
    },
    {
      v: [
        bassSlow('C3', 'A2', 'F2', 'G2'),
        '@bell C6 . . . B5 . . . G5 . . . E5 . . . C5 . . . E5 . . . A5 . . . G5 . . . ' +
        'F5 . . . E5 . . . D5 . . . C5 . . . D5 . . . . . . . G4 . . . B4 . . .',
        padChords('C4', 'A3m', 'F3', 'G3'),
      ],
    },
  ],
  loop: 0,
};

// D minor march: driving bass, busy drums, a resonant sweep.
const ironGate = {
  title: 'Iron Gate',
  speed: 6,
  filter: { cutoff: 500, resonance: 13, mode: 1, lfo: { min: 250, max: 1600, period: 120 } },
  sections: [
    {
      v: [
        bassDrive('D2', 'A#1', 'C2', 'A1'),
        'D5 . . . D5 . F5 . A5 . . . G5 . F5 . A#4 . . . D5 . F5 . A#5 . . . A5 . F5 . ' +
        'C5 . . . E5 . G5 . C6 . . . A#5 . G5 . A5 . . . . . . . C#5 . . . E5 . . .',
        drumDrive('D4m', 'A#3', 'C4', 'A3'),
      ],
    },
    {
      v: [
        bassDrive('D2', 'A#1', 'C2', 'A1'),
        'F5 . E5 . D5 . . . A5 . . . D6 . . . C6 . A#5 . A5 . . . F5 . . . D5 . . . ' +
        'E5 . F5 . G5 . . . C6 . . . E5 . . . C#5 . D5 . E5 . F5 . G5 . A5 . A#5 . C#6 .',
        drumDrive('D4m', 'A#3', 'C4', 'A3'),
      ],
    },
  ],
  loop: 0,
};

// A jingle: plays once, then the worklet posts 'songEnd'.
const fanfare = {
  title: 'Fanfare (jingle)',
  speed: 5,
  sections: [
    {
      v: [
        '@bassPluck C3 . . . C3 . . . G2 . . . C3 . . .',
        'C5 . E5 . G5 . C6 . . . . . . . . .',
        '@arpMaj C4 . . . . . . . . . . . . . . .',
      ],
    },
    { v: [rest(1), rest(1), rest(1)] },
  ],
  loop: -1,
};

// The smallest song the format allows, used by the tests: one bar, every voice
// naming its instrument.
export const DEMO = {
  speed: 6,
  filter: { cutoff: 600, resonance: 9, mode: 1, lfo: { min: 250, max: 1100, period: 200 } },
  sections: [
    {
      v: [
        '@bass A2 . A3 . A2 . A3 . F2 . F3 . G2 . G3 .',
        '@lead A4 . . . C5 . E5 . D5 . . C5~ . . B4 .',
        '@arp K A4 . . S A4 . . K F4 . . S G4 . K',
      ],
    },
  ],
  loop: 0,
};

export const SONGS = { crystalCaves, neonRun, starlight, ironGate, fanfare };

// --- effects ---------------------------------------------------------------------

export const SFX = {
  jump: { prio: 1, adsr: [0, 6, 0, 0], frames: sweep(PULSE, 190, 620, 9, 0x300) },
  coin: { prio: 1, adsr: [0, 8, 0, 6], frames: notes(PULSE, [midiToHz(84), midiToHz(91)], 3, 0x400) },
  zap: { prio: 2, adsr: [0, 9, 0, 6], frames: sweep(SAW, 1800, 120, 20), cutoff: Array.from({ length: 20 }, (_, i) => 1800 - i * 60) },
  boom: { prio: 3, adsr: [0, 10, 0, 8], frames: sweep(NOISE, 900, 110, 24), cutoff: Array.from({ length: 24 }, (_, i) => 900 - i * 30) },
  powerUp: { prio: 2, adsr: [0, 8, 6, 6], frames: notes(PULSE, [72, 76, 79, 84, 88, 91, 96].map(midiToHz), 3, 0x600) },
};
