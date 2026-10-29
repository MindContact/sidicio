# sidicio

*[English](README.md)*

Il SID, il chip sonoro del Commodore 64, emulato in JavaScript puro: tre voci,
il filtro, gli inviluppi con la loro coda esponenziale. Sopra il chip ci sono
un player per la musica e uno per gli effetti, che lavorano come una routine
di player del C64 (un passo per fotogramma PAL, 50 Hz), e un formato di testo
per scrivere i brani come li scrive un musicista da tracker.

Niente dipendenze, niente build: moduli ES che girano in un AudioWorklet nel
browser e in Node, dove si possono provare e registrare su file.

Il nome: **SID** + *s**ilicio***.

## Cosa fa

* **Il chip.** Triangolo, dente di sega, impulso con larghezza variabile,
  rumore e le loro combinazioni; ring modulation e sync rigido fra voci
  vicine; inviluppi ADSR con i tempi del datasheet e il decadimento
  esponenziale; filtro multimodo LP/BP/HP con risonanza. Due modelli, 6581 (il
  filtro sporco dei primi C64) e 8580 (pulito). Sovracampionamento 4x con
  filtro di decimazione.
* **Player della musica.** Tre voci di righe; per strumento arpeggio, vibrato,
  glide, modulazione della larghezza d'impulso, tabelle d'onda per la
  batteria, instradamento nel filtro; un filtro per tutto il brano con un LFO
  sul taglio. I brani girano in loop o suonano una volta sola (jingle).
* **Player degli effetti.** Un effetto è un programma a fotogrammi (onda,
  frequenza, larghezza d'impulso per fotogramma); tre possono sovrapporsi, un
  quarto ruba la voce più vecchia di priorità uguale o minore.
* **Doppio SID nel worklet.** Un chip suona la musica, l'altro gli effetti,
  come una cartuccia dual-SID: il brano non perde mai una voce per il suono di
  un salto.

## Avvio rapido

```bash
npm install sidicio
```

oppure, senza gestore di pacchetti, si copia la cartella `src/` (o si aggiunge
il repository come submodule git) e la si importa con un percorso relativo.

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

// Dopo un gesto dell'utente: fino ad allora i browser tengono l'audio sospeso.
const ctx = new AudioContext();
const node = await createSidicioNode(ctx);
node.connect(ctx.destination);
node.port.postMessage({ type: 'songs', songs: { theme: compileSong(song, instruments) } });
node.port.postMessage({ type: 'sfxDefs', defs: sfx });
node.port.postMessage({ type: 'play', name: 'theme' });
node.port.postMessage({ type: 'sfx', name: 'boom' });
```

La pagina in `examples/` suona quattro brani di esempio e un jingle (scritti
apposta, in `examples/demo.js`), cinque effetti, e ha due cursori separati per
il volume di musica ed effetti: `npm run demo`, poi
`http://localhost:8138/examples/`.

## Il worklet

`createSidicioNode(ctx)` carica `src/worklet.js` e restituisce un
`AudioWorkletNode` (registrato come `'sidicio'`, uscita stereo, nessun
ingresso), non collegato a nulla. Gli si parla con `node.port.postMessage`:

| Messaggio | Effetto |
|---|---|
| `{ type: 'songs', songs }` | brani compilati, per nome |
| `{ type: 'sfxDefs', defs }` | definizioni degli effetti, per nome |
| `{ type: 'play', name }` | fa partire un brano dalla prima riga |
| `{ type: 'stop' }` | ferma la musica |
| `{ type: 'pause', paused }` | mette in pausa o riprende la musica |
| `{ type: 'sfx', name }` | suona un effetto |
| `{ type: 'gain', music, sfx }` | guadagni lineari in uscita (0,8 ciascuno di partenza) |
| `{ type: 'model', model }` | `6581` o `8580`, tutti e due i chip |

Il nodo risponde `{ type: 'songEnd' }` quando finisce un brano che non va in
loop.

## I brani

Un brano è un oggetto di dati:

```js
{
  speed: 6,                 // fotogrammi (1/50 s) per riga
  sections: [{ v: [voce1, voce2, voce3] }, ...],
  loop: 0,                  // sezione a cui tornare; -1 suona una volta
  filter: { cutoff, resonance, mode, lfo: { min, max, period } },  // facoltativo
}
```

Ogni voce è una stringa di token separati da spazi, uno per riga:

| Token | Significato |
|---|---|
| `C4`, `D#5` | nota (C4 = MIDI 60) con lo strumento corrente della voce |
| `C4@lead` | una nota con un altro strumento |
| `C4~` | scivola sulla nota senza ribatterla (serve `glide`) |
| `.` | tieni |
| `-` | rilascia (gate spento) |
| `@nome` | cambia lo strumento corrente (non occupa una riga) |

`compileSong(song, instruments, options)` lo trasforma nelle righe che il
player legge, e lancia un errore su token o strumenti sconosciuti. Opzioni:

* `drums`: token di una lettera associati a strumenti, per esempio
  `{ K: 'kick', S: 'snare' }`; un colpo suona il suo strumento in C4.
* `defaults`: lo strumento con cui ogni voce comincia ogni sezione, per
  esempio `['bass', 'lead', 'arp']`. Senza, ogni voce deve nominare il suo.
* `name`: compare nei messaggi d'errore.

Le sezioni vengono allungate con delle tenute fino alla voce più lunga.

## Gli strumenti

| Campo | Significato |
|---|---|
| `wave` | `TRI`, `SAW`, `PULSE`, `NOISE`, o un OR fra loro |
| `adsr` | `[attack, decay, sustain, release]`, 0–15 come sul chip |
| `pw` | larghezza d'impulso iniziale, 0–0xfff |
| `pwSpeed`, `pwMin`, `pwMax` | variazione dell'impulso per fotogramma, avanti e indietro fra i limiti |
| `arp` | scarti in semitoni, uno per fotogramma (`arpSpeed` fotogrammi per passo) |
| `vib` | `[ritardo, profondità, velocità]`: vibrato dopo `ritardo` fotogrammi, `profondità` in semitoni |
| `glide` | fotogrammi che dura uno scivolamento `~` |
| `table` | voci `[onda, nota, assoluta]` per fotogramma, l'ultima resta; `nota` è assoluta se il terzo valore è vero, altrimenti uno scarto (batteria) |
| `filter` | manda questa voce nel filtro del brano |
| `ring`, `sync` | ring modulation / sync rigido con la voce precedente |
| `gateFrames` | spegne il gate dopo questi fotogrammi |

## Gli effetti

```js
{ prio: 1, adsr: [0, 6, 0, 0], frames: [[onda, hz, pw], ...], cutoff: [...] }
```

Una voce per fotogramma. `null` spegne il gate per quel fotogramma; un'onda in
OR con `RETRIGGER` ribatte l'inviluppo. `cutoff`, se c'è, manda la voce nel
passa-basso con un taglio (0–2047) per fotogramma. Funzioni d'aiuto:
`sweep(onda, daHz, aHz, fotogrammi, pw)` per uno scivolamento esponenziale,
`notes(onda, listaHz, fotogrammiCiascuna, pw)` per una sequenza ribattuta,
`midiToHz`.

## Il chip da solo

Tutto quello che sta sopra il chip è facoltativo. `SidChip` riceve chiamate a
livello di registro e restituisce un campione per ogni `render()`:

```js
import { SidChip, PULSE, LOW_PASS, noteToReg } from 'sidicio';

const chip = new SidChip(48000);
chip.setEnvelope(0, 0, 9, 8, 6);
chip.setWaveform(0, PULSE);
chip.setPulseWidth(0, 0x400);
chip.setFrequency(0, noteToReg(45));
chip.setFilter(900, 10, LOW_PASS, 1);   // taglio 0–2047, risonanza 0–15, modo, maschera voci
chip.setGate(0, true);
const sample = chip.render();           // in [-1, 1]
```

Ci sono anche `setRing`, `setSync`, `setVolume`, `setModel`, `setSampleRate`,
`hzToReg`. `MusicPlayer` e `SfxPlayer` ricevono un chip e vogliono `tick()` 50
volte al secondo; in Node è così che si registra su file (vedi
`test/render.mjs`).

## Sviluppo

```bash
npm test        # node:test, nessuna dipendenza
npm run demo    # serve il repository sulla porta 8138, aprire /examples/ (node tools/serve.mjs [porta])
```

Il server della demo manda `Cache-Control: no-store`: con un server statico
qualunque Chrome tiene in cache i moduli e il worklet, e un ricaricamento non
vede le modifiche.

I test comprendono l'impronta (hash) di una patch fissa suonata su tutti e due
i modelli: se cambia, è cambiata l'emulazione. Va bene se è voluto; si
aggiorna l'impronta nello stesso commit.

sidicio è un port di `native/sid_chip.cpp` di **Chip**, un'app sintetizzatore
SID per Android dello stesso autore. Una correzione all'emulazione in uno dei
due va valutata anche nell'altro.

Come funziona dentro (il chip, i player, il worklet) è in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); ricette, registrazione offline
in WAV, test e impronta in [docs/TECHNICAL.md](docs/TECHNICAL.md) (tutti e due
in inglese).

### Pubblicare una versione

1. Aggiornare `version` in `package.json` e fare commit.
2. `git tag vX.Y.Z && git push origin main vX.Y.Z`.
3. Il workflow `release` esegue i test e mette la versione in attesa su npm
   con il trusted publishing (nessun token nel repository).
4. Approvarla su npmjs.com, scheda *Staged Packages*, con la 2FA. Fino ad
   allora non è pubblica.

## Licenza

[MIT](LICENSE) © MindContact | Roberto Luttino
