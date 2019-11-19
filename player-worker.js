/* -*- mode: javascript; tab-width: 2; indent-tabs-mode: nil; -*-
*
* Copyright (c) 2011-2013 Marcus Geelnard
*
* This file is part of SoundBox.
*
* SoundBox is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* (at your option) any later version.
*
* SoundBox is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with SoundBox.  If not, see <http://www.gnu.org/licenses/>.
*
*/

"use strict";

var CPlayerWorker = function() {

  //----------------------------------------------------------------------------
  // Private methods
  //----------------------------------------------------------------------------

  // Oscillators
  var osc_sin = function (value) {
    return Math.sin(value * 6.283184);
  };

  var osc_saw = function (value) {
    return 2 * (value % 1) - 1;
  };

  var osc_square = function (value) {
    return (value % 1) < 0.5 ? 1 : -1;
  };

  var osc_tri = function (value) {
    var v2 = (value % 1) * 4;
    if(v2 < 2) return v2 - 1;
    return 3 - v2;
  };

  var getnotefreq = function (n) {
    // 174.61.. / 44100 = 0.003959503758 (F)
    return 0.003959503758 * Math.pow(2, (n-128)/12);
  };

  var createNote = function (instr, n, rowLen) {
    var osc1 = mOscillators[instr.i[0]],
        o1vol = instr.i[1],
        o1xenv = instr.i[3]/32,
        osc2 = mOscillators[instr.i[4]],
        o2vol = instr.i[5],
        o2xenv = instr.i[8]/32,
        noiseVol = instr.i[9],
        attack = instr.i[10] * instr.i[10] * 4,
        sustain = instr.i[11] * instr.i[11] * 4,
        release = instr.i[12] * instr.i[12] * 4,
        releaseInv = 1 / release,
        arp = instr.i[13],
        arpInterval = rowLen * Math.pow(2, 2 - instr.i[14]);

    var noteBuf = new Int32Array(attack + sustain + release);

    // Re-trig oscillators
    var c1 = 0, c2 = 0;

    // Local variables.
    var j, j2, e, t, rsample, o1t, o2t;

    // Generate one note (attack + sustain + release)
    for (j = 0, j2 = 0; j < attack + sustain + release; j++, j2++) {
      if (j2 >= 0) {
        // Switch arpeggio note.
        arp = (arp >> 8) | ((arp & 255) << 4);
        j2 -= arpInterval;

        // Calculate note frequencies for the oscillators
        o1t = getnotefreq(n + (arp & 15) + instr.i[2] - 128);
        o2t = getnotefreq(n + (arp & 15) + instr.i[6] - 128) * (1 + 0.0008 * instr.i[7]);
      }

      // Envelope
      e = 1;
      if (j < attack) {
        e = j / attack;
      } else if (j >= attack + sustain) {
        e -= (j - attack - sustain) * releaseInv;
      }

      // Oscillator 1
      c1 += o1t * Math.pow(e,o1xenv);
      rsample = osc1(c1) * o1vol;

      // Oscillator 2
      c2 += o2t * Math.pow(e,o2xenv);
      rsample += osc2(c2) * o2vol;

      // Noise oscillator
      if (noiseVol) {
        rsample += (2 * Math.random() - 1) * noiseVol;
      }

      // Add to (mono) channel buffer
      noteBuf[j] = (80 * rsample * e) | 0;
    }

    return noteBuf;
  };


  //--------------------------------------------------------------------------
  // Private members
  //--------------------------------------------------------------------------

  // Array of oscillator functions
  var mOscillators = [
    osc_sin,
    osc_square,
    osc_saw,
    osc_tri
  ];


  //----------------------------------------------------------------------------
  // Public methods
  //----------------------------------------------------------------------------

  // Initialize buffers etc.
  this.init = function (song, opts) {
    // Handle optional arguments
    this.firstRow = 0;
    this.lastRow = song.endPattern;
    this.firstCol = 0;
    this.lastCol = song.numChannels - 1;
    if (opts) {
      this.firstRow = opts.firstRow;
      this.lastRow = opts.lastRow;
      this.firstCol = opts.firstCol;
      this.lastCol = opts.lastCol;
    }

    // Prepare song info
    this.song = song;
    this.numSamples = song.rowLen * song.patternLen * (this.lastRow - this.firstRow + 1);
    this.numWords = this.numSamples * 2;

    // Create work buffers (initially cleared)
    this.mixBufWork = new Int32Array(this.numWords);
  };

  // Generate audio data for a single track
  this.generate = function () {
    // Local variables
    var i, j, b, p, row, col, currentCol, n, cp,
        k, t, lfor, e, x, rsample, rowStartSample, f, da;

    for (currentCol = this.firstCol; currentCol <= this.lastCol; currentCol++) {
      // Put performance critical items in local variables
      var chnBuf = new Int32Array(this.numWords),
          mixBuf = this.mixBufWork,
          waveSamples = this.numSamples,
          waveWords = this.numWords,
          instr = this.song.songData[currentCol],
          rowLen = this.song.rowLen,
          patternLen = this.song.patternLen;

      // Clear effect state
      var low = 0, band = 0, high;
      var lsample, filterActive = false;

      // Clear note cache.
      var noteCache = [];

      // Patterns
      for (p = this.firstRow; p <= this.lastRow; ++p) {
        cp = instr.p[p];

        // Pattern rows
        for (row = 0; row < patternLen; ++row) {
            // Execute effect command.
            var cmdNo = cp ? instr.c[cp - 1].f[row] : 0;
            if (cmdNo) {
              instr.i[cmdNo - 1] = instr.c[cp - 1].f[row + patternLen] || 0;

              // Clear the note cache since the instrument has changed.
              if (cmdNo < 16) {
                noteCache = [];
              }
            }

            // Put performance critical instrument properties in local variables
            var oscLFO = mOscillators[instr.i[15]],
                lfoAmt = instr.i[16] / 512,
                lfoFreq = Math.pow(2, instr.i[17] - 9) / rowLen,
                fxLFO = instr.i[18],
                fxFilter = instr.i[19],
                fxFreq = instr.i[20] * 43.23529 * 3.141592 / 44100,
                q = 1 - instr.i[21] / 255,
                dist = instr.i[22] * 1e-5,
                drive = instr.i[23] / 32,
                panAmt = instr.i[24] / 512,
                panFreq = 6.283184 * Math.pow(2, instr.i[25] - 9) / rowLen,
                dlyAmt = instr.i[26] / 255,
                dly = instr.i[27] * rowLen & ~1;  // Must be an even number

            // Calculate start sample number for this row in the pattern
            rowStartSample = ((p - this.firstRow) * patternLen + row) * rowLen;

            // Generate notes for this pattern row
            for (col = 0; col < 4; ++col) {
              n = cp ? instr.c[cp - 1].n[row + col * patternLen] : 0;
              if (n) {
                if (!noteCache[n]) {
                  noteCache[n] = createNote(instr, n, rowLen);
                }

                // Copy note from the note cache
                var noteBuf = noteCache[n];
                for (j = 0, i = rowStartSample * 2; j < noteBuf.length; j++, i += 2) {
                  chnBuf[i] += noteBuf[j];
                }
              }
            }

            // Perform effects for this pattern row
            for (j = 0; j < rowLen; j++) {
              // Dry mono-sample
              k = (rowStartSample + j) * 2;
              rsample = chnBuf[k];

              // We only do effects if we have some sound input
              if (rsample || filterActive) {
                // State variable filter
                f = fxFreq;
                if (fxLFO) {
                  f *= oscLFO(lfoFreq * k) * lfoAmt + 0.5;
                }
                f = 1.5 * Math.sin(f);
                low += f * band;
                high = q * (rsample - band) - low;
                band += f * high;
                rsample = fxFilter == 3 ? band : fxFilter == 1 ? high : low;

                // Distortion
                if (dist) {
                  rsample *= dist;
                  rsample = rsample < 1 ? rsample > -1 ? osc_sin(rsample*.25) : -1 : 1;
                  rsample /= dist;
                }

                // Drive
                rsample *= drive;

                // Is the filter active (i.e. still audiable)?
                filterActive = rsample * rsample > 1e-5;

                // Panning
                t = Math.sin(panFreq * k) * panAmt + 0.5;
                lsample = rsample * (1 - t);
                rsample *= t;
              } else {
                lsample = 0;
              }

              // Delay is always done, since it does not need sound input
              if (k >= dly) {
                // Left channel = left + right[-p] * t
                lsample += chnBuf[k-dly+1] * dlyAmt;

                // Right channel = right + left[-p] * t
                rsample += chnBuf[k-dly] * dlyAmt;
              }

              // Store in stereo channel buffer (needed for the delay effect)
              chnBuf[k] = lsample | 0;
              chnBuf[k+1] = rsample | 0;

              // ...and add to stereo mix buffer
              mixBuf[k] += lsample | 0;
              mixBuf[k+1] += rsample | 0;
            }
        }

        // Post progress to the main thread...
        var progress = (currentCol - this.firstCol + (p - this.firstRow) /
                        (this.lastRow - this.firstRow + 1)) /
                       (this.lastCol - this.firstCol + 1);
        postMessage({
          cmd: "progress",
          progress: progress,
          buffer: null
        });
      }
    }
  };

  // Get the final buffer (as generated by the generate() method).
  this.getBuf = function () {
    // We no longer need the channel working buffer
    this.chnBufWork = null;

    return this.mixBufWork;
  };
};

var gPlayerWorker = new CPlayerWorker();

onmessage = function (event) {
  if (event.data.cmd === "generate") {
    // Generate the sound data.
    gPlayerWorker.init(event.data.song, event.data.opts);
    gPlayerWorker.generate();

    // Signal that we are done, and send the resulting buffer over to the main
    // thread.
    postMessage({
      cmd: "progress",
      progress: 1,
      buffer: gPlayerWorker.getBuf()
    });
  }
};

