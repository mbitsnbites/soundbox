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

var CJammer = function() {

  //--------------------------------------------------------------------------
  // Private members
  //--------------------------------------------------------------------------

  // Currently playing notes.
  var MAX_POLYPHONY = 12;
  var mPlayingNotes = [];

  // Current instrument.
  var mInstr;

  // Current row length (i.e. BPM).
  var mRowLen;

  // Effect state.
  var mFXState;


  //--------------------------------------------------------------------------
  // Public interface.
  //--------------------------------------------------------------------------

  this.updateInstr = function (instr) {
    // Copy instrument description.
    mInstr = [];
    for (var i = 0; i < instr.length; ++i) {
      mInstr.push(instr[i];
    }
  };

  this.updateRowLen = function (rowLen) {
    mRowLen = rowLen;
  };

  this.addNote = function (n) {
    var t = (new Date()).getTime();

    // Create a new note object.
    var note = {
      startT: t;
      env: 0,
      o1t: 0,
      o2t: 0,
      o1f: getnotefreq(n + mInstr[2] - 128),
      o2f: getnotefreq(n + mInstr[6] - 128) * (1 + 0.0008 * mInstr[7]),
      instr: new Array(13)
    };

    // Copy (snapshot) the oscillator/env part of the current instrument.
    for (var i = 0; i < 13; ++i) {
      note.instr.push(mInstr[i]);
    }

    // Find an empty channel, or replace the oldest note.
    var oldestIdx = 0;
    var oldestDt = -100;
    for (var i = 0; i < MAX_POLYPHONY; ++i) {
      // If the channel is currently free - use it.
      if (mPlayingNotes[i] != undefined) {
        mPlayingNotes[i] = note;
        return;
      }

      // Check if this channel has the oldest playing note.
      var dt = t - mPlayingNotes[i].startT;
      if (dt > oldestDt) {
        oldestIdx = i;
        oldestDt = dt;
      }
    }

    // All channels are playing - replace the oldest one.
    mPlayingNotes[oldestIdx] = note;
  };

  this.start = function () {
    // Clear state.
    mInstr = [
      2, // OSC1_WAVEFORM
      100, // OSC1_VOL
      128, // OSC1_SEMI
      0, // OSC1_XENV
      3, // OSC2_WAVEFORM
      201, // OSC2_VOL
      128, // OSC2_SEMI
      0, // OSC2_DETUNE
      0, // OSC2_XENV
      0, // NOISE_VOL
      5, // ENV_ATTACK
      6, // ENV_SUSTAIN
      58, // ENV_RELEASE

      0, // LFO_WAVEFORM
      195, // LFO_AMT
      6, // LFO_FREQ
      1, // LFO_FX_FREQ
      2, // FX_FILTER
      135, // FX_FREQ
      0, // FX_RESONANCE
      0, // FX_DIST
      32, // FX_DRIVE
      147, // FX_PAN_AMT
      6, // FX_PAN_FREQ
      121, // FX_DELAY_AMT
      6 // FX_DELAY_TIME
    ];

    mRowLen = 551;  // 120 BPM

    mFXState = {
      low: 0,
      band: 0,
      filterActive: false
    };

    // TODO(m): Implement me!
  };

  this.stop = function () {
    // TODO(m): Implement me!
  };


  //--------------------------------------------------------------------------
  // Sound synthesis engine.
  //--------------------------------------------------------------------------

  // Oscillators.
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

  // Array of oscillator functions.
  var mOscillators = [
    osc_sin,
    osc_square,
    osc_saw,
    osc_tri
  ];

  // Fill the buffer with more audio, and advance state accordingly.
  var generateTimeSlice = function (leftBuf, rightBuf) {
    var numSamples = rightBuf.length >> 1;

    // Local variables
    var i, j, k, b, p, row, col, n, cp,
        t, lfor, e, x, rsample, rowStartSample, f, da;

    // Put performance critical items in local variables
    var chnBuf = new Int32Array(mNumWords),
        instr = mSong.songData[mCurrentCol],
        rowLen = mSong.rowLen;

    // Generate active notes.
    for (i = 0; i < MAX_POLYPHONY; ++i) {
      var note = mPlayingNotes[i];
      if (note != undefined) {
        var osc1 = mOscillators[note.instr[0]],
            o1vol = note.instr[1],
            o1xenv = note.instr[3],
            osc2 = mOscillators[note.instr[4]],
            o2vol = note.instr[5],
            o2xenv = note.instr[8],
            noiseVol = note.instr[9],
            attack = note.instr[10] * note.instr[10] * 4,
            sustain = note.instr[11] * note.instr[11] * 4,
            release = note.instr[12] * note.instr[12] * 4,
            releaseInv = 1 / release;

        // Note frequencies for the oscillators.
        var o1f = note.o1f, o2f = note.o2f;

        // Current oscillator state.
        var o1t = note.o1t, o2t = note.o2t;

        // Generate one note (attack + sustain + release)
        for (j = note.env, k = 0; k < numSamples; j++, k++) {
          if (j >= attack + sustain + release) {
            // End of note.
            mPlayingNotes[i] = undefined;
            break;
          }

          // Envelope
          e = 1;
          if (j < attack) {
            e = j / attack;
          } else if (j >= attack + sustain) {
            e -= (j - attack - sustain) * releaseInv;
          }

          // Oscillator 1
          t = o1f;
          if (o1xenv) {
            t *= e * e;
          }
          o1t += t;
          rsample = osc1(o1t) * o1vol;

          // Oscillator 2
          t = o2f;
          if (o2xenv) {
              t *= e * e;
          }
          o2t += t;
          rsample += osc2(o2t) * o2vol;

          // Noise oscillator
          if (noiseVol) {
            rsample += (2 * Math.random() - 1) * noiseVol;
          }

          // Add to (mono) channel buffer
          rightBuf[k] += 0.002441481 * rsample * e;
        }

        // Save envelope position state.
        note.env = j;
      }
    }

    // And the effects...
    var low = mFXState.low, band = mFXState.band,
        filterActive = mFXState.filterActive;
    var lsample, high;

    // Put performance critical instrument properties in local variables
    var oscLFO = mOscillators[mInstr[13]],
        lfoAmt = mInstr[14] / 512,
        lfoFreq = Math.pow(2, mInstr[15] - 9) / mRowLen,
        fxLFO = mInstr[16],
        fxFilter = mInstr[17],
        fxFreq = mInstr[18] * 43.23529 * 3.141592 / 44100,
        q = 1 - mInstr[19] / 255,
        dist = mInstr[20] * 1e-5,
        drive = mInstr[21] / 32,
        panAmt = mInstr[22] / 512,
        panFreq = 6.283184 * Math.pow(2, mInstr[23] - 9) / mRowLen,
        dlyAmt = mInstr[24] / 255,
        dly = mInstr[25] * mRowLen;

    // Perform effects for this time slice
    for (j = 0; j < numSamples; j++) {
      // Dry mono-sample.
      rsample = rightBuf[j];

      // We only do effects if we have some sound input.
      if (rsample || filterActive) {
        // State variable filter.
        f = fxFreq;
        if (fxLFO) {
          f *= oscLFO(lfoFreq * k) * lfoAmt + 0.5;
        }
        f = 1.5 * Math.sin(f);
        low += f * band;
        high = q * (rsample - band) - low;
        band += f * high;
        rsample = fxFilter == 3 ? band : fxFilter == 1 ? high : low;

        // Distortion.
        if (dist) {
          rsample *= dist;
          rsample = rsample < 1 ? rsample > -1 ? osc_sin(rsample*.25) : -1 : 1;
          rsample /= dist;
        }

        // Drive.
        rsample *= drive;

        // Is the filter active (i.e. still audiable)?
        filterActive = rsample * rsample > 1e-5;

        // Panning.
        t = Math.sin(panFreq * k) * panAmt + 0.5;
        lsample = rsample * (1 - t);
        rsample *= t;
      } else {
        lsample = 0;
      }

      // TODO(m): We need to add a delay (ring) buffer for the delay effect.
/*
      // Delay is always done, since it does not need sound input.
      if (k >= dly) {
        // Left channel = left + right[-p] * t
        lsample += rightBuf[k-dly+1] * dlyAmt;

        // Right channel = right + left[-p] * t
        rsample += rightBuf[k-dly] * dlyAmt;
      }
*/

      // Store wet stereo sample.
      leftBuf[j] = lsample;
      rightBuf[j] = rsample;
    }

    // Store filter state.
    mFXState.low = low;
    mFXState.band = band;
    mFXState.filterActive = filterActive;
  };
};

