/* -*- mode: javascript; tab-width: 2; indent-tabs-mode: nil; -*-
*
* Copyright (c) 2011-2014 Marcus Geelnard
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

//------------------------------------------------------------------------------
// External dependencies
//------------------------------------------------------------------------------

include("demo-songs.js");
include("presets.js");
include("player.js");
include("jammer.js");
include("rle.js");

include("third_party/deflate.js");
include("third_party/inflate.js");
include("third_party/Blob.js");
include("third_party/FileSaver.js");
include("third_party/WebMIDIAPI.js");

"use strict";


//------------------------------------------------------------------------------
// Local classes for easy access to binary data
//------------------------------------------------------------------------------

var CBinParser = function (d) {
  var mData = d;
  var mPos = 0;

  this.getUBYTE = function () {
    return mData.charCodeAt(mPos++) & 255;
  };

  this.getUSHORT = function () {
    var l = (mData.charCodeAt(mPos) & 255) |
            ((mData.charCodeAt(mPos + 1) & 255) << 8);
    mPos += 2;
    return l;
  };

  this.getULONG = function () {
    var l = (mData.charCodeAt(mPos) & 255) |
            ((mData.charCodeAt(mPos + 1) & 255) << 8) |
            ((mData.charCodeAt(mPos + 2) & 255) << 16) |
            ((mData.charCodeAt(mPos + 3) & 255) << 24);
    mPos += 4;
    return l;
  };

  this.getFLOAT = function () {
    var l = this.getULONG();
    if (l == 0) return 0;
    var s = l & 0x80000000;                       // Sign
    var e = (l >> 23) & 255;                      // Exponent
    var m = 1 + ((l & 0x007fffff) / 0x00800000);  // Mantissa
    var x = m * Math.pow(2, e - 127);
    return s ? -x : x;
  };

  this.getTail = function () {
    var str = mData.slice(mPos);
    mPos = mData.length;
    return str;
  };
};

var CBinWriter = function () {
  var mData = "";

  this.putUBYTE = function (x) {
    mData += String.fromCharCode(x);
  };

  this.putUSHORT = function (x) {
    mData += String.fromCharCode(
               x & 255,
               (x >> 8) & 255
             );
  };

  this.putULONG = function (x) {
    mData += String.fromCharCode(
               x & 255,
               (x >> 8) & 255,
               (x >> 16) & 255,
               (x >> 24) & 255
             );
  };

  this.putFLOAT = function (x) {
    var l = 0;
    if (x != 0)
    {
      var s = 0;
      if (x < 0) s = 0x80000000, x = -x;
      var e = 127 + 23;
      while (x < 0x00800000)
      {
        x *= 2;
        e--;
      }
      while (x >= 0x01000000)
      {
        x /= 2;
        e++;
      }
      l = s | ((e & 255) << 23) | (x & 0x007fffff);
    }
    this.putULONG(l);
  };

  this.append = function (x) {
    mData += x;
  };

  this.getData = function () {
    return mData;
  };
};


//------------------------------------------------------------------------------
// Helper class for getting high precision timing info from an audio element
// (e.g. Firefox Audio.currentTime has < 60 Hz precision, leading to choppy
// animations etc).
//------------------------------------------------------------------------------

var CAudioTimer = function () {
  var mAudioElement = null;
  var mStartT = 0;
  var mErrHist = [0, 0, 0, 0, 0, 0];
  var mErrHistPos = 0;

  this.setAudioElement = function (audioElement) {
    mAudioElement = audioElement;
  }

  this.currentTime = function () {
    if (!mAudioElement)
      return 0;

    // Calculate current time according to Date()
    var t = (new Date()).getTime() * 0.001;
    var currentTime = t - mStartT;

    // Get current time according to the audio element
    var audioCurrentTime = mAudioElement.currentTime;

    // Check if we are off by too much - in which case we will use the time
    // from the audio element
    var err = audioCurrentTime - currentTime;
    if (audioCurrentTime < 0.01 || err > 0.2 || err < -0.2) {
      currentTime = audioCurrentTime;
      mStartT = t - currentTime;
      for (var i = 0; i < mErrHist.length; i++)
        mErrHist[i] = 0;
    }

    // Error compensation (this should fix the problem when we're constantly
    // slightly off)
    var comp = 0;
    for (var i = 0; i < mErrHist.length; i++)
      comp += mErrHist[i];
    comp /= mErrHist.length;
    mErrHist[mErrHistPos] = err;
    mErrHistPos = (mErrHistPos + 1) % mErrHist.length;

    return currentTime + comp;
  };

  this.reset = function () {
    mStartT = (new Date()).getTime() * 0.001;
    for (var i = 0; i < mErrHist.length; i++)
      mErrHist[i] = 0;
  };
};

//------------------------------------------------------------------------------
// Abstract class for tracking the editing of a table. Keeps track of the current cell
// selection. Handles also updating the cells, copying a range, and pasting
// a range.
//
// Note: it is an abstract class. To make it concrete, one should add functions:
//   get(col,row) - returns the value of a cell at col,row
//   set(col,row,value) - sets the value of a cell at col,row
//   numcols() - returns the number of cols
//   numrows() - returns the number of rows
//   toHTML(value) - converts value (as returned by get) into HTML code
//   getElementName(col,row) - returns the name of the DOM element corresponding to col/row
//   getScrollElementName(row) - returns the name of the DOM element for scrolling to row
//   scrollBar - name of the scroll bar. Note: property, not a method
//
//------------------------------------------------------------------------------

var CTableEditor = function() {
  var mCol=0,mRow=0,mCol1=0,mRow1=0,mCol2=0,mRow2=0;
  var mCopyBuffer = undefined;
  var mSuppressLevel = 0, updateRequested = false;

  var self = this;

  this.col = function() {
    return mCol;
  };

  this.row = function() {
    return mRow;
  }

  this.selectionCol1 = function() {
    return mCol1;
  };

  this.selectionRow1 = function() {
    return mRow1;
  }

  this.selectionCol2 = function() {
    return mCol2;
  };

  this.selectionRow2 = function() {
    return mRow2;
  }

  this.selectionLeft = function() {
    return mCol1 < mCol2 ? mCol1 : mCol2;
  };

  this.selectionRight = function() {
     return mCol1 > mCol2 ? mCol1 : mCol2;
  };

  this.selectionTop = function() {
    return mRow1 < mRow2 ? mRow1 : mRow2;
  };

  this.selectionBottom = function() {
    return mRow1 > mRow2 ? mRow1 : mRow2;
  };

  this.isSelected = function(col,row) {
    return col >= self.selectionLeft() && col <= self.selectionRight() && row >= self.selectionTop() && row <= self.selectionBottom();
  };

  this.modifySelection = function(mapping) {
    self.suppressUpdate();
    self.forSelection(function (col,row) {
      self.set(col,row,mapping(self.get(col,row)));
    });
    self.resumeUpdate();
  }

  this.forSelection = function(callback) {
    for (var row = self.selectionTop();row <= self.selectionBottom();++row)
      for (var col = self.selectionLeft();col <= self.selectionRight();++col)
        callback(col,row);
  };

  this.forAll = function(callback) {
    for (var row = 0;row < self.numrows();++row)
      for (var col = 0;col < self.numcols();++col)
        callback(col,row);
  };

  this.repeatSelection = function(repeatPeriod) {
    self.suppressUpdate();
    self.forSelection(function (col,row) {
      self.set(col,row,self.get(col,self.selectionTop() + (row - self.selectionTop()) % repeatPeriod));
    });
    self.resumeUpdate();
  }

  this.isSingleSelected = function() {
    return mCol1 == mCol2 && mRow1 == mRow2;
  };

  this.deselect = function()
  {
    mCol1 = mCol2 = mCol;
    mRow1 = mRow2 = mRow;
  };

  this.getCurrent = function() {
    return self.get(self.col(),self.row());
  };

  this.setCurrent = function(value) {
    self.set(self.col(),self.row(),value);
  };

  this.setCursor = function(col,row,keepSelection) {
    mCol = col;
    mRow = row;
    if (!keepSelection)
      self.deselect();
    self.update();
    self.scrollIntoView(row);
  }

  this.scrollIntoView = function(row) {
    // Scroll the row into view? (only when needed)
    var o = document.getElementById(self.getScrollElementName(row));
    if (o.scrollIntoView) {
      var so = document.getElementById(self.scrollBar);
      var oy = o.offsetTop - so.scrollTop;
      if (oy < 0 || (oy + 10) > so.offsetHeight)
        o.scrollIntoView(oy < 0);
    }
  }

  this.update = function() {
    // if updates are currently supressed, request an update as soon
    // as updates are resumed
    if (mSuppressLevel > 0) {
      updateRequested = true;
      return;
    }
    updateRequested = false;
    self.forAll(function(col,row) {
      var o = document.getElementById(self.getElementName(col,row));
      var desiredHTML = self.toHTML(self.get(col,row));
      if (o.innerHTML != desiredHTML)
        o.innerHTML = desiredHTML;
      var desiredClassName = mCol == col && mRow == row ? "cursor" :
                             self.isSelected(col,row) ? "selected" : "";
      if (o.className != desiredClassName)
        o.className = desiredClassName;
    })
  }

  this.suppressUpdate = function()
  {
    mSuppressLevel++;
  }

  this.resumeUpdate = function()
  {
    if (mSuppressLevel > 0) {
      mSuppressLevel--;
    } else {
      console.error("resumeUpdate called without matching suppressUpdate");
      console.trace();
    }
    if (mSuppressLevel <= 0 && updateRequested) {
      self.update();
    }
  }

  this.setSelectionCorner = function(col,row) {
    mCol1 = col;
    mRow1 = row;
    self.update();
    self.scrollIntoView(row);
  }

  this.setSelectionCorner2 = function(col,row) {
    mCol2 = col;
    mRow2 = row;
    self.update();
    self.scrollIntoView(row);
  }

  this.copy = function() {
    mCopyBuffer = [];
    for (var row = self.selectionTop(); row <= self.selectionBottom(); ++row) {
      var arr = [];
      for (var col = self.selectionLeft(); col <= self.selectionRight(); ++col) {
        arr.push(self.get(col,row));
      }
      mCopyBuffer.push(arr);
    }
  };

  this.paste = function() {
    if (!mCopyBuffer)
      return;
    self.suppressUpdate();
    for (var row = self.row(), i = 0; row < self.numrows() && i < mCopyBuffer.length; ++row, ++i)
      for (var col = self.col(), j = 0; col < self.numcols() && j < mCopyBuffer[i].length; ++col, ++j)
        self.set(col,row,mCopyBuffer[i][j]);
    self.resumeUpdate();
  }
};

//------------------------------------------------------------------------------
// Helper functions
//------------------------------------------------------------------------------

var makeFourCC = function (fourChars) {
  return (fourChars.charCodeAt(3) << 24) | (fourChars.charCodeAt(2) << 16) |
         (fourChars.charCodeAt(1) << 8) | fourChars.charCodeAt(0);
};

var preventDefault = function (innerFunction) {
  return function (e) {
    if (!e) var e = window.event;
    e.preventDefault();
    innerFunction(e);
  };
};

//------------------------------------------------------------------------------
// GUI class
//------------------------------------------------------------------------------

var CGUI = function()
{
  // Edit modes
  var EDIT_NONE = 0,
      EDIT_SEQUENCE = 1,
      EDIT_PATTERN = 2,
      EDIT_FXTRACK = 3;

  // Misc constants
  var MAX_SONG_ROWS = 500,
      MAX_PATTERNS = 36,
      MAX_CHANNELS = 16;

  // Edit/gui state
  var mEditMode = EDIT_PATTERN,
      mKeyboardOctave = 4,
      mPattern = new CTableEditor(),
      mSeq = new CTableEditor(),
      mFxTrack = new CTableEditor(),
      mSelectingSeqRange = false,
      mSelectingPatternRange = false,
      mSelectingFxRange = false,
      mSeqCopyBuffer = [],
      mPatCopyBuffer = [],
      mFxCopyBuffer = [],
      mInstrCopyBuffer = [];

  // Parsed URL data
  var mBaseURL;
  var mGETParams;

  // Resources
  var mSong = {};
  var mSongUnmodified = {};
  var mAudio = undefined;
  var mAudioTimer = new CAudioTimer();
  var mAudioContext = undefined;
  var mAudioSourceNode = undefined;
  var mAudioSourceStartTime = 0.0;
  var mPlaybackUnlocked = false;
  var mPlayer = new CPlayer();
  var mPlayGfxVUImg = new Image();
  var mPlayGfxLedOffImg = new Image();
  var mPlayGfxLedOnImg = new Image();
  var mJammer = new CJammer();
  var mDisplaySizeTimer = undefined;

  // Constant look-up-tables
  var mNoteNames = [
    'C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'
  ];

  var mBlackKeyPos = [
    26, 1, 63, 3, 116, 6, 150, 8, 184, 10, 238, 13, 274, 15, 327, 18, 362, 20, 394, 22
  ];

  // Prealoaded resources
  var mPreload = [];

  //--------------------------------------------------------------------------
  // Binding mSeq, mPattern and mFxTrack
  //--------------------------------------------------------------------------

  mSeq.get = function(col,row) {
    return mSong.songData[col].p[row];
  };

  mSeq.set = function(col,row,value) {
    mSong.songData[col].p[row] = value;
    mSeq.update();
  };

  var baseUpdate = mSeq.update;
  var patternNumCache = undefined;
  var channelNumCache = undefined;

  mSeq.update = function() {
    baseUpdate();
    var channelChanged = false;
    if (channelNumCache != mSeq.col()) {
      channelNumCache = mSeq.col();
      updateInstrument();
      channelChanged = true;
    }
    if (patternNumCache != mSeq.getCurrent() || channelChanged)
    {
      patternNumCache = mSeq.getCurrent();
      mPattern.update();
      mFxTrack.update();
    }
  }

  mSeq.numcols = function() { return MAX_CHANNELS; };

  mSeq.numrows = function() { return MAX_SONG_ROWS; }

  mSeq.toHTML = function(value) {
    if (value > 0)
      return "" + (value <= 10 ? value - 1 : String.fromCharCode(64 + value - 10));
    else
      return "&nbsp;";
  };

  mSeq.getElementName = function(col,row) {
    return "sc" + col + "r" + row;
  };

  mSeq.getScrollElementName = function(row) {
    return "spr" + row;
  };

  mSeq.scrollBar = "sequencer";

  mPattern.get = function(col,row) {
    var pat = mSeq.getCurrent()-1;
    if (pat >= 0)
      return mSong.songData[mSeq.col()].c[pat].n[row+col*mSong.patternLen]
    else
      return 0;
  };

  mPattern.set = function(col,row,value) {
    var pat = mSeq.getCurrent()-1;
    if (pat >= 0)
      mSong.songData[mSeq.col()].c[pat].n[row+col*mSong.patternLen] = value;
    mPattern.update();
  };

  mPattern.numcols = function() { return 4; };

  mPattern.numrows = function() { return mSong.patternLen; }

  mPattern.toHTML = function(value) {
    var n = value - 87;
    if (n > 0)
      return mNoteNames[n % 12] + Math.floor(n / 12);
    else
      return "&nbsp;";
  };

  mPattern.getElementName = function(col,row) {
    return "pc" + col + "r" + row;
  };

  mPattern.getScrollElementName = function(row) {
    return "pc0r" + row;
  };

  mPattern.scrollBar = "pattern";

  mFxTrack.get = function(col,row) {
    var pat = mSeq.getCurrent()-1;
    if (pat >= 0) {
      var fxCmd = mSong.songData[mSeq.col()].c[pat].f[row];
      if (fxCmd) {
        var fxVal = mSong.songData[mSeq.col()].c[pat].f[row+mSong.patternLen];
        return [fxCmd,fxVal];
      }
    }
    return [0,0];
  };

  mFxTrack.set = function(col,row,value) {
    var pat = mSeq.getCurrent()-1;
    if (pat >= 0) {
      mSong.songData[mSeq.col()].c[pat].f[row] = value[0];
      mSong.songData[mSeq.col()].c[pat].f[row+mSong.patternLen] = value[1];
      mFxTrack.update();
    }
  };

  mFxTrack.numcols = function() { return 1; };

  mFxTrack.numrows = function() { return mSong.patternLen; }

  mFxTrack.toHTML = function(value) {
    return value[0] ? toHex(value[0],2) + ":" + toHex(value[1],2) : ":";
  };

  mFxTrack.getElementName = function(col,row) {
    return "fxr" + row;
  };

  mFxTrack.getScrollElementName = function(row) {
    return "fxr" + row;
  };

  mFxTrack.scrollBar = "fxtrack";

  var mOldFxTrackUpdate = mFxTrack.update;
  mFxTrack.update = function() {
    mOldFxTrackUpdate();
    updateInstrument();
  };

  //--------------------------------------------------------------------------
  // URL parsing & generation
  //--------------------------------------------------------------------------

  var getURLBase = function (url) {
    var queryStart = url.indexOf("?");
    return url.slice(0, queryStart >= 0 ? queryStart : url.length);
  };

  var parseURLGetData = function (url) {
    var queryStart = url.indexOf("?") + 1;
    var queryEnd   = url.indexOf("#") + 1 || url.length + 1;
    var query      = url.slice(queryStart, queryEnd - 1);

    var params = {};
    if (query === url || query === "")
      return params;

    var nvPairs = query.replace(/\+/g, " ").split("&");

    for (var i=0; i<nvPairs.length; i++) {
      var nv = nvPairs[i].split("=");
      var n  = decodeURIComponent(nv[0]);
      var v  = decodeURIComponent(nv[1]);
      if ( !(n in params) ) {
        params[n] = [];
      }
      params[n].push(nv.length === 2 ? v : null);
    }
    return params;
  };

  var getURLSongData = function (dataParam) {
    var songData = undefined;
    if (dataParam) {
      var str = dataParam, str2 = "";
      if (str.indexOf("data:") == 0) {
        // This is a data: URI (e.g. data:application/x-extension-sbx;base64,....)
        var idx = str.indexOf("base64,");
        if (idx > 0)
          str2 = str.substr(idx + 7);
      } else {
        // This is GET data from an http URL
        for (var i = 0; i < str.length; ++i) {
          var chr = str[i];
          if (chr === "-") chr = "+";
          if (chr === "_") chr = "/";
          str2 += chr;
        }
      }
      try {
        songData = atob(str2);
      }
      catch (err) {
        songData = undefined;
      }
    }
    return songData;
  };

  var makeURLSongData = function (data) {
    var str = btoa(data), str2 = "";
    for (var i = 0; i < str.length; ++i) {
      var chr = str[i];
      if (chr === "+") chr = "-";
      if (chr === "/") chr = "_";
      if (chr === "=") chr = "";
      str2 += chr;
    }
    return mBaseURL + "?data=" + str2;
  };


  //--------------------------------------------------------------------------
  // Song import/export functions
  //--------------------------------------------------------------------------

  var calcSamplesPerRow = function (bpm) {
    return Math.round((60 * 44100 / 4) / bpm);
  };

  var getBPM = function () {
    return Math.round((60 * 44100 / 4) / mSong.rowLen);
  };

  // Instrument property indices
  var OSC1_WAVEFORM = 0,
      OSC1_VOL = 1,
      OSC1_SEMI = 2,
      OSC1_XENV = 3,

      OSC2_WAVEFORM = 4,
      OSC2_VOL = 5,
      OSC2_SEMI = 6,
      OSC2_DETUNE = 7,
      OSC2_XENV = 8,

      NOISE_VOL = 9,

      ENV_ATTACK = 10,
      ENV_SUSTAIN = 11,
      ENV_RELEASE = 12,
      ENV_EXP_DECAY = 13,

      ARP_CHORD = 14,
      ARP_SPEED = 15,

      LFO_WAVEFORM = 16,
      LFO_AMT = 17,
      LFO_FREQ = 18,
      LFO_FX_FREQ = 19,

      FX_FILTER = 20,
      FX_FREQ = 21,
      FX_RESONANCE = 22,
      FX_DIST = 23,
      FX_DRIVE = 24,
      FX_PAN_AMT = 25,
      FX_PAN_FREQ = 26,
      FX_DELAY_AMT = 27,
      FX_DELAY_TIME = 28;

  var makeEmptyChannel = function (patternLen) {
    instr = {};
    instr.i = [];

    // Select the default instrument from the presets
    var defaultInstr;
    for (i = 0; i < gInstrumentPresets.length; ++i) {
      if (gInstrumentPresets[i].i) {
        defaultInstr = gInstrumentPresets[i];
        break;
      }
    }

    // Copy the default instrument
    for (j = 0; j <= defaultInstr.i.length; ++j) {
      instr.i[j] = defaultInstr.i[j];
    }

    // Sequence
    instr.p = [];
    for (j = 0; j < MAX_SONG_ROWS; j++)
      instr.p[j] = 0;

    // Patterns
    instr.c = [];
    for (j = 0; j < MAX_PATTERNS; j++)
    {
      col = {};
      col.n = [];
      for (k = 0; k < patternLen * 4; k++)
        col.n[k] = 0;
      col.f = [];
      for (k = 0; k < patternLen * 2; k++)
        col.f[k] = 0;
      instr.c[j] = col;
    }

    return instr;
  };

  var makeNewSong = function () {
    var song = {}, i, j, k, instr, col;

    // Row length
    song.rowLen = calcSamplesPerRow(120);

    // Last pattern to play
    song.endPattern = 0;

    // Rows per pattern
    song.patternLen = 32;

    // Number of channels
    song.numChannels = 1;

    // All instruments
    song.songData = [];
    for (i = 0; i < MAX_CHANNELS; i++) {
      song.songData[i] = makeEmptyChannel(song.patternLen);
    }

    // Make a first empty pattern
    song.songData[0].p[0] = 1;

    return song;
  };

  var putInstrument = function(bin,instrI)
  {
    // Oscillator 1
    bin.putUBYTE(instrI[OSC1_WAVEFORM]);
    bin.putUBYTE(instrI[OSC1_VOL]);
    bin.putUBYTE(instrI[OSC1_SEMI]);
    bin.putUBYTE(instrI[OSC1_XENV]);

    // Oscillator 2
    bin.putUBYTE(instrI[OSC2_WAVEFORM]);
    bin.putUBYTE(instrI[OSC2_VOL]);
    bin.putUBYTE(instrI[OSC2_SEMI]);
    bin.putUBYTE(instrI[OSC2_DETUNE]);
    bin.putUBYTE(instrI[OSC2_XENV]);

    // Noise oscillator
    bin.putUBYTE(instrI[NOISE_VOL]);

    // Envelope
    bin.putUBYTE(instrI[ENV_ATTACK]);
    bin.putUBYTE(instrI[ENV_SUSTAIN]);
    bin.putUBYTE(instrI[ENV_RELEASE]);
    bin.putUBYTE(instrI[ENV_EXP_DECAY]);

    // Arpeggio
    bin.putUBYTE(instrI[ARP_CHORD]);
    bin.putUBYTE(instrI[ARP_SPEED]);

    // LFO
    bin.putUBYTE(instrI[LFO_WAVEFORM]);
    bin.putUBYTE(instrI[LFO_AMT]);
    bin.putUBYTE(instrI[LFO_FREQ]);
    bin.putUBYTE(instrI[LFO_FX_FREQ]);

    // Effects
    bin.putUBYTE(instrI[FX_FILTER]);
    bin.putUBYTE(instrI[FX_FREQ]);
    bin.putUBYTE(instrI[FX_RESONANCE]);
    bin.putUBYTE(instrI[FX_DIST]);
    bin.putUBYTE(instrI[FX_DRIVE]);
    bin.putUBYTE(instrI[FX_PAN_AMT]);
    bin.putUBYTE(instrI[FX_PAN_FREQ]);
    bin.putUBYTE(instrI[FX_DELAY_AMT]);
    bin.putUBYTE(instrI[FX_DELAY_TIME]);
  }

  var compress = function(unpackedData)
  {
    // Pack the song data
    // FIXME: To avoid bugs, we try different compression methods here until we
    // find something that works (this should not be necessary).
    var packedData, testData, compressionMethod = 0;
    for (i = 9; i > 0; i--) {
      packedData = RawDeflate.deflate(unpackedData, i);
      testData = RawDeflate.inflate(packedData);
      if (unpackedData === testData) {
        compressionMethod = 2;
        break;
      }
    }
    if (compressionMethod == 0) {
      packedData = rle_encode(unpackedData);
      testData = rle_decode(packedData);
      if (unpackedData === testData)
        compressionMethod = 1;
      else
        packedData = unpackedData;
    }
    // method:
    //  0: none
    //  1: RLE
    //  2: DEFLATE
    return {method:compressionMethod,data:packedData};
  }

  var uncompress = function(method,packedData)
  {
    switch (method) {
      default:
      case 0:
        return packedData;
      case 1:
        return rle_decode(packedData);
      case 2:
        return RawDeflate.inflate(packedData);
    }
  }

  var songToBin = function (song) {
    var bin = new CBinWriter();

    // Row length (i.e. song speed)
    bin.putULONG(song.rowLen);

    // Last pattern to play
    bin.putUSHORT(song.endPattern);

    // Rows per pattern
    bin.putUBYTE(song.patternLen);

    // Number of channels
    bin.putUBYTE(song.numChannels);

    // All instruments
    var i, j, k, instr, col;
    for (i = 0; i < song.numChannels; i++) {
      instr = song.songData[i];

      putInstrument(bin,instr.i);

      // Patterns
      for (j = 0; j <= song.endPattern; j++)
        bin.putUBYTE(instr.p[j]);

      // Columns
      for (j = 0; j < MAX_PATTERNS; j++) {
        col = instr.c[j];
        for (k = 0; k < song.patternLen * 4; k++)
          bin.putUBYTE(col.n[k]);
        for (k = 0; k < song.patternLen * 2; k++)
          bin.putUBYTE(col.f[k]);
      }
    }
    
    var compressedData = compress(bin.getData());

    // Create a new binary stream - this is the actual file
    bin = new CBinWriter();

    // Signature
    bin.putULONG(makeFourCC("SBox"));

    // Format version
    bin.putUBYTE(14);

    // Compression method
    bin.putUBYTE(compressedData.method);

    // Append packed data
    bin.append(compressedData.data);

    return bin.getData();
  };

  var soundboxBinToSong = function (d) {
    var bin = new CBinParser(d);
    var song = {};

    // Signature
    var signature = bin.getULONG();

    // Format version
    var version = bin.getUBYTE();

    // Check if this is a SoundBox song
    if (signature != makeFourCC("SBox") || (version < 1 || version > 14))
      return undefined;

    if (version >= 8) {
      // Get compression method
      var compressionMethod = bin.getUBYTE();

      // Unpack song data
      var packedData = bin.getTail();
      var unpackedData = uncompress(compressionMethod,packedData);
      bin = new CBinParser(unpackedData);
    }

    // Row length
    song.rowLen = bin.getULONG();

    // Last pattern to play
    if (version >= 12)
      song.endPattern = bin.getUSHORT();
    else
      song.endPattern = bin.getUBYTE() + 2;

    // Number of rows per pattern
    if (version >= 10)
      song.patternLen = bin.getUBYTE();
    else
      song.patternLen = 32;

    // Number of channels
    if (version >= 12)
      song.numChannels = bin.getUBYTE();
    else
      song.numChannels = 8;

    // All instruments
    song.songData = [];
    var i, j, k, instr, col;
    for (i = 0; i < song.numChannels; i++) {
      instr = {};
      instr.i = [];

      // Oscillator 1
      if (version < 6) {
        instr.i[OSC1_SEMI] = bin.getUBYTE();
        instr.i[OSC1_XENV] = 64 * bin.getUBYTE();
        instr.i[OSC1_VOL] = bin.getUBYTE();
        instr.i[OSC1_WAVEFORM] = bin.getUBYTE();
      }
      else {
        instr.i[OSC1_WAVEFORM] = bin.getUBYTE();
        instr.i[OSC1_VOL] = bin.getUBYTE();
        instr.i[OSC1_SEMI] = bin.getUBYTE();
        instr.i[OSC1_XENV] = version < 13 ? 64 * bin.getUBYTE() : bin.getUBYTE();
      }

      // Oscillator 2
      if (version < 6) {
        instr.i[OSC2_SEMI] = bin.getUBYTE();
        instr.i[OSC2_DETUNE] = bin.getUBYTE();
        instr.i[OSC2_XENV] = 64 * bin.getUBYTE();
        instr.i[OSC2_VOL] = bin.getUBYTE();
        instr.i[OSC2_WAVEFORM] = bin.getUBYTE();
      }
      else {
        instr.i[OSC2_WAVEFORM] = bin.getUBYTE();
        instr.i[OSC2_VOL] = bin.getUBYTE();
        instr.i[OSC2_SEMI] = bin.getUBYTE();
        instr.i[OSC2_DETUNE] = bin.getUBYTE();
        instr.i[OSC2_XENV] = version < 13 ? 64 * bin.getUBYTE() : bin.getUBYTE();
      }

      // Noise oscillator
      instr.i[NOISE_VOL] = bin.getUBYTE();

      // Envelope
      if (version < 5) {
        instr.i[ENV_ATTACK] = Math.round(Math.sqrt(bin.getULONG()) / 2);
        instr.i[ENV_SUSTAIN] = Math.round(Math.sqrt(bin.getULONG()) / 2);
        instr.i[ENV_RELEASE] = Math.round(Math.sqrt(bin.getULONG()) / 2);
      }
      else {
        instr.i[ENV_ATTACK] = bin.getUBYTE();
        instr.i[ENV_SUSTAIN] = bin.getUBYTE();
        instr.i[ENV_RELEASE] = bin.getUBYTE();
      }
      instr.i[ENV_EXP_DECAY] = version < 14 ? 0 : bin.getUBYTE();

      // Arpeggio
      if (version < 11) {
        instr.i[ARP_CHORD] = 0;
        instr.i[ARP_SPEED] = 0;
      }
      else {
        instr.i[ARP_CHORD] = bin.getUBYTE();
        instr.i[ARP_SPEED] = bin.getUBYTE();
      }

      if (version < 6) {
        // Effects
        instr.i[FX_FILTER] = bin.getUBYTE();
        if (version < 5)
          instr.i[FX_FREQ] = Math.round(bin.getUSHORT() / 43.23529);
        else
          instr.i[FX_FREQ] = bin.getUBYTE();
        instr.i[FX_RESONANCE] = bin.getUBYTE();

        instr.i[FX_DELAY_TIME] = bin.getUBYTE();
        instr.i[FX_DELAY_AMT] = bin.getUBYTE();
        instr.i[FX_PAN_FREQ] = bin.getUBYTE();
        instr.i[FX_PAN_AMT] = bin.getUBYTE();
        instr.i[FX_DIST] = bin.getUBYTE();
        instr.i[FX_DRIVE] = bin.getUBYTE();

        // LFO
        instr.i[LFO_FX_FREQ] = bin.getUBYTE();
        instr.i[LFO_FREQ] = bin.getUBYTE();
        instr.i[LFO_AMT] = bin.getUBYTE();
        instr.i[LFO_WAVEFORM] = bin.getUBYTE();
      }
      else {
        // LFO
        instr.i[LFO_WAVEFORM] = bin.getUBYTE();
        instr.i[LFO_AMT] = bin.getUBYTE();
        instr.i[LFO_FREQ] = bin.getUBYTE();
        instr.i[LFO_FX_FREQ] = bin.getUBYTE();

        // Effects
        instr.i[FX_FILTER] = bin.getUBYTE();
        instr.i[FX_FREQ] = bin.getUBYTE();
        instr.i[FX_RESONANCE] = bin.getUBYTE();
        instr.i[FX_DIST] = bin.getUBYTE();
        instr.i[FX_DRIVE] = bin.getUBYTE();
        instr.i[FX_PAN_AMT] = bin.getUBYTE();
        instr.i[FX_PAN_FREQ] = bin.getUBYTE();
        instr.i[FX_DELAY_AMT] = bin.getUBYTE();
        instr.i[FX_DELAY_TIME] = bin.getUBYTE();
      }

      // Patterns
      var song_rows;
      if (version < 9)
        song_rows = 48;
      else if (version < 12)
        song_rows = 128;
      else
        song_rows = song.endPattern + 1;
      instr.p = [];
      for (j = 0; j < song_rows; j++)
        instr.p[j] = bin.getUBYTE();
      for (j = song_rows; j < MAX_SONG_ROWS; j++)
        instr.p[j] = 0;

      // Columns
      var num_patterns = version < 9 ? 10 : MAX_PATTERNS;
      instr.c = [];
      for (j = 0; j < num_patterns; j++) {
        col = {};
        col.n = [];
        if (version == 1) {
          for (k = 0; k < song.patternLen; k++) {
            col.n[k] = bin.getUBYTE();
            col.n[k+song.patternLen] = 0;
            col.n[k+2*song.patternLen] = 0;
            col.n[k+3*song.patternLen] = 0;
          }
        }
        else {
          for (k = 0; k < song.patternLen * 4; k++)
            col.n[k] = bin.getUBYTE();
        }
        col.f = [];
        if (version < 4) {
          for (k = 0; k < song.patternLen * 2; k++)
            col.f[k] = 0;
        }
        else {
          for (k = 0; k < song.patternLen; k++) {
            var fxCmd = bin.getUBYTE();
            // We inserted two new commands in version 11
            if (version < 11 && fxCmd >= 14)
              fxCmd += 2;
            // We inserted ENV_EXP_DECAY in version 14
            if (version < 14 && fxCmd >= 14)
              fxCmd += 1;
            col.f[k] = fxCmd;
          }
          for (k = 0; k < song.patternLen; k++)
            col.f[song.patternLen + k] = bin.getUBYTE();
        }
        instr.c[j] = col;
      }
      for (j = num_patterns; j < MAX_PATTERNS; j++) {
        col = {};
        col.n = [];
        for (k = 0; k < song.patternLen * 4; k++)
          col.n[k] = 0;
        col.f = [];
        for (k = 0; k < song.patternLen * 2; k++)
          col.f[k] = 0;
        instr.c[j] = col;
      }

      // Fixup conversions
      if (version < 3) {
        if (instr.i[OSC1_WAVEFORM] == 2)
          instr.i[OSC1_VOL] = Math.round(instr.i[OSC1_VOL]/2);
        if (instr.i[OSC2_WAVEFORM] == 2)
          instr.i[OSC2_VOL] = Math.round(instr.i[OSC2_VOL]/2);
        if (instr.i[LFO_WAVEFORM] == 2)
          instr.i[LFO_AMT] = Math.round(instr.i[LFO_AMT]/2);
        instr.i[FX_DRIVE] = instr.i[FX_DRIVE] < 224 ? instr.i[FX_DRIVE] + 32 : 255;
      }
      if (version < 7)
        instr.i[FX_RESONANCE] = 255 - instr.i[FX_RESONANCE];

      song.songData[i] = instr;
    }
    for (; i < MAX_CHANNELS; i++) {
      song.songData[i] = makeEmptyChannel(song.patternLen);
    }

    return song;
  };

  var sonantBinToSong = function (d) {
    // Check if this is a sonant song (correct length & reasonable end pattern)
    if (d.length != 3333)
      return undefined;
    if ((d.charCodeAt(3332) & 255) > 48)
      return undefined;

    var bin = new CBinParser(d);
    var song = {};

    // Row length
    song.rowLen = bin.getULONG();

    // Number of rows per pattern
    song.patternLen = 32;

    // All 8 instruments
    song.songData = [];
    var i, j, k, instr, col, master;
    for (i = 0; i < 8; i++) {
      instr = {};
      instr.i = [];

      // Oscillator 1
      instr.i[OSC1_SEMI] = 12 * (bin.getUBYTE() - 8) + 128;
      instr.i[OSC1_SEMI] += bin.getUBYTE();
      bin.getUBYTE(); // Skip (detune)
      instr.i[OSC1_XENV] = 64 * bin.getUBYTE();
      instr.i[OSC1_VOL] = bin.getUBYTE();
      instr.i[OSC1_WAVEFORM] = bin.getUBYTE();

      // Oscillator 2
      instr.i[OSC2_SEMI] = 12 * (bin.getUBYTE() - 8) + 128;
      instr.i[OSC2_SEMI] += bin.getUBYTE();
      instr.i[OSC2_DETUNE] = bin.getUBYTE();
      instr.i[OSC2_XENV] = 64 * bin.getUBYTE();
      instr.i[OSC2_VOL] = bin.getUBYTE();
      instr.i[OSC2_WAVEFORM] = bin.getUBYTE();

      // Noise oscillator
      instr.i[NOISE_VOL] = bin.getUBYTE();
      bin.getUBYTE(); // Pad!
      bin.getUBYTE(); // Pad!
      bin.getUBYTE(); // Pad!

      // Envelope
      instr.i[ENV_ATTACK] = Math.round(Math.sqrt(bin.getULONG()) / 2);
      instr.i[ENV_SUSTAIN] = Math.round(Math.sqrt(bin.getULONG()) / 2);
      instr.i[ENV_RELEASE] = Math.round(Math.sqrt(bin.getULONG()) / 2);
      master = bin.getUBYTE(); // env_master
      instr.i[ENV_EXP_DECAY] = 0;

      // Effects
      instr.i[FX_FILTER] = bin.getUBYTE();
      bin.getUBYTE(); // Pad!
      bin.getUBYTE(); // Pad!
      instr.i[FX_FREQ] = Math.round(bin.getFLOAT() / 43.23529);
      instr.i[FX_RESONANCE] = 255 - bin.getUBYTE();
      instr.i[FX_DELAY_TIME] = bin.getUBYTE();
      instr.i[FX_DELAY_AMT] = bin.getUBYTE();
      instr.i[FX_PAN_FREQ] = bin.getUBYTE();
      instr.i[FX_PAN_AMT] = bin.getUBYTE();
      instr.i[FX_DIST] = 0;
      instr.i[FX_DRIVE] = 32;

      // Arpeggio
      instr.i[ARP_CHORD] = 0;
      instr.i[ARP_SPEED] = 0;

      // LFO
      bin.getUBYTE(); // Skip! (lfo_osc1_freq)
      instr.i[LFO_FX_FREQ] = bin.getUBYTE();
      instr.i[LFO_FREQ] = bin.getUBYTE();
      instr.i[LFO_AMT] = bin.getUBYTE();
      instr.i[LFO_WAVEFORM] = bin.getUBYTE();

      // Patterns
      instr.p = [];
      for (j = 0; j < 48; j++)
        instr.p[j] = bin.getUBYTE();
      for (j = 48; j < MAX_SONG_ROWS; j++)
        instr.p[j] = 0;

      // Columns
      instr.c = [];
      for (j = 0; j < 10; j++) {
        col = {};
        col.n = [];
        for (k = 0; k < 32; k++) {
          col.n[k] = bin.getUBYTE();
          col.n[k+32] = 0;
          col.n[k+64] = 0;
          col.n[k+96] = 0;
        }
        col.f = [];
        for (k = 0; k < 32 * 2; k++)
          col.f[k] = 0;
        instr.c[j] = col;
      }
      for (j = 10; j < MAX_PATTERNS; j++) {
        col = {};
        col.n = [];
        for (k = 0; k < 32 * 4; k++)
          col.n[k] = 0;
        col.f = [];
        for (k = 0; k < 32 * 2; k++)
          col.f[k] = 0;
        instr.c[j] = col;
      }

      bin.getUBYTE(); // Pad!
      bin.getUBYTE(); // Pad!

      // Fixup conversions
      if (instr.i[FX_FILTER] < 1 || instr.i[FX_FILTER] > 3) {
        instr.i[FX_FILTER] = 2;
        instr.i[FX_FREQ] = 255; // 11025;
      }
      instr.i[OSC1_VOL] *= master / 255;
      instr.i[OSC2_VOL] *= master / 255;
      instr.i[NOISE_VOL] *= master / 255;
      if (instr.i[OSC1_WAVEFORM] == 2)
        instr.i[OSC1_VOL] /= 2;
      if (instr.i[OSC2_WAVEFORM] == 2)
        instr.i[OSC2_VOL] /= 2;
      if (instr.i[LFO_WAVEFORM] == 2)
        instr.i[LFO_AMT] /= 2;
      instr.i[OSC1_VOL] = Math.round(instr.i[OSC1_VOL]);
      instr.i[OSC2_VOL] = Math.round(instr.i[OSC2_VOL]);
      instr.i[NOISE_VOL] = Math.round(instr.i[NOISE_VOL]);
      instr.i[LFO_AMT] = Math.round(instr.i[LFO_AMT]);

      song.songData[i] = instr;
    }
    for (; i < MAX_CHANNELS; i++) {
      song.songData[i] = makeEmptyChannel(song.patternLen);
    }

    // Last pattern to play
    song.endPattern = bin.getUBYTE() + 2;

    return song;
  };

  var instrumentToBin = function (instrI) {
    var bin = new CBinWriter();

    putInstrument(bin,instrI);

    // The code and file format are ready to support compressed data;
    // However, at the moment, the instruments are so small that no point
    // compressing. Replace this line with compress(bin.getData()) if needed
    var compressedData = {method:0,data:bin.getData()};

    // Create a new binary stream - this is the actual file
    bin = new CBinWriter();

    // Signature
    bin.putULONG(makeFourCC("SBxI"));

    // Format version
    bin.putUBYTE(3);

    // Compression method
    bin.putUBYTE(compressedData.method);

    // Append packed data
    bin.append(compressedData.data);

    return bin.getData();
  };

  var binToInstrument = function (d) {
    var bin = new CBinParser(d);
    var instrI = [];

    // Signature
    var signature = bin.getULONG();

    // Format version
    var version = bin.getUBYTE();

    // Check if this is a SoundBox instrument
    if (signature != makeFourCC("SBxI") || (version < 1 || version > 3))
      return undefined;

    var compressionMethod = bin.getUBYTE();

    // Unpack instrument data
    var packedData = bin.getTail();
    var unpackedData = uncompress(compressionMethod,packedData);

    bin = new CBinParser(unpackedData);

    // Oscillator 1
    instrI[OSC1_WAVEFORM] = bin.getUBYTE();
    instrI[OSC1_VOL] = bin.getUBYTE();
    instrI[OSC1_SEMI] = bin.getUBYTE();
    // Version 1 only had two binary values for the OSC1_XENV
    instrI[OSC1_XENV] = version < 2 ? 64 * bin.getUBYTE() : bin.getUBYTE();

    // Oscillator 2
    instrI[OSC2_WAVEFORM] = bin.getUBYTE();
    instrI[OSC2_VOL] = bin.getUBYTE();
    instrI[OSC2_SEMI] = bin.getUBYTE();
    instrI[OSC2_DETUNE] = bin.getUBYTE();
    // Version 1 only had two binary values for the OSC2_XENV
    instrI[OSC2_XENV] = version < 2 ? 64 * bin.getUBYTE() : bin.getUBYTE();

    // Noise oscillator
    instrI[NOISE_VOL] = bin.getUBYTE();

    // Envelope
    instrI[ENV_ATTACK] = bin.getUBYTE();
    instrI[ENV_SUSTAIN] = bin.getUBYTE();
    instrI[ENV_RELEASE] = bin.getUBYTE();
    instrI[ENV_EXP_DECAY] = version < 3 ? 0 : bin.getUBYTE();

    // Arpeggio
    instrI[ARP_CHORD] = bin.getUBYTE();
    instrI[ARP_SPEED] = bin.getUBYTE();

    // LFO
    instrI[LFO_WAVEFORM] = bin.getUBYTE();
    instrI[LFO_AMT] = bin.getUBYTE();
    instrI[LFO_FREQ] = bin.getUBYTE();
    instrI[LFO_FX_FREQ] = bin.getUBYTE();

    // Effects
    instrI[FX_FILTER] = bin.getUBYTE();
    instrI[FX_FREQ] = bin.getUBYTE();
    instrI[FX_RESONANCE] = bin.getUBYTE();
    instrI[FX_DIST] = bin.getUBYTE();
    instrI[FX_DRIVE] = bin.getUBYTE();
    instrI[FX_PAN_AMT] = bin.getUBYTE();
    instrI[FX_PAN_FREQ] = bin.getUBYTE();
    instrI[FX_DELAY_AMT] = bin.getUBYTE();
    instrI[FX_DELAY_TIME] = bin.getUBYTE();

    return instrI;
  };

  var binToSong = function (d) {
    // Try to parse the binary data as a SoundBox song
    var song = soundboxBinToSong(d);

    // Try to parse the binary data as a Sonant song
    if (!song)
      song = sonantBinToSong(d);

    if (!song) {
      // We coulnd't parse the song
      return undefined;
    }

    return song;
  };

  var songToJS = function (song) {
    var i, j, k;
    var jsData = "";

    jsData += "    // This music has been exported by SoundBox. You can use it with\n";
    jsData += "    // http://sb.bitsnbites.eu/player-small.js in your own product.\n\n";

    jsData += "    // See http://sb.bitsnbites.eu/demo.html for an example of how to\n";
    jsData += "    // use it in a demo.\n\n";

    jsData += "    // Song data\n";
    jsData += "    var song = {\n";

    jsData += "      songData: [\n";
    for (i = 0; i < song.numChannels; i++) {
      var instr = song.songData[i];
      jsData += "        { // Instrument " + i + "\n";
      jsData += "          i: [\n";
      jsData += "          " + instr.i[OSC1_WAVEFORM] + ", // OSC1_WAVEFORM\n";
      jsData += "          " + instr.i[OSC1_VOL] + ", // OSC1_VOL\n";
      jsData += "          " + instr.i[OSC1_SEMI] + ", // OSC1_SEMI\n";
      jsData += "          " + instr.i[OSC1_XENV] + ", // OSC1_XENV\n";
      jsData += "          " + instr.i[OSC2_WAVEFORM] + ", // OSC2_WAVEFORM\n";
      jsData += "          " + instr.i[OSC2_VOL] + ", // OSC2_VOL\n";
      jsData += "          " + instr.i[OSC2_SEMI] + ", // OSC2_SEMI\n";
      jsData += "          " + instr.i[OSC2_DETUNE] + ", // OSC2_DETUNE\n";
      jsData += "          " + instr.i[OSC2_XENV] + ", // OSC2_XENV\n";
      jsData += "          " + instr.i[NOISE_VOL] + ", // NOISE_VOL\n";
      jsData += "          " + instr.i[ENV_ATTACK] + ", // ENV_ATTACK\n";
      jsData += "          " + instr.i[ENV_SUSTAIN] + ", // ENV_SUSTAIN\n";
      jsData += "          " + instr.i[ENV_RELEASE] + ", // ENV_RELEASE\n";
      jsData += "          " + instr.i[ENV_EXP_DECAY] + ", // ENV_EXP_DECAY\n";
      jsData += "          " + instr.i[ARP_CHORD] + ", // ARP_CHORD\n";
      jsData += "          " + instr.i[ARP_SPEED] + ", // ARP_SPEED\n";
      jsData += "          " + instr.i[LFO_WAVEFORM] + ", // LFO_WAVEFORM\n";
      jsData += "          " + instr.i[LFO_AMT] + ", // LFO_AMT\n";
      jsData += "          " + instr.i[LFO_FREQ] + ", // LFO_FREQ\n";
      jsData += "          " + instr.i[LFO_FX_FREQ] + ", // LFO_FX_FREQ\n";
      jsData += "          " + instr.i[FX_FILTER] + ", // FX_FILTER\n";
      jsData += "          " + instr.i[FX_FREQ] + ", // FX_FREQ\n";
      jsData += "          " + instr.i[FX_RESONANCE] + ", // FX_RESONANCE\n";
      jsData += "          " + instr.i[FX_DIST] + ", // FX_DIST\n";
      jsData += "          " + instr.i[FX_DRIVE] + ", // FX_DRIVE\n";
      jsData += "          " + instr.i[FX_PAN_AMT] + ", // FX_PAN_AMT\n";
      jsData += "          " + instr.i[FX_PAN_FREQ] + ", // FX_PAN_FREQ\n";
      jsData += "          " + instr.i[FX_DELAY_AMT] + ", // FX_DELAY_AMT\n";
      jsData += "          " + instr.i[FX_DELAY_TIME] + " // FX_DELAY_TIME\n";
      jsData += "          ],\n";

      // Sequencer data for this instrument
      jsData += "          // Patterns\n";
      jsData += "          p: [";
      var lastRow = song.endPattern;
      var maxPattern = 0, lastNonZero = 0;
      for (j = 0; j <= lastRow; j++) {
        var pattern = instr.p[j];
        if (pattern > maxPattern)
          maxPattern = pattern;
        if (pattern)
          lastNonZero = j;
      }
      for (j = 0; j <= lastNonZero; j++) {
        var pattern = instr.p[j];
        if (pattern)
          jsData += pattern;
        if (j < lastNonZero)
          jsData += ",";
      }
      jsData += "],\n";

      // Pattern data for this instrument
      jsData += "          // Columns\n";
      jsData += "          c: [\n";
      for (j = 0; j < maxPattern; j++) {
        jsData += "            {n: [";
        lastNonZero = 0;
        for (k = 0; k < song.patternLen * 4; k++) {
          if (instr.c[j].n[k])
            lastNonZero = k;
        }
        for (k = 0; k <= lastNonZero; k++) {
          var note = instr.c[j].n[k];
          if (note)
            jsData += note;
          if (k < lastNonZero)
            jsData += ",";
        }
        jsData += "],\n";
        jsData += "             f: [";
        lastNonZero = 0;
        for (k = 0; k < song.patternLen * 2; k++) {
          if (instr.c[j].f[k])
            lastNonZero = k;
        }
        for (k = 0; k <= lastNonZero; k++) {
          var fx = instr.c[j].f[k];
          if (fx)
            jsData += fx;
          if (k < lastNonZero)
            jsData += ",";
        }
        jsData += "]}";
        if (j < maxPattern - 1)
          jsData += ",";
        jsData += "\n";
      }
      jsData += "          ]\n";
      jsData += "        }";
      if (i < song.numChannels)
        jsData += ",";
      jsData += "\n";
    }

    jsData += "      ],\n";
    jsData += "      rowLen: " + song.rowLen + ",   // In sample lengths\n";
    jsData += "      patternLen: " + song.patternLen + ",  // Rows per pattern\n";
    jsData += "      endPattern: " + song.endPattern + ",  // End pattern\n";
    jsData += "      numChannels: " + song.numChannels + "  // Number of channels\n";
    jsData += "    };\n";

    return jsData;
  };


  //----------------------------------------------------------------------------
  // Midi interaction.
  // Based on example code by Chris Wilson.
  //----------------------------------------------------------------------------

  var mSelectMIDI;
  var mMIDIAccess;
  var mMIDIIn;

  var midiMessageReceived = function (ev) {
    var cmd = ev.data[0] >> 4;
    var channel = ev.data[0] & 0xf;
    var noteNumber = ev.data[1];
    var velocity = ev.data[2];

    if (channel == 9) {
      return;
    }

    if (cmd == 9 && velocity > 0) {
      // Note on (note on with velocity zero is the same as note off).
      // NOTE: Note no. 69 is A4 (440 Hz), which is note no. 57 in SoundBox.
      playNote(noteNumber - 12);
    } else if (cmd == 14) {
      // Pitch wheel
      var pitch = ((velocity * 128.0 + noteNumber)-8192) / 8192.0;
      // TODO(m): We could use this for controlling something. I think it would
      // be neat to use the pitch wheel for moving up/down in the pattern
      // editor.
    }
  };

  var selectMIDIIn = function (ev) {
    mMIDIIn = mMIDIAccess.inputs()[mSelectMIDI.selectedIndex];
    mMIDIIn.onmidimessage = midiMessageReceived;
  };

  var onMIDIStarted = function (midi) {
    mMIDIAccess = midi;

    var list = mMIDIAccess.inputs();

    // Detect preferred device.
    var preferredIndex = 0;
    for (var i = 0; i < list.length; i++) {
      var str = list[i].name.toString().toLowerCase();
      if ((str.indexOf("keyboard") != -1)) {
        preferredIndex = i;
        break;
      }
    }

    // Populate the MIDI input selection drop down box.
    mSelectMIDI.options.length = 0;
    if (list.length) {
      for (var i = 0; i < list.length; i++) {
        mSelectMIDI.options[i] = new Option(list[i].name, list[i].fingerprint,
            i == preferredIndex, i == preferredIndex);
      }

      mMIDIIn = list[preferredIndex];
      mMIDIIn.onmidimessage = midiMessageReceived;

      mSelectMIDI.onchange = selectMIDIIn;

      // Show the MIDI input selection box.
      mSelectMIDI.style.display = "inline";
    }
  };

  var onMIDISystemError = function (err) {
    // TODO(m): Log an error message somehow (err.code)...
  };

  var initMIDI = function () {
    if (navigator.requestMIDIAccess) {
      mSelectMIDI = document.getElementById("midiInput");
      navigator.requestMIDIAccess().then(onMIDIStarted, onMIDISystemError);
    }
  };


  //--------------------------------------------------------------------------
  // Helper functions
  //--------------------------------------------------------------------------

  var preloadImage = function (url)
  {
    var img = new Image();
    img.src = url;
    mPreload.push(img);
  };

  var initPresets = function()
  {
    var parent = document.getElementById("instrPreset");
    var o, instr;
    for (var i = 0; i < gInstrumentPresets.length; ++i)
    {
      instr = gInstrumentPresets[i];
      o = document.createElement("option");
      o.value = instr.i ? "" + i : "";
      o.appendChild(document.createTextNode(instr.name));
      parent.appendChild(o);
    }
  };

  var getElementPos = function (o)
  {
    var left = 0, top = 0;
    if (o.offsetParent)
    {
      do {
        left += o.offsetLeft;
        top += o.offsetTop;
      } while (o = o.offsetParent);
    }
    return [left, top];
  };

  var getEventElement = function (e)
  {
    var o = null;
    if (!e) var e = window.event;
    if (e.target)
      o = e.target;
    else if (e.srcElement)
      o = e.srcElement;
    if (o.nodeType == 3) // defeat Safari bug
      o = o.parentNode;
    return o;
  };

  var getMousePos = function (e, rel)
  {
    // Get the mouse document position
    var p = [0, 0];
    if (e.pageX && e.pageY)
    {
      p = [e.pageX, e.pageY];
    }
    else if (e.clientX && e.clientY)
    {
      p = [e.clientX + document.body.scrollLeft +
           document.documentElement.scrollLeft,
           e.clientY + document.body.scrollTop +
           document.documentElement.scrollTop];
    }
    else if (e.touches && e.touches.length > 0) {
      p = [e.touches[0].clientX + document.body.scrollLeft +
           document.documentElement.scrollLeft,
           e.touches[0].clientY + document.body.scrollTop +
           document.documentElement.scrollTop];
    }

    if (!rel) return p;

    // Get the element document position
    var pElem = getElementPos(getEventElement(e));
    return [p[0] - pElem[0], p[1] - pElem[1]];
  };

  var unfocusHTMLInputElements = function () {
    document.getElementById("bpm").blur();
    document.getElementById("rpp").blur();
    document.getElementById("instrPreset").blur();
  };

  var setEditMode = function (mode) {
    if (mode === mEditMode)
      return;
    mEditMode = mode;

    // Set the style for the different edit sections
    document.getElementById("sequencer").className = (mEditMode == EDIT_SEQUENCE ? "edit" : "");
    document.getElementById("pattern").className = (mEditMode == EDIT_PATTERN ? "edit" : "");
    document.getElementById("fxtrack").className = (mEditMode == EDIT_FXTRACK ? "edit" : "");

    // Unfocus any focused input elements
    if (mEditMode != EDIT_NONE)
    {
      unfocusHTMLInputElements();
      updateSongSpeed();
      updatePatternLength();
    }
  };

  var updateSongInfo = function() {
    document.getElementById("bpm").value = getBPM();
    document.getElementById("rpp").value = mSong.patternLen;
  };

  var toHex = function (num, count) {
    var s = num.toString(16).toUpperCase();
    var leadingZeros = count - s.length;
    for (var i = 0; i < leadingZeros; ++i)
      s = "0" + s;
    return s;
  };

  var playNote = function (n) {
    // Calculate note number and trigger a new note in the jammer.
    var note = n + 87;
    mJammer.addNote(note);

    // Edit pattern if we're in pattern edit mode.
    if (mEditMode == EDIT_PATTERN)
    {
      var pat = mSeq.getCurrent()-1;
      if (pat >= 0) {
        mPattern.setCurrent(note);
        mPattern.setCursor(mPattern.col(), (mPattern.row() + 1) % mSong.patternLen);
        return true;
      }
    }
    return false;
  };

  var updateSlider = function (o, x) {
    var props = o.sliderProps;
    var pos = (x - props.min) / (props.max - props.min);
    pos = pos < 0 ? 0 : (pos > 1 ? 1 : pos);
    if (props.nonLinear)
    {
      pos = Math.sqrt(pos);
    }
    o.style.marginLeft = Math.round(191 * pos) + "px";
    var valuetips = o.parentElement.getElementsByClassName("valuetip");
    if (valuetips.length > 0)
      valuetips[0].innerHTML = x;
  };

  var updateCheckBox = function (o, check) {
    o.src = check ? "gui/box-check.png" : "gui/box-uncheck.png";
  };

  var clearPresetSelection = function () {
    var o = document.getElementById("instrPreset");
    o.selectedIndex = 0;
  };

  var updateInstrument = function (resetPreset) {
    var instrI = deepCopy(mSong.songData[mSeq.col()].i);

    if (mEditMode == EDIT_FXTRACK)
    {
      var fxCmd = mFxTrack.getCurrent();
      if (fxCmd[0]>0)
        instrI[fxCmd[0]-1] = fxCmd[1];
    }

    // Oscillator 1
    document.getElementById("osc1_wave_sin").src = instrI[OSC1_WAVEFORM] == 0 ? "gui/wave-sin-sel.png" : "gui/wave-sin.png";
    document.getElementById("osc1_wave_sqr").src = instrI[OSC1_WAVEFORM] == 1 ? "gui/wave-sqr-sel.png" : "gui/wave-sqr.png";
    document.getElementById("osc1_wave_saw").src = instrI[OSC1_WAVEFORM] == 2 ? "gui/wave-saw-sel.png" : "gui/wave-saw.png";
    document.getElementById("osc1_wave_tri").src = instrI[OSC1_WAVEFORM] == 3 ? "gui/wave-tri-sel.png" : "gui/wave-tri.png";
    updateSlider(document.getElementById("osc1_vol"), instrI[OSC1_VOL]);
    updateSlider(document.getElementById("osc1_semi"), instrI[OSC1_SEMI]);
    updateSlider(document.getElementById("osc1_xenv"), instrI[OSC1_XENV]);

    // Oscillator 2
    document.getElementById("osc2_wave_sin").src = instrI[OSC2_WAVEFORM] == 0 ? "gui/wave-sin-sel.png" : "gui/wave-sin.png";
    document.getElementById("osc2_wave_sqr").src = instrI[OSC2_WAVEFORM] == 1 ? "gui/wave-sqr-sel.png" : "gui/wave-sqr.png";
    document.getElementById("osc2_wave_saw").src = instrI[OSC2_WAVEFORM] == 2 ? "gui/wave-saw-sel.png" : "gui/wave-saw.png";
    document.getElementById("osc2_wave_tri").src = instrI[OSC2_WAVEFORM] == 3 ? "gui/wave-tri-sel.png" : "gui/wave-tri.png";
    updateSlider(document.getElementById("osc2_vol"), instrI[OSC2_VOL]);
    updateSlider(document.getElementById("osc2_semi"), instrI[OSC2_SEMI]);
    updateSlider(document.getElementById("osc2_det"), instrI[OSC2_DETUNE]);
    updateSlider(document.getElementById("osc2_xenv"), instrI[OSC2_XENV]);

    // Noise
    updateSlider(document.getElementById("noise_vol"), instrI[NOISE_VOL]);

    // Envelope
    updateSlider(document.getElementById("env_att"), instrI[ENV_ATTACK]);
    updateSlider(document.getElementById("env_sust"), instrI[ENV_SUSTAIN]);
    updateSlider(document.getElementById("env_rel"), instrI[ENV_RELEASE]);
    updateSlider(document.getElementById("env_decay"), instrI[ENV_EXP_DECAY]);

    // Arpeggio
    updateSlider(document.getElementById("arp_note1"), instrI[ARP_CHORD] >> 4);
    updateSlider(document.getElementById("arp_note2"), instrI[ARP_CHORD] & 15);
    updateSlider(document.getElementById("arp_speed"), instrI[ARP_SPEED]);

    // LFO
    document.getElementById("lfo_wave_sin").src = instrI[LFO_WAVEFORM] == 0 ? "gui/wave-sin-sel.png" : "gui/wave-sin.png";
    document.getElementById("lfo_wave_sqr").src = instrI[LFO_WAVEFORM] == 1 ? "gui/wave-sqr-sel.png" : "gui/wave-sqr.png";
    document.getElementById("lfo_wave_saw").src = instrI[LFO_WAVEFORM] == 2 ? "gui/wave-saw-sel.png" : "gui/wave-saw.png";
    document.getElementById("lfo_wave_tri").src = instrI[LFO_WAVEFORM] == 3 ? "gui/wave-tri-sel.png" : "gui/wave-tri.png";
    updateSlider(document.getElementById("lfo_amt"), instrI[LFO_AMT]);
    updateSlider(document.getElementById("lfo_freq"), instrI[LFO_FREQ]);
    updateCheckBox(document.getElementById("lfo_fxfreq"), instrI[LFO_FX_FREQ]);

    // Effects
    document.getElementById("fx_filt_lp").src = instrI[FX_FILTER] == 2 ? "gui/filt-lp-sel.png" : "gui/filt-lp.png";
    document.getElementById("fx_filt_hp").src = instrI[FX_FILTER] == 1 ? "gui/filt-hp-sel.png" : "gui/filt-hp.png";
    document.getElementById("fx_filt_bp").src = instrI[FX_FILTER] == 3 ? "gui/filt-bp-sel.png" : "gui/filt-bp.png";
    updateSlider(document.getElementById("fx_freq"), instrI[FX_FREQ]);
    updateSlider(document.getElementById("fx_res"), instrI[FX_RESONANCE]);
    updateSlider(document.getElementById("fx_dly_amt"), instrI[FX_DELAY_AMT]);
    updateSlider(document.getElementById("fx_dly_time"), instrI[FX_DELAY_TIME]);
    updateSlider(document.getElementById("fx_pan_amt"), instrI[FX_PAN_AMT]);
    updateSlider(document.getElementById("fx_pan_freq"), instrI[FX_PAN_FREQ]);
    updateSlider(document.getElementById("fx_dist"), instrI[FX_DIST]);
    updateSlider(document.getElementById("fx_drive"), instrI[FX_DRIVE]);

    // Clear the preset selection?
    if (resetPreset)
      clearPresetSelection();

    // Update the jammer instrument
    mJammer.updateInstr(instrI);
  };

  var updateSongSpeed = function () {
    // Determine song speed
    var bpm = parseInt(document.getElementById("bpm").value);
    if (bpm && (bpm >= 10) && (bpm <= 1000)) {
      mSong.rowLen = calcSamplesPerRow(bpm);
      mJammer.updateRowLen(mSong.rowLen);
    }
  };

  var setPatternLength = function (length) {
    if (mSong.patternLen === length)
      return;

    // Stop song if it's currently playing (the song will be wrong and the
    // follower will be off)
    stopAudio();

    // Truncate/extend patterns
    var i, j, k, col, notes, fx;
    for (i = 0; i < MAX_CHANNELS; i++) {
      for (j = 0; j < MAX_PATTERNS; j++) {
        col = mSong.songData[i].c[j];
        notes = [];
        fx = [];
        for (k = 0; k < 4 * length; k++)
          notes[k] = 0;
        for (k = 0; k < 2 * length; k++)
          fx[k] = 0;
        for (k = 0; k < Math.min(mSong.patternLen, length); k++) {
          notes[k] = col.n[k];
          notes[k + length] = col.n[k + mSong.patternLen];
          notes[k + 2 * length] = col.n[k + 2 * mSong.patternLen];
          notes[k + 3 * length] = col.n[k + 3 * mSong.patternLen];
          fx[k] = col.f[k];
          fx[k + length] = col.f[k + mSong.patternLen];
        }
        col.n = notes;
        col.f = fx;
      }
    }

    // Update pattern length
    mSong.patternLen = length;
  };

  var updatePatternLength = function () {
    var rpp = parseInt(document.getElementById("rpp").value);
    if (rpp && (rpp >= 1) && (rpp <= 256)) {
      // Update the pattern length of the song data
      setPatternLength(rpp);

      // Update UI
      buildPatternTable();
      buildFxTable();
      mPattern.update();
      mFxTrack.update();
    }
  };

  var updateSongRanges = function () {
    var i, j, emptyRow;

    // Find the maximum song row and channel number
    var maxRow = 0;
    var maxCol = 0;
    for (i = 0; i < MAX_SONG_ROWS; ++i) {
      emptyRow = true;
      for (j = 0; j < MAX_CHANNELS; ++j) {
        if (mSong.songData[j].p[i] > 0) {
          emptyRow = false;
          maxCol = Math.max(maxCol, j);
        }
      }
      if (!emptyRow)
        maxRow = i;
    }
    mSong.endPattern = maxRow;
    mSong.numChannels = maxCol + 1;

    // Update the song speed
    updateSongSpeed();
  };

  var showDialog = function () {
    var e = document.getElementById("cover");
    e.style.visibility = "visible";
    e = document.getElementById("dialog");
    e.style.visibility = "visible";
    deactivateMasterEvents();
  };

  var hideDialog = function () {
    var e = document.getElementById("cover");
    e.style.visibility = "hidden";
    e = document.getElementById("dialog");
    e.style.visibility = "hidden";
    activateMasterEvents();
  };

  var showProgressDialog = function (msg) {
    var parent = document.getElementById("dialog");
    parent.innerHTML = "";

    // Create dialog content
    var o, o2;
    o = document.createElement("img");
    o.src = "gui/progress.gif";
    parent.appendChild(o);
    o = document.createTextNode(msg);
    parent.appendChild(o);
    o = document.createElement("div");
    o.id = "progressBarParent";
    parent.appendChild(o);
    o2 = document.createElement("div");
    o2.id = "progressBar";
    o.appendChild(o2);

    showDialog();
  };

  var loadSongFromData = function (songData) {
    var song = binToSong(songData);
    if (song) {
      // If the song is now different than it was when loaded, the user has done some changes.
      // Confirm before overwriting
      if (!deepEquals(mSong, mSongUnmodified)) {
        var ok = confirm("Load the song? Unsaved changes to your current song will be lost.");
        if (!ok)
          return false;
      }
      stopAudio();
      mSong = song;
      updateSongInfo();
      mSeq.update();
      mPattern.update();
      mFxTrack.update();
      updateInstrument(true);
      mSongUnmodified = deepCopy(mSong); // store the song before any modifications´
      return true;
    }
    return false;
  };

  var loadInstrumentFromData = function (instrumentData) {
    var instrI = binToInstrument(instrumentData);
    if (instrI) {
      stopAudio();
      mSong.songData[mSeq.col()].i = instrI;
      updateInstrument(true);
      return true;
    }
    return false;
  };

  var showOpenDialog = function () {
    var parent = document.getElementById("dialog");
    parent.innerHTML = "";

    // Create dialog content
    var o;
    o = document.createElement("h3");
    o.appendChild(document.createTextNode("Open song"));
    parent.appendChild(o);

    parent.appendChild(document.createElement("br"));

    var form = document.createElement("form");

    var listDiv = document.createElement("div");
    listDiv.style.textAlign = "left";
    listDiv.style.marginLeft = "30px";
    listDiv.style.lineHeight = "1.8em";

    // List demo songs...
    var demoSongsElements = [];
    for (var i = 0; i < gDemoSongs.length; i++) {
      o = document.createElement("input");
      o.type = "radio";
      o.name = "radiogroup1";
      o.value = gDemoSongs[i].name;
      if (i === 0)
        o.checked = true;
      demoSongsElements.push(o);
      listDiv.appendChild(o);
      o = document.createElement("span");
      o.innerHTML = gDemoSongs[i].description;
      listDiv.appendChild(o);
      listDiv.appendChild(document.createElement("br"));
    }

    // Add input for a custom data URL
    var customURLRadioElement = document.createElement("input");
    customURLRadioElement.type = "radio";
    customURLRadioElement.name = "radiogroup1";
    customURLRadioElement.value = "custom";
    listDiv.appendChild(customURLRadioElement);
    listDiv.appendChild(document.createTextNode(" Data URL: "));
    var customURLElement = document.createElement("input");
    customURLElement.type = "text";
    customURLElement.size = "45";
    customURLElement.title = "Paste a saved song data URL here";
    customURLElement.onchange = function () {
      customURLRadioElement.checked = true;
    };
    customURLElement.onkeydown = customURLElement.onchange;
    customURLElement.onclick = customURLElement.onchange;
    listDiv.appendChild(customURLElement);

    form.appendChild(listDiv);

    o = document.createElement("p");
    o.appendChild(document.createTextNode("Hint: You can also drag'n'drop binary files into the editor."));
    form.appendChild(o);

    form.appendChild(document.createElement("br"));

    o = document.createElement("input");
    o.type = "submit";
    o.value = "Open";
    o.title = "Open song";
    o.onclick = function (e) {
      e.preventDefault();

      var songData = null;
      if (customURLRadioElement.checked) {
        // Convert custom data URL to song data
        var params = parseURLGetData(customURLElement.value);
        songData = getURLSongData(params && params.data && params.data[0]);
      } else {
        // Pick a demo song
        for (var i = 0; i < demoSongsElements.length; i++) {
          var e = demoSongsElements[i];
          if (e.checked) {
            for (var j = 0; j < gDemoSongs.length; j++) {
              if (gDemoSongs[j].name === e.value) {
                if (gDemoSongs[j].data)
                  songData = gDemoSongs[j].data;
                else
                  songData = getURLSongData(gDemoSongs[j].base64);
                break;
              }
            }
            break;
          }
        }
      }

      // Load the song
      if (songData)
        loadSongFromData(songData);
      hideDialog();
    };
    form.appendChild(o);
    form.appendChild(document.createTextNode(" "));
    o = document.createElement("input");
    o.type = "submit";
    o.value = "Cancel";
    o.onclick = function () {
      hideDialog();
      return false;
    };
    form.appendChild(o);
    parent.appendChild(form);

    showDialog();
  };

  var showSaveDialog = function () {
    // Opening the save dialog is considered saving; however, we have no way of knowing
    // if the user really bookmarked the song url.
    mSongUnmodified = deepCopy(mSong);

    var parent = document.getElementById("dialog");
    parent.innerHTML = "";

    // Create dialog content
    var o, o2;
    o = document.createElement("h3");
    o.appendChild(document.createTextNode("Save song"));
    parent.appendChild(o);

    o = document.createElement("p");
    o.appendChild(document.createTextNode("Data URL (copy/paste, bookmark, mail etc):"));
    parent.appendChild(o);

    o = document.createElement("p");
    o2 = document.createElement("a");
    var url = makeURLSongData(songToBin(mSong));
    var shortURL = url.length < 70 ? url : url.slice(0,67) + "...";
    o2.href = url;
    o2.title = url;
    o2.appendChild(document.createTextNode(shortURL));
    o.appendChild(o2);
    parent.appendChild(o);

    var form = document.createElement("form");
    o = document.createElement("input");
    o.type = "submit";
    o.value = "Save binary";
    o.title = "Save the song as a binary file.";
    o.onclick = function () {
      var dataURI = "data:application/octet-stream;base64," + btoa(songToBin(mSong));
      window.open(dataURI);
      hideDialog();
      return false;
    };
    form.appendChild(o);
    o = document.createElement("input");
    o.type = "submit";
    o.value = "Close";
    o.onclick = function () {
      hideDialog();
      return false;
    };
    form.appendChild(o);

    parent.appendChild(form);

    showDialog();
  };

  var showAboutDialog = function () {
    var parent = document.getElementById("dialog");
    parent.innerHTML = "";

    // Create dialog content
    var o, o2;
    o = document.createElement("img");
    o.src = "gui/logo-big.png";
    parent.appendChild(o);

    o = document.createElement("p");
    o.appendChild(document.createTextNode("an HTML5 synth music tracker"));
    parent.appendChild(o);

    o = document.createElement("p");
    o.innerHTML = "Licensed under the <a href=\"gpl.txt\" target=\"_blank\" rel=\"noopener noreferrer\">GPL v3</a> license " +
                  "(get the <a href=\"https://github.com/mbitsnbites/soundbox\" target=\"_blank\" rel=\"noopener noreferrer\">source</a>).";
    o.style.fontStyle = "italic";
    parent.appendChild(o);

    o = document.createElement("p");
    o.appendChild(document.createTextNode("To get started, open a demo song."));
    parent.appendChild(o);

    o = document.createElement("a");
    o.href = "help.html";
    o.target = '_blank';
    o.appendChild(document.createTextNode("Help"));
    parent.appendChild(o);
    parent.appendChild(document.createElement("br"));
    parent.appendChild(document.createElement("br"));

    var form = document.createElement("form");
    o = document.createElement("input");
    o.type = "submit";
    o.value = "Close";
    o.onclick = function () {
      unlockAudioPlaybackHack();
      hideDialog();
      return false;
    };
    form.appendChild(o);
    parent.appendChild(form);

    showDialog();
  };

  //--------------------------------------------------------------------------
  // Event handlers
  //--------------------------------------------------------------------------

  var about = function (e) {
    e.preventDefault();
    showAboutDialog();
  };

  var newSong = function (e) {
    // If the song is now different than it was when loaded, the user has done some changes.
    // Confirm before overwriting
    if (!deepEquals(mSong,mSongUnmodified)) {
      var ok = confirm("Start a new song? Unsaved changes to your current song will be lost.");
      if (!ok)
        return false;
    }

    mSong = makeNewSong();
		stopAudio();

    // Update GUI
    updateSongInfo();
    mSeq.update();
    mPattern.update();
    mFxTrack.update();
    updateInstrument();

    // Initialize the song
    setEditMode(EDIT_PATTERN);
    mPattern.setCursor(0, 0);
    mSeq.setCursor(0, 0);
    mFxTrack.setCursor(0, 0);

    mSongUnmodified = deepCopy(mSong); // store the song before any modifications
    return false;
  };

  var openSong = function (e) {
    e.preventDefault();
    showOpenDialog();
  };

  var saveSong = function (e) {
    // Update song ranges
    updateSongRanges();

    showSaveDialog();

    e.preventDefault();
  };

  var exportWAV = function(e)
  {
    e.preventDefault();

    // Update song ranges
    updateSongRanges();

    // Generate audio data
    var doneFun = function (wave)
    {
      var blob = new Blob([wave], {type: "application/octet-stream"});
      saveAs(blob, "SoundBox-music.wav");
    };
    generateAudio(doneFun);
  };

  var exportJS = function(e)
  {
    e.preventDefault();

    // Update song ranges
    updateSongRanges();

    // Generate JS song data
    var blob = new Blob([songToJS(mSong)], {type: "text/plain"});
    saveAs(blob, "song.js");
  };

  var setStatus = function (msg)
  {
    document.getElementById("statusText").innerHTML = msg;
//    window.status = msg;
  };

  var generateAudio = function (doneFun, opts)
  {
    // Show dialog
    showProgressDialog("Generating sound...");

    // Start time measurement
    var d1 = new Date();

    // Generate audio data in a worker.
    mPlayer = new CPlayer();
    mPlayer.generate(mSong, opts, function (progress) {
      // Update progress bar
      var o = document.getElementById("progressBar");
      o.style.width = Math.floor(200 * progress) + "px";

      if (progress >= 1) {
        // Create the wave file
        var wave = mPlayer.createWave();

        // Stop time measurement
        var d2 = new Date();
        setStatus("Generation time: " + (d2.getTime() - d1.getTime())/1000 + "s");

        // Hide dialog
        hideDialog();

        // Call the callback function
        doneFun(wave);
      }
    });
  };

  var isPLaying = function () {
    return mFollowerActive;
  };

  var stopAudio = function () {
    stopFollower();
    if (mAudio) {
      mAudio.pause();
      mAudioTimer.reset();
    } else if (mAudioSourceNode) {
      mAudioSourceNode.stop();
      mAudioSourceNode.disconnect();
      mAudioSourceNode = undefined;
      mAudioSourceStartTime = 0.0;
    }
  };

  var windowBeforeUnload = function(e) {
    // makes sure the user doesn't leave the page without saving
    if (!deepEquals(mSong,mSongUnmodified)) {
      var confirmationMessage = 'Warning: song has unsaved changes. If you leave before saving, your changes will be lost.';
      (e || window.event).returnValue = confirmationMessage; //Gecko + IE
      return confirmationMessage; //Gecko + Webkit, Safari, Chrome etc.
    }
    return undefined;
  }

  //----------------------------------------------------------------------------
  // Playback follower
  //----------------------------------------------------------------------------

  var mFollowerTimerID = -1;
  var mFollowerFirstRow = 0;
  var mFollowerLastRow = 0;
  var mFollowerFirstCol = 0;
  var mFollowerLastCol = 0;
  var mFollowerActive = false;
  var mFollowerLastVULeft = 0;
  var mFollowerLastVURight = 0;

  var getSamplesSinceNote = function (t, chan) {
    var nFloat = t * 44100 / mSong.rowLen;
    var n = Math.floor(nFloat);
    var seqPos0 = Math.floor(n / mSong.patternLen) + mFollowerFirstRow;
    var patPos0 = n % mSong.patternLen;
    for (var k = 0; k < mSong.patternLen; ++k) {
      var seqPos = seqPos0;
      var patPos = patPos0 - k;
      while (patPos < 0) {
        --seqPos;
        if (seqPos < mFollowerFirstRow) return -1;
        patPos += mSong.patternLen;
      }
      var pat = mSong.songData[chan].p[seqPos] - 1;
      for (var patCol = 0; patCol < 4; patCol++) {
        if (pat >= 0 && mSong.songData[chan].c[pat].n[patPos+patCol*mSong.patternLen] > 0)
          return (k + (nFloat - n)) * mSong.rowLen;
      }
    }
    return -1;
  };

  var redrawPlayerGfx = function (t)
  {
    var o = document.getElementById("playGfxCanvas");
    var w = mPlayGfxVUImg.width > 0 ? mPlayGfxVUImg.width : o.width;
    var h = mPlayGfxVUImg.height > 0 ? mPlayGfxVUImg.height : 62;
    var ctx = o.getContext("2d");
    if (ctx)
    {
      // Draw the VU meter BG
      ctx.drawImage(mPlayGfxVUImg, 0, 0);

      // Calculate singal powers
      var pl = 0, pr = 0;
      if (mFollowerActive && t >= 0)
      {
        // Get the waveform
        var wave = mPlayer.getData(t, 1000);

        // Calculate volume
        var i, l, r;
        var sl = 0, sr = 0, l_old = 0, r_old = 0;
        for (i = 1; i < wave.length; i += 2)
        {
          l = wave[i-1];
          r = wave[i];

          // Band-pass filter (low-pass + high-pass)
          sl = 0.8 * l + 0.1 * sl - 0.3 * l_old;
          sr = 0.8 * r + 0.1 * sr - 0.3 * r_old;
          l_old = l;
          r_old = r;

          // Sum of squares
          pl += sl * sl;
          pr += sr * sr;
        }

        // Low-pass filtered mean power (RMS)
        pl = Math.sqrt(pl / wave.length) * 0.2 + mFollowerLastVULeft * 0.8;
        pr = Math.sqrt(pr / wave.length) * 0.2 + mFollowerLastVURight * 0.8;
        mFollowerLastVULeft = pl;
        mFollowerLastVURight = pr;
      }

      // Convert to angles in the VU meter
      var a1 = pl > 0 ? 1.5 + 0.5 * Math.log(pl) : -1000;
      a1 = a1 < -1 ? -1 : a1 > 1 ? 1 : a1;
      a1 *= 0.54;
      var a2 = pr > 0 ? 1.5 + 0.5 * Math.log(pr) : -1000;
      a2 = a2 < -1 ? -1 : a2 > 1 ? 1 : a2;
      a2 *= 0.54;

      // Center: (70, 90)

      // Draw VU hands
      ctx.strokeStyle = "rgb(0,0,0)";
      ctx.beginPath();
      ctx.moveTo(w * 0.25, h * 1.45);
      ctx.lineTo(w * 0.25 + h * 1.8 * Math.sin(a1), h * 2.1 - h * 1.8 * Math.cos(a1));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(w * 0.75, h * 1.45);
      ctx.lineTo(w * 0.75 + h * 1.8 * Math.sin(a2), h * 2.1 - h * 1.8 * Math.cos(a2));
      ctx.stroke();

      // Calculate led dimensions
      var ledSize = mPlayGfxLedOffImg.width > 0 ? mPlayGfxLedOffImg.width : 20;
      var xWidth = Math.min(w, ledSize * MAX_CHANNELS + 12);
      var xStep = xWidth / MAX_CHANNELS;
      var xOffset = (w - xWidth) / 2.0;
      var ledDrawSize = Math.min(ledSize, xStep);
      var yOffset = Math.round((ledSize - ledDrawSize) / 2.0);

      // Draw leds
      ctx.fillStyle = "rgb(0,0,0)";
      ctx.fillRect(0, h, w, ledSize);
      for (i = 0; i < MAX_CHANNELS; ++i)
      {
        // Calculate led position
        var x = Math.round(xOffset + xStep * i);
        var y = h + yOffset;

        // Draw un-lit led
        ctx.drawImage(mPlayGfxLedOffImg, x, y, ledDrawSize, ledDrawSize);

        if (i >= mFollowerFirstCol && i <= mFollowerLastCol)
        {
          // Get envelope profile for this channel
          var env_a = mSong.songData[i].i[ENV_ATTACK],
              env_s = mSong.songData[i].i[ENV_SUSTAIN],
              env_r = mSong.songData[i].i[ENV_RELEASE],
              env_d = mSong.songData[i].i[ENV_EXP_DECAY];  // TODO(m): Use this
          env_a = env_a * env_a * 4;
          env_r = env_s * env_s * 4 + env_r * env_r * 4;
          var env_tot = env_a + env_r;
          if (env_tot < 10000)
          {
            env_tot = 10000;
            env_r = env_tot - env_a;
          }

          // Get number of samples since last new note
          var numSamp = getSamplesSinceNote(t, i);
          if (numSamp >= 0 && numSamp < env_tot)
          {
            // Calculate current envelope (same method as the synth, except sustain)
            var alpha;
            if (numSamp < env_a)
              alpha = numSamp / env_a;
            else
              alpha = 1 - (numSamp - env_a) / env_r;

            // Draw lit led with alpha blending
            ctx.globalAlpha = alpha * alpha;
            ctx.drawImage(mPlayGfxLedOnImg, x, y, ledDrawSize, ledDrawSize);
            ctx.globalAlpha = 1.0;
          }
        }
      }
    }
  };

  var updateFollower = function () {
    // Get current time
    var t, hasAudioEnded = false;
    if (mAudio) {
      t = mAudioTimer.currentTime();
      hasAudioEnded = (mAudio.ended ||
                      (!mAudio.loop && (mAudio.duration && ((mAudio.duration - t) < 0.1))));
    } else if (mAudioContext && mAudioSourceNode) {
      t = mAudioContext.currentTime - mAudioSourceStartTime;
      if (mAudioSourceNode.loop && (mAudioSourceNode.buffer.duration > 0)) {
        while (t > mAudioSourceNode.buffer.duration) {
          t -= mAudioSourceNode.buffer.duration;
        }
        mAudioSourceStartTime = mAudioContext.currentTime - t;
      }
    } else {
      t = 0.0;
      hasAudioEnded = true;
    }

    // Are we past the play range (i.e. stop the follower?)
    if (hasAudioEnded) {
      stopFollower();

      // Reset pattern position
      mPattern.setCursor(mPattern.col(),0);
      mFxTrack.setCursor(0,0);

      return;
    }

    // Calculate current song position
    var n = Math.floor(t * 44100 / mSong.rowLen);
    var seqPos = Math.floor(n / mSong.patternLen) + mFollowerFirstRow;
    var patPos = n % mSong.patternLen;

    // Have we stepped?
    var newSeqPos = (seqPos != mSeq.row());
    var newPatPos = newSeqPos || (patPos != mPattern.row());

    // Update the sequencer
    if (newSeqPos) {
      if (seqPos >= 0) {
        mSeq.setCursor(mSeq.col(),seqPos,true);
      }
      for (var i = 0; i < MAX_SONG_ROWS; ++i) {
        var o = document.getElementById("spr" + i);
        o.className = (i == seqPos ? "playpos" : "");
      }
    }

    // Update the pattern
    if (newPatPos) {
      if (patPos >= 0) {
        mPattern.setCursor(mPattern.col(),patPos);
        mFxTrack.setCursor(mFxTrack.col(),patPos);
      }
      for (var i = 0; i < mSong.patternLen; ++i) {
        var o = document.getElementById("ppr" + i);
        o.className = (i == patPos ? "playpos" : "");
      }
    }

    // Player graphics
    redrawPlayerGfx(t);
  };

  var startFollower = function () {
    // Update the sequencer selection
    mSeq.setCursor(mSeq.col(),mFollowerFirstRow,true);

    // Start the follower
    mFollowerActive = true;
    mFollowerTimerID = setInterval(updateFollower, 16);
  };

  var stopFollower = function ()
  {
    if (mFollowerActive)
    {
      // Stop the follower
      if (mFollowerTimerID !== -1) {
        clearInterval(mFollowerTimerID);
        mFollowerTimerID = -1;
      }

      // Clear the follower markers
      for (var i = 0; i < MAX_SONG_ROWS; ++i) {
        document.getElementById("spr" + i).className = "";
      }
      for (var i = 0; i < mSong.patternLen; ++i) {
        document.getElementById("ppr" + i).className = "";
      }

      // Clear player gfx
      redrawPlayerGfx(-1);

      mFollowerActive = false;
    }
  };

  //----------------------------------------------------------------------------
  // (end of playback follower)
  //----------------------------------------------------------------------------


  var playGeneratedWave = function (wave) {
    var isLooping = document.getElementById("loopPlayback").checked;

    try {
      if (mAudio) {
        // Restart the follower
        startFollower();

        // Load the data into the audio element (it will start playing as soon
        // as the data has been loaded)
        mAudio.src = URL.createObjectURL(new Blob([wave], {type: "audio/wav"}));
        mAudio.loop = isLooping;

        // Hack
        mAudio.play();
        mAudioTimer.reset();
      } else if (mAudioContext) {
        // Decode the WAVE buffer
        mAudioContext.decodeAudioData(wave.buffer,
            function (buffer) {
              try {
                // Stop any previously playing buffer if necessary
                if (mAudioSourceNode) {
                  mAudioSourceNode.stop();
                  mAudioSourceNode.disconnect();
                  mAudioSourceNode = undefined;
                }

                // Create a new source node and start playing it
                mAudioSourceNode = mAudioContext.createBufferSource();
                mAudioSourceNode.buffer = buffer;
                mAudioSourceNode.connect(mAudioContext.destination);
                mAudioSourceNode.loop = isLooping;
                if (!isLooping) {
                  mAudioSourceNode.onended = function (e) {
                    // When the playback has ended, stop everything
                    mAudioSourceNode.disconnect();
                    mAudioSourceNode = undefined;
                    stopFollower();
                  };
                }
                if (mAudioSourceNode.start)
                  mAudioSourceNode.start(0);
                else
                  mAudioSourceNode.noteOn(0);
                mAudioSourceStartTime = mAudioContext.currentTime;

                // Restart the follower
                startFollower();
              } catch (err) {
                alert("Error playing: " + err.message);
              }
            }, function (e) {
              alert("Error decoding audio data: " + e.err);
            }
        );
      } else {
        alert("Audio unavailable.");
      }
    } catch (err) {
      alert("Error playing: " + err.message);
    }
  };

  var playSong = function (e)
  {
    if (!e) var e = window.event;
    e.preventDefault();

    // HACK!
    unlockAudioPlaybackHack();

    // Stop the currently playing audio
    stopAudio();

    // Update song ranges
    updateSongRanges();

    // Select range to play
    mFollowerFirstRow = 0;
    mFollowerLastRow = mSong.endPattern;
    mFollowerFirstCol = 0;
    mFollowerLastCol = 7;

    // Generate audio data
    generateAudio(playGeneratedWave);
  };

  var playRange = function (e)
  {
    if (!e) var e = window.event;
    e.preventDefault();

    // HACK!
    unlockAudioPlaybackHack();

    // Stop the currently playing audio
    stopAudio();

    // Update song ranges
    updateSongRanges();

    // Select range to play
    var opts = {
      firstRow: mSeq.selectionTop(),
      lastRow: mSeq.selectionBottom(),
      firstCol: mSeq.selectionLeft(),
      lastCol: mSeq.selectionRight()
    };
    mFollowerFirstRow = mSeq.selectionTop();
    mFollowerLastRow = mSeq.selectionBottom();
    mFollowerFirstCol = mSeq.selectionLeft();
    mFollowerLastCol = mSeq.selectionRight();

    // Generate audio data
    generateAudio(playGeneratedWave, opts);
  };

  var stopPlaying = function (e)
  {
    if (!e) var e = window.event;
    e.preventDefault();

    stopAudio();
  };

  var displaySongSize = function () {
    updateSongRanges();
    var JS = songToJS(mSong);
    var uncommented = JS.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
    var whitespaceRemoved = uncommented.replace(/\s/g, '');
    var status = "JavaScript: " + whitespaceRemoved.length + " bytes";
    var compressed = RawDeflate.deflate(whitespaceRemoved, 8);
    status += "<br />Compressed JS: " + compressed.length + " bytes";
    setStatus(status);
  };

  var stopDisplayingSize = function ()
  {
    if (mDisplaySizeTimer) {
      clearInterval(mDisplaySizeTimer);
      setStatus("");
    }
    mDisplaySizeTimer = undefined;
  };

  var startDisplayingSize = function ()
  {
    stopDisplayingSize();
    displaySongSize();
    mDisplaySizeTimer = setInterval(function() {
      if (!isPLaying()) {
        displaySongSize();
      }
    }, 2000);
  };

  var displaySizeOnChange = function (e)
  {
    if (!e) var e = window.event;
    var isDisplaySizeChecked = document.getElementById("displaySize").checked;
    if (isDisplaySizeChecked) {
      startDisplayingSize();
    } else {
      stopDisplayingSize();
    }
  };

  var bpmFocus = function (e) {
    setEditMode(EDIT_NONE);
    return true;
  };

  var rppFocus = function (e) {
    setEditMode(EDIT_NONE);
    return true;
  };

  var instrPresetFocus = function (e) {
    setEditMode(EDIT_NONE);
    return true;
  };

  var instrCopyClick = function (e) {
    if (!e) var e = window.event;
    e.preventDefault();

    mInstrCopyBuffer = [];
    var instr = mSong.songData[mSeq.col()];
    for (var i = 0; i <= instr.i.length; ++i)
      mInstrCopyBuffer[i] = instr.i[i];
  };

  var instrPasteClick = function (e) {
    if (!e) var e = window.event;
    e.preventDefault();

    if (mInstrCopyBuffer.length > 0) {
      var instr = mSong.songData[mSeq.col()];
      instr.i = [];
      for (var i = 0; i <= mInstrCopyBuffer.length; ++i)
        instr.i[i] = mInstrCopyBuffer[i];
    }
    updateInstrument(true);
  };

  var instrSaveClick = function (e) {
    if (!e) var e = window.event;
    e.preventDefault();

    var instrI = mSong.songData[mSeq.col()].i;
    var dataURI = "data:application/octet-stream;base64," + btoa(instrumentToBin(instrI));
    window.open(dataURI);
  };

  var boxMouseDown = function (e) {
    if (!e) var e = window.event;
    var o = getEventElement(e);

    // Check which instrument parameter was changed
    var fxCmd = -1;
    if (o.id === "lfo_fxfreq")
      fxCmd = LFO_FX_FREQ;

    // Update the instrument (toggle boolean)
    var fxValue;
    if (fxCmd >= 0) {
      fxValue = mSong.songData[mSeq.col()].i[fxCmd] ? 0 : 1;
      mSong.songData[mSeq.col()].i[fxCmd] = fxValue;
    }

    // Edit the fx track
    if (mEditMode == EDIT_FXTRACK && fxCmd) {
      mFxTrack.setCurrent([fxCmd + 1,fxValue]);
    }

    updateInstrument(true);
    unfocusHTMLInputElements();
    e.preventDefault();
  };

  var osc1WaveMouseDown = function (e) {
    if (!e) var e = window.event;
    var o = getEventElement(e);
    var wave = 0;
    if (o.id === "osc1_wave_sin") wave = 0;
    else if (o.id === "osc1_wave_sqr") wave = 1;
    else if (o.id === "osc1_wave_saw") wave = 2;
    else if (o.id === "osc1_wave_tri") wave = 3;
    if (mEditMode == EDIT_FXTRACK)
      mFxTrack.setCurrent([OSC1_WAVEFORM + 1,wave]);
    mSong.songData[mSeq.col()].i[OSC1_WAVEFORM] = wave;
    updateInstrument();
    unfocusHTMLInputElements();
    e.preventDefault();
  };

  var osc2WaveMouseDown = function (e) {
    if (!e) var e = window.event;
    var o = getEventElement(e);
    var wave = 0;
    if (o.id === "osc2_wave_sin") wave = 0;
    else if (o.id === "osc2_wave_sqr") wave = 1;
    else if (o.id === "osc2_wave_saw") wave = 2;
    else if (o.id === "osc2_wave_tri") wave = 3;
    if (mEditMode == EDIT_FXTRACK)
      mFxTrack.setCurrent([OSC2_WAVEFORM + 1,wave]);
    mSong.songData[mSeq.col()].i[OSC2_WAVEFORM] = wave;
    updateInstrument(true);
    unfocusHTMLInputElements();
    e.preventDefault();
  };

  var lfoWaveMouseDown = function (e) {
    if (!e) var e = window.event;
    var o = getEventElement(e);
    var wave = 0;
    if (o.id === "lfo_wave_sin") wave = 0;
    else if (o.id === "lfo_wave_sqr") wave = 1;
    else if (o.id === "lfo_wave_saw") wave = 2;
    else if (o.id === "lfo_wave_tri") wave = 3;
    if (mEditMode == EDIT_FXTRACK)
      mFxTrack.setCurrent([LFO_WAVEFORM + 1,wave]);
    mSong.songData[mSeq.col()].i[LFO_WAVEFORM] = wave;
    updateInstrument(true);
    unfocusHTMLInputElements();
    e.preventDefault();
  };

  var fxFiltMouseDown = function (e) {
    if (!e) var e = window.event;
    var o = getEventElement(e);
    var filt = 2;
    if (o.id === "fx_filt_hp") filt = 1;
    else if (o.id === "fx_filt_lp") filt = 2;
    else if (o.id === "fx_filt_bp") filt = 3;
    if (mEditMode == EDIT_FXTRACK)
      mFxTrack.setCurrent([FX_FILTER + 1,filt]);
    mSong.songData[mSeq.col()].i[FX_FILTER] = filt;
    updateInstrument(true);
    unfocusHTMLInputElements();
    e.preventDefault();
  };

  var octaveUp = function (e)
  {
    if (!e) var e = window.event;
    e.preventDefault();

    if (mKeyboardOctave < 8)
    {
      mKeyboardOctave++;
      document.getElementById("keyboardOctave").innerHTML = "" + mKeyboardOctave;
    }
  };

  var octaveDown = function (e)
  {
    if (!e) var e = window.event;
    e.preventDefault();

    if (mKeyboardOctave > 1)
    {
      mKeyboardOctave--;
      document.getElementById("keyboardOctave").innerHTML = "" + mKeyboardOctave;
    }
  };

  var selectPreset = function (e)
  {
    if (!e) var e = window.event;
    var o = getEventElement(e);
    var val = o.options[o.selectedIndex].value;
    if (val !== "")
    {
      val = parseInt(val);
      if (val)
      {
        // Clone instrument settings
        var src = gInstrumentPresets[val];
        for (var i = 0; i < src.i.length; ++i)
          mSong.songData[mSeq.col()].i[i] = src.i[i];

        updateInstrument(false);
        e.preventDefault();
      }
    }
  };

  var presetOnKeyDown = function (e)
  {
    // ignore all keys to avoid accidentally overwriting current instrument with preset
    if (!e) var e = window.event;
    e.returnValue = false;
    e.cancel = true;
  }

  var keyboardMouseDown = function (e)
  {
    if (!e) var e = window.event;
    var p = getMousePos(e, true);

    // Calculate keyboard position
    var n = 0;
    if (p[1] < 68) {
      // Possible black key
      for (var i = 0; i < mBlackKeyPos.length; i += 2) {
        if (p[0] >= (mBlackKeyPos[i] - 10) &&
            p[0] <= (mBlackKeyPos[i] + 10)) {
          n = mBlackKeyPos[i + 1];
          break;
        }
      }
    }
    if (!n) {
      // Must be a white key
      n = Math.floor((p[0] * 14) / 420) * 2;
      var comp = 0;
      if (n >= 20) comp++;
      if (n >= 14) comp++;
      if (n >= 6) comp++;
      n -= comp;
    }

    // Play the note
    if (playNote(n + mKeyboardOctave * 12)) {
      e.preventDefault();
    }
  };

  var getCellCoord = function (element)
  {
    var rowSplit = element.id.indexOf('r', 2);
    return {
      col: parseInt(element.id.slice(2, rowSplit)),
      row: parseInt(element.id.slice(rowSplit + 1))
    };
  };

  var fxTrackMouseDown = function (e)
  {
    if (!e) var e = window.event;
    e.preventDefault();

    if (!mFollowerActive)
    {
      var o = getEventElement(e);
      mFxTrack.setCursor(0,getCellCoord(o).row);
      mSelectingFxRange = true;
    }
    setEditMode(EDIT_FXTRACK);
  };

  var fxTrackMouseOver = function (e)
  {
    if (mSelectingFxRange)
    {
      if (!e) var e = window.event;
      var o = getEventElement(e);
      mFxTrack.setSelectionCorner(0,getCellCoord(o).row);
      e.preventDefault();
    }
  };

  var fxTrackMouseUp = function (e)
  {
    if (mSelectingFxRange)
    {
      if (!e) var e = window.event;
      var o = getEventElement(e);
      mFxTrack.setSelectionCorner(0,getCellCoord(o).row);
      mSelectingFxRange = false;
      e.preventDefault();
    }
  };

  var patternMouseDown = function (e)
  {
    if (!e) var e = window.event;
    e.preventDefault();

    if (!mFollowerActive)
    {
      var o = getEventElement(e);
      var coord = getCellCoord(o);
      mPattern.setCursor(coord.col, coord.row);
      mSelectingPatternRange = true;
    }
    setEditMode(EDIT_PATTERN);
  };

  var patternMouseOver = function (e)
  {
    if (mSelectingPatternRange)
    {
      if (!e) var e = window.event;
      var o = getEventElement(e);
      var coord = getCellCoord(o);
      mPattern.setSelectionCorner(coord.col, coord.row);
      e.preventDefault();
    }
  };

  var patternMouseUp = function (e)
  {
    if (mSelectingPatternRange)
    {
      if (!e) var e = window.event;
      var o = getEventElement(e);
      var coord = getCellCoord(o);
      mPattern.setSelectionCorner(coord.col, coord.row);
      mSelectingPatternRange = false;
      e.preventDefault();
    }
  };

  var sequencerMouseDown = function (e)
  {
    if (!e) var e = window.event;
    var o = getEventElement(e);
    var coord = getCellCoord(o);
    var col = coord.col;
    var row = mFollowerActive ? mSeq.row() : coord.row;
    var newChannel = col != mSeq.col();
    mSeq.setCursor(col, row);
    if (!mFollowerActive)
      mSelectingSeqRange = true;
    setEditMode(EDIT_SEQUENCE);
    e.preventDefault();
  };

  var sequencerMouseOver = function (e)
  {
    if (mSelectingSeqRange)
    {
      if (!e) var e = window.event;
      var o = getEventElement(e);
      var coord = getCellCoord(o);
      mSeq.setSelectionCorner(coord.col, coord.row);
      e.preventDefault();
    }
  };

  var sequencerMouseUp = function (e)
  {
    if (mSelectingSeqRange)
    {
      if (!e) var e = window.event;
      var o = getEventElement(e);
      var coord = getCellCoord(o);
      mSeq.setSelectionCorner(coord.col, coord.row);
      mSelectingSeqRange = false;
      e.preventDefault();
    }
  };

  var mActiveSlider = null;

  var sliderMouseDown = function (e)
  {
    if (!e) var e = window.event;
    mActiveSlider = getEventElement(e);
    unfocusHTMLInputElements();
    e.preventDefault();
    var valuetips = mActiveSlider.parentElement.getElementsByClassName("valuetip");
    if (valuetips.length > 0)
      valuetips[0].style.visibility = "visible";
  };

  var mouseMove = function (e) {
    if (!e) var e = window.event;

    // Handle slider?
    if (mActiveSlider) {
      var instr = mSong.songData[mSeq.col()];

      // Calculate slider position
      var pos = getMousePos(e, false);
      var origin = getElementPos(mActiveSlider.parentNode);
      var x = pos[0] - 6 - origin[0];
      x = x < 0 ? 0 : (x > 191 ? 1 : (x / 191));

      // Adapt to the range of the slider
      if (mActiveSlider.sliderProps.nonLinear)
        x = x * x;
      var min = mActiveSlider.sliderProps.min;
      var max = mActiveSlider.sliderProps.max;
      x = Math.round(min + ((max - min) * x));

      // Update the slider position
      updateSlider(mActiveSlider, x);
      clearPresetSelection();

      // Check which instrument property to update
      var cmdNo = -1;
      if (mActiveSlider.id == "osc1_vol")         cmdNo = OSC1_VOL;
      else if (mActiveSlider.id == "osc1_semi")   cmdNo = OSC1_SEMI;
      else if (mActiveSlider.id == "osc1_xenv")   cmdNo = OSC1_XENV;
      else if (mActiveSlider.id == "osc2_vol")    cmdNo = OSC2_VOL;
      else if (mActiveSlider.id == "osc2_semi")   cmdNo = OSC2_SEMI;
      else if (mActiveSlider.id == "osc2_det")    cmdNo = OSC2_DETUNE;
      else if (mActiveSlider.id == "osc2_xenv")   cmdNo = OSC2_XENV;
      else if (mActiveSlider.id == "noise_vol")   cmdNo = NOISE_VOL;
      else if (mActiveSlider.id == "env_att")     cmdNo = ENV_ATTACK;
      else if (mActiveSlider.id == "env_sust")    cmdNo = ENV_SUSTAIN;
      else if (mActiveSlider.id == "env_rel")     cmdNo = ENV_RELEASE;
      else if (mActiveSlider.id == "env_decay")   cmdNo = ENV_EXP_DECAY;
      else if (mActiveSlider.id == "arp_note1")   cmdNo = ARP_CHORD;
      else if (mActiveSlider.id == "arp_note2")   cmdNo = ARP_CHORD;
      else if (mActiveSlider.id == "arp_speed")   cmdNo = ARP_SPEED;
      else if (mActiveSlider.id == "lfo_amt")     cmdNo = LFO_AMT;
      else if (mActiveSlider.id == "lfo_freq")    cmdNo = LFO_FREQ;
      else if (mActiveSlider.id == "fx_freq")     cmdNo = FX_FREQ;
      else if (mActiveSlider.id == "fx_res")      cmdNo = FX_RESONANCE;
      else if (mActiveSlider.id == "fx_dist")     cmdNo = FX_DIST;
      else if (mActiveSlider.id == "fx_drive")    cmdNo = FX_DRIVE;
      else if (mActiveSlider.id == "fx_pan_amt")  cmdNo = FX_PAN_AMT;
      else if (mActiveSlider.id == "fx_pan_freq") cmdNo = FX_PAN_FREQ;
      else if (mActiveSlider.id == "fx_dly_amt")  cmdNo = FX_DELAY_AMT;
      else if (mActiveSlider.id == "fx_dly_time") cmdNo = FX_DELAY_TIME;

      // The arpeggio chord notes are combined into a single byte
      if (cmdNo === ARP_CHORD) {
        if (mActiveSlider.id == "arp_note1")
          x = (instr.i[ARP_CHORD] & 15) | (x << 4);
        else
          x = (instr.i[ARP_CHORD] & 240) | x;
      }

      if (mEditMode == EDIT_FXTRACK) {
        // Update the effect command in the FX track
        mFxTrack.setCurrent([cmdNo+1,x]);
      }

      // Update the instrument property
      if (cmdNo >= 0)
        instr.i[cmdNo] = x;

      // Update the jammer instrument
      mJammer.updateInstr(instr.i);

      e.preventDefault();
    }
  };

  var mouseUp = function (e)
  {
    if (mActiveSlider)
    {
      var valuetips = mActiveSlider.parentElement.getElementsByClassName('valuetip');
      if (valuetips.length > 0 && !mActiveSlider.parentElement.mouseIsOver)
        valuetips[0].style.visibility = "hidden";
      mActiveSlider = null;
      return false;
    }
    return true;
  };

  var keyDown = function (e) {
    if (!e) var e = window.event;

    // Check if we're editing BPM / RPP
    var editingBpmRpp =
        document.activeElement === document.getElementById("bpm") ||
        document.activeElement === document.getElementById("rpp");

    var tableEditor = mEditMode == EDIT_SEQUENCE ? mSeq :
              mEditMode == EDIT_PATTERN ? mPattern :
              mEditMode == EDIT_FXTRACK ? mFxTrack :
              undefined;

    var row, col, n;

    // Non-function keys.
    if (e.key && !editingBpmRpp) {
      switch (e.key) {
        case "<":
          octaveDown(e);
          return false;

        case ">":
          octaveUp(e);
          return false;

        default:
          // console.log("onkeydown: keyCode=" + e.keyCode + " key=" + e.key);
          break;
      }
    }

    if (tableEditor && e.ctrlKey && e.keyCode == 67)
    {
      tableEditor.copy();
      return false;
    }

    if (tableEditor && e.ctrlKey && e.keyCode == 86)
    {
      tableEditor.paste();
      return false;
    }

    // Sequencer editing
    if (mEditMode == EDIT_SEQUENCE)
    {
      var patternCode = undefined;
      // 0 - 9
      if (e.keyCode >= 48 && e.keyCode <= 57)
        patternCode = e.keyCode - 47;

      // A - Z
      if (e.keyCode >= 64 && e.keyCode <= 90)
        patternCode = e.keyCode - 54;

      if (patternCode) {
        mSeq.setCurrent(patternCode);

        // if shift is pressed, advance one row
        if (e.shiftKey)
          mSeq.setCursor(mSeq.col(), (mSeq.row() + 1) % MAX_SONG_ROWS);

        return false;
      }
    }

    // Emulate a piano through keyboard input.
    if (mEditMode != EDIT_SEQUENCE && !editingBpmRpp) {
      n = -1;
      switch (e.keyCode)
      {
        // First octave on the ZXCVB... row
        case 90: n = 0; break;
        case 83: n = 1; break;
        case 88: n = 2; break;
        case 68: n = 3; break;
        case 67: n = 4; break;
        case 86: n = 5; break;
        case 71: n = 6; break;
        case 66: n = 7; break;
        case 72: n = 8; break;
        case 78: n = 9; break;
        case 74: n = 10; break;
        case 77: n = 11; break;
        // "Bonus keys" 1 (extensions of first octave into second octave)
        case 188: n = 12; break;
        case 76: n = 13; break;
        case 190: n = 14; break;
        case 186: n = 15; break;
        case 191: n = 16; break;
        // Second octave on the QWERTY... row
        case 81: n = 12; break;
        case 50: n = 13; break;
        case 87: n = 14; break;
        case 51: n = 15; break;
        case 69: n = 16; break;
        case 82: n = 17; break;
        case 53: n = 18; break;
        case 84: n = 19; break;
        case 54: n = 20; break;
        case 89: n = 21; break;
        case 55: n = 22; break;
        case 85: n = 23; break;
        // "Bonus keys" 2 (extensions of second octave into third octave)
        case 73: n = 24; break;
        case 57: n = 25; break;
        case 79: n = 26; break;
        case 48: n = 27; break;
        case 80: n = 28; break;
      }
      if (n >= 0)
      {
        if (playNote(n + mKeyboardOctave * 12))
        {
          return false;
        }
      }
    }

    if (tableEditor) {
      if (e.shiftKey) {
        if (e.altKey) {
          var col = tableEditor.selectionCol2();
          var row = tableEditor.selectionRow2();
        } else {
          var col = tableEditor.selectionCol1();
          var row = tableEditor.selectionRow1();
        }
      } else {
        var col = tableEditor.col();
        var row = tableEditor.row();
      }
      var oldCol = col;
      var oldRow = row;
      switch (e.keyCode) {
        case 39:  // RIGHT
          if (e.ctrlKey)
            col = tableEditor.numcols()-1;
          else
            col = col + 1;
          break;
        case 37:  // LEFT
          if (e.ctrlKey)
            col = 0;
          else
            col = col-1;
          break;
        case 40:  // DOWN
          if (e.ctrlKey)
            row = tableEditor.numrows()-1;
          else
            row = row+1;
          break;
        case 38:  // UP
          if (e.ctrlKey)
            row = 0;
          else
            row = row-1;
          break;
        case 36:  // HOME
          row = 0;
          break;
        case 35:  // END
          row = tableEditor.numrows()-1;
          break;
        case 8:   // BACKSPACE (Mac delete)
        case 46:  // DELETE
          var emptyCell = mEditMode == EDIT_FXTRACK ? [0,0] : 0;
          tableEditor.modifySelection(function (value) { return emptyCell; });
          if (tableEditor.isSingleSelected())
            row = row + 1;
          break;
      }
      if (oldRow != row || oldCol != col) {
        col = (col + tableEditor.numcols()) % tableEditor.numcols();
        row = (row + tableEditor.numrows()) % tableEditor.numrows();
        if (e.shiftKey) {
          if (e.altKey)
            tableEditor.setSelectionCorner2(col,row)
          else
            tableEditor.setSelectionCorner(col,row);
        } else {
          tableEditor.setCursor(col,row);
        }
        return false;
      }
    }

    // The rest of the key presses...
    switch (e.keyCode)
    {
      case 9: // TAB
        if (e.shiftKey)
          setEditMode(mEditMode == EDIT_SEQUENCE ? EDIT_FXTRACK :
                      mEditMode == EDIT_PATTERN ? EDIT_SEQUENCE :
                      mEditMode == EDIT_FXTRACK ? EDIT_PATTERN :
                      EDIT_FXTRACK);
        else
          setEditMode(mEditMode == EDIT_SEQUENCE ? EDIT_PATTERN :
                      mEditMode == EDIT_PATTERN ? EDIT_FXTRACK :
                      mEditMode == EDIT_FXTRACK ? EDIT_SEQUENCE :
                      EDIT_SEQUENCE);
        return false;

      case 32: // SPACE
        if (mEditMode != EDIT_NONE)
        {
          if (isPLaying())
            stopAudio();
          else
            playRange(e);
          return false;
        }
        break;

      case 13:  // ENTER / RETURN
        if (editingBpmRpp) {
          updateSongSpeed();
          updatePatternLength();
          document.getElementById("bpm").blur();
          document.getElementById("rpp").blur();
        } else if (mEditMode == EDIT_SEQUENCE)
          fillSequenceRange();
        else if (mEditMode == EDIT_FXTRACK)
          fillFxRange();
        else if (mEditMode == EDIT_PATTERN)
          fillPatternRange();
        break;
    }

    return true;
  };

  // This function tries to automatically fill the currently
  // selected range in the sequencer. If there's only one value
  // at top, it repeats it. If there's two, it tries to create
  // an increasing or decreasing sequence e.g. [1 2 0 0 0 0]
  // becomes [1 2 3 4 5 6]. Three or more patterns are looped e.g.
  // [1 2 1 2 0 0 0 0] becomes [1 2 1 2 1 2 1 2]
  var fillSequenceRange = function()
  {
    if (mSeq.selectionBottom() <= mSeq.selectionTop())
      return;
    // checks if the condition holds for any value between first and last, inclusive
    // find the lastrow that is not all empty
    outer:
    for (var lastRow = mSeq.selectionBottom(); lastRow > mSeq.selectionTop(); --lastRow) {
      for (var col = mSeq.selectionLeft();col <= mSeq.selectionRight();++col)
        if (mSeq.get(col,lastRow) > 0)
          break outer;
    }
    var firstRowHasEmpty = false;
    for (var col = mSeq.selectionLeft();col <= mSeq.selectionRight();++col)
      if (!mSeq.get(col,mSeq.selectionTop())) {
        firstRowHasEmpty = true;
        break;
      }
    if (lastRow - mSeq.selectionTop() >= 2 || firstRowHasEmpty) {
      // we have 3 or more rows of patterns or the first row has empty cells
      // loop the cells
      var loopLength = lastRow-mSeq.selectionTop()+1;
      mSeq.repeatSelection(loopLength);
    } else {
      // we have zero to two rows, try to repeate or extrapolate values
      mSeq.suppressUpdate();
      mSeq.forSelection(function (col,row) {
        var start = mSeq.get(col,mSeq.selectionTop());
        var next = mSeq.get(col,mSeq.selectionTop()+1);
        var delta = !next ? 0 : next - start;
        var extrapolated = delta * (row-mSeq.selectionTop())+start;
        mSeq.set(col,row,Math.max(Math.min(extrapolated,MAX_PATTERNS),1));
      });
      mSeq.resumeUpdate();
    }
  }

  // This function interpolates the effect parameters
  // between two values. The two commands have to be the same
  // and the cells between them empty.
  var fillFxRange = function()
  {
    if (mFxTrack.selectionBottom() <= mFxTrack.selectionTop()+1)
      return;
    var cmd1 = mFxTrack.get(0,mFxTrack.selectionTop())[0];
    var cmd2 = mFxTrack.get(0,mFxTrack.selectionBottom())[0];
    if (cmd1 != cmd2)
      return;
    for (var row = mFxTrack.selectionTop()+1; row < mFxTrack.selectionBottom(); ++row)
      if (mFxTrack.get(0,row)[0])
        return;
    var val1 = mFxTrack.get(0,mFxTrack.selectionTop())[1];
    var val2 = mFxTrack.get(0,mFxTrack.selectionBottom())[1];
    mFxTrack.suppressUpdate();
    for (var row = mFxTrack.selectionTop()+1; row < mFxTrack.selectionBottom(); ++row)
    {
      var alpha = (row - mFxTrack.selectionTop())/(mFxTrack.selectionBottom()- mFxTrack.selectionTop())*1.0;
      var roundedValue = ((alpha * val2 + (1 - alpha) * val1)+.5)|0;
      mFxTrack.set(0,row,[cmd1,roundedValue]);
    }
    mFxTrack.resumeUpdate();
  }

  // This function loops the notes in the selected pattern
  // e.g. [C#5 F#5 0 0 0 0] becomes [C#5 F#5 C#5 F#5 C#5 F#5]
  var fillPatternRange = function()
  {
    if (mPattern.selectionBottom() <= mPattern.selectionTop())
      return;
    var patternLen = mSong.patternLen;
    // find the last row that is not all empty
    outer:
    for (var lastRow = mPattern.selectionBottom(); lastRow > mPattern.selectionTop(); --lastRow) {
      for (var col = mPattern.selectionLeft();col <= mPattern.selectionRight();++col)
        if (mPattern.get(col,lastRow))
          break outer;
    }
    var loopLength = lastRow-mPattern.selectionTop()+1;
    mPattern.repeatSelection(loopLength);
  }

  var onFileDrop = function (e) {
    e.stopPropagation();
    e.preventDefault();

    // Get the dropped file
    var files = e.dataTransfer.files;
    if (files.length != 1) {
      alert("Only open one file at a time.");
      return;
    }
    var file = files[0];

    // Load the file into the editor
    var reader = new FileReader();
    reader.onload = function(e) {
      var data = getURLSongData(e.target.result);
      // try first loading the file as a song
      var success = loadSongFromData(data);
      if (!success) // if it is not a song, maybe its an instrument
        success = loadInstrumentFromData(data);
      if (!success)
        alert("Binary format not recognized.");
    };
    reader.readAsDataURL(file);
  };

  var activateMasterEvents = function ()
  {
    // Set up the master mouse event handlers
    document.onmousedown = null;
    document.addEventListener("mousemove", mouseMove, false);
    document.addEventListener("touchmove", mouseMove, false);
    document.addEventListener("mouseup", mouseUp, false);
    document.addEventListener("touchend", mouseUp, false);

    // Set up the master key event handler
    document.onkeydown = keyDown;

    // Set up the drag'n'drop handler
    var dropElement = document.body.parentNode;
    dropElement.addEventListener("dragenter", function dragenter(e) { e.stopPropagation(); e.preventDefault(); }, false);
    dropElement.addEventListener("dragover", function dragenter(e) { e.stopPropagation(); e.preventDefault(); }, false);
    dropElement.addEventListener("drop", onFileDrop, false);
  };

  var deactivateMasterEvents = function ()
  {
    // Set up the master mouse event handlers
    document.onmousedown = function () { return true; };
    document.onmousemove = null;
    document.onmouseup = null;

    // Set up the master key event handler
    document.onkeydown = null;
  };

  var buildSequencerTable = function () {
    var table = document.getElementById("sequencer-table");
    var tr, th, td;
    for (var row = 0; row < MAX_SONG_ROWS; row++) {
      tr = document.createElement("tr");
      if (row % 4 === 0)
        tr.className = "beat";
      th = document.createElement("th");
      th.id = "spr" + row;
      th.textContent = "" + row;
      tr.appendChild(th);
      for (col = 0; col < MAX_CHANNELS; col++) {
        td = document.createElement("td");
        td.id = "sc" + col + "r" + row;
        td.textContent = " ";
        td.addEventListener("mousedown", sequencerMouseDown, false);
        td.addEventListener("mouseover", sequencerMouseOver, false);
        td.addEventListener("mouseup", sequencerMouseUp, false);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
  };

  var getCurrentBeatDistance = function (table) {
    var beatDistance = 1;
    while (beatDistance < table.children.length) {
      if (table.children[beatDistance].className === "beat")
        break;
      beatDistance++;
    }
    return beatDistance;
  };

  var getBeatDistance = function () {
    var bpm = getBPM();
    var beatDistance = 4;
    if (mSong.patternLen % 3 === 0)
      beatDistance = 3;
    else if (mSong.patternLen % 4 === 0)
      beatDistance = 4;
    else if (mSong.patternLen % 2 === 0)
      beatDistance = 2;
    else if (mSong.patternLen % 5 === 0)
      beatDistance = 5;
    if ((bpm / beatDistance) >= 40 && mSong.patternLen > 24 && (mSong.patternLen % (beatDistance * 2) === 0))
      beatDistance *= 2;

    return beatDistance;
  };

  var buildPatternTable = function () {
    var beatDistance = getBeatDistance();
    var table = document.getElementById("pattern-table");
    if (table.children.length === mSong.patternLen && getCurrentBeatDistance(table) === beatDistance)
      return;
    while (table.firstChild)
      table.removeChild(table.firstChild);
    var tr, th, td;
    for (var row = 0; row < mSong.patternLen; row++) {
      tr = document.createElement("tr");
      if (row % beatDistance === 0)
        tr.className = "beat";
      th = document.createElement("th");
      th.id = "ppr" + row;
      th.textContent = "" + row;
      tr.appendChild(th);
      for (col = 0; col < 4; col++) {
        td = document.createElement("td");
        td.id = "pc" + col + "r" + row;
        td.textContent = " ";
        td.addEventListener("mousedown", patternMouseDown, false);
        td.addEventListener("mouseover", patternMouseOver, false);
        td.addEventListener("mouseup", patternMouseUp, false);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
  };

  var buildFxTable = function () {
    var beatDistance = getBeatDistance();
    var table = document.getElementById("fxtrack-table");
    if (table.children.length === mSong.patternLen && getCurrentBeatDistance(table) === beatDistance)
      return;
    while (table.firstChild)
      table.removeChild(table.firstChild);
    var tr, td;
    for (var row = 0; row < mSong.patternLen; row++) {
      tr = document.createElement("tr");
      if (row % beatDistance === 0)
        tr.className = "beat";
      td = document.createElement("td");
      td.id = "fxr" + row;
      td.textContent = String.fromCharCode(160);  // &nbsp;
      td.addEventListener("mousedown", fxTrackMouseDown, false);
      td.addEventListener("mouseover", fxTrackMouseOver, false);
      td.addEventListener("mouseup", fxTrackMouseUp, false);
      tr.appendChild(td);
      table.appendChild(tr);
    }
  };

  var canPlayDataUri = function () {
    // Most mobile browsers have problems with data URI:s. To my knowledge, the
    // only major mobile browser that can play data URI:s properly is Firefox
    // for Android.
    var userAgent = window.navigator.userAgent;
    var isMobile = userAgent.match(/Mobile/) || userAgent.match(/Tablet/);
    var isFF = userAgent.match(/Firefox/)
    return isFF || !isMobile;
  };

  var unlockAudioPlaybackHack = function () {
    if (mPlaybackUnlocked) {
      return;
    }

    if (mAudioContext) {
      // Play an empty sound on the audio context - this is a hack to enable
      // the element while we're still part of a user interaction (iOS only).
      var dummySource = mAudioContext.createBufferSource();
      dummySource.buffer = mAudioContext.createBuffer(1, 1, 22050);;
      dummySource.connect(mAudioContext.destination);
      if (dummySource.start)
        dummySource.start(0);
      else
        dummySource.noteOn(0);
    }

    mPlaybackUnlocked = true;
  };


  //--------------------------------------------------------------------------
  // Initialization
  //--------------------------------------------------------------------------

  this.init = function ()
  {
    var i, j, o;

    // Parse URL
    mBaseURL = getURLBase(window.location.href);
    mGETParams = parseURLGetData(window.location.href);

    // Preload images
    preloadImage("gui/progress.gif");
    preloadImage("gui/box-uncheck.png");
    preloadImage("gui/box-uncheck.png");
    preloadImage("gui/wave-sin.png");
    preloadImage("gui/wave-sin-sel.png");
    preloadImage("gui/wave-saw.png");
    preloadImage("gui/wave-saw-sel.png");
    preloadImage("gui/wave-sqr.png");
    preloadImage("gui/wave-sqr-sel.png");
    preloadImage("gui/wave-tri.png");
    preloadImage("gui/wave-tri-sel.png");
    preloadImage("gui/filt-lp.png");
    preloadImage("gui/filt-lp-sel.png");
    preloadImage("gui/filt-hp.png");
    preloadImage("gui/filt-hp-sel.png");
    preloadImage("gui/filt-bp.png");
    preloadImage("gui/filt-bp-sel.png");
    preloadImage("gui/filt-n.png");
    preloadImage("gui/filt-n-sel.png");

    // Set up presets
    initPresets();

    // Load images for the play graphics canvas
    mPlayGfxVUImg.onload = function () {
      redrawPlayerGfx(-1);
    };
    mPlayGfxLedOffImg.onload = function () {
      redrawPlayerGfx(-1);
    };
    mPlayGfxVUImg.src = "gui/playGfxBg.png";
    mPlayGfxLedOffImg.src = "gui/led-off.png";
    mPlayGfxLedOnImg.src = "gui/led-on.png";

    // Build the UI tables
    buildSequencerTable();

    // Add tooltips for each slider
    var sliders = document.getElementsByClassName('slider');
    var sliderDivs = Array.prototype.filter.call(sliders, function(e) {
      return e.nodeName === 'DIV';
    });
    for (var i=0; i<sliderDivs.length; i++) {
      var valuetip = document.createElement("span");
      valuetip.className = "valuetip";
      sliderDivs[i].appendChild(valuetip);
      sliderDivs[i].onmouseenter = function(e) {
        if (!e) var e = window.event;
        e.preventDefault();
        var o = getEventElement(e);
        o.mouseIsOver = true;
        var valuetips = o.getElementsByClassName("valuetip");
        if (valuetips.length > 0) {
          var delay = setTimeout(function() {
            if (mActiveSlider == null)
              valuetips[0].style.visibility = "visible";
          },500);
          o.onmouseleave = function() {
            clearTimeout(delay);
            o.mouseIsOver = false;
            if (mActiveSlider != o.getElementsByTagName("img")[0])
              valuetips[0].style.visibility = "hidden";
          };
        }
      }
    }

    // Set up GUI elements
    document.getElementById("osc1_vol").sliderProps = { min: 0, max: 255 };
    document.getElementById("osc1_semi").sliderProps = { min: 92, max: 164 };
    document.getElementById("osc1_xenv").sliderProps = { min: 0, max: 255 };
    document.getElementById("osc2_vol").sliderProps = { min: 0, max: 255 };
    document.getElementById("osc2_semi").sliderProps = { min: 92, max: 164 };
    document.getElementById("osc2_det").sliderProps = { min: 0, max: 255, nonLinear: true };
    document.getElementById("osc2_xenv").sliderProps = { min: 0, max: 255 };
    document.getElementById("noise_vol").sliderProps = { min: 0, max: 255 };
    document.getElementById("env_att").sliderProps = { min: 0, max: 255 };
    document.getElementById("env_sust").sliderProps = { min: 0, max: 255 };
    document.getElementById("env_rel").sliderProps = { min: 0, max: 255 };
    document.getElementById("env_decay").sliderProps = { min: 0, max: 255 };
    document.getElementById("arp_note1").sliderProps = { min: 0, max: 12 };
    document.getElementById("arp_note2").sliderProps = { min: 0, max: 12 };
    document.getElementById("arp_speed").sliderProps = { min: 0, max: 7 };
    document.getElementById("lfo_amt").sliderProps = { min: 0, max: 255 };
    document.getElementById("lfo_freq").sliderProps = { min: 0, max: 16 };
    document.getElementById("fx_freq").sliderProps = { min: 0, max: 255, nonLinear: true };
    document.getElementById("fx_res").sliderProps = { min: 0, max: 254 };
    document.getElementById("fx_dly_amt").sliderProps = { min: 0, max: 255 };
    document.getElementById("fx_dly_time").sliderProps = { min: 0, max: 16 };
    document.getElementById("fx_pan_amt").sliderProps = { min: 0, max: 255 };
    document.getElementById("fx_pan_freq").sliderProps = { min: 0, max: 16 };
    document.getElementById("fx_dist").sliderProps = { min: 0, max: 255, nonLinear: true };
    document.getElementById("fx_drive").sliderProps = { min: 0, max: 255 };

    mAudio = undefined;
    mAudioContext = undefined;
    mPlaybackUnlocked = false;

    // We prefer WebAudio over HTMLAudioElement.
    if (window.AudioContext) {
      mAudioContext = new AudioContext();
    } else if (window.webkitAudioContext) {
      mAudioContext = new webkitAudioContext();
    }

    // If we can't do WebAudio, use an HTMLAudioElement instead.
    if (!mAudioContext && canPlayDataUri()) {
      try {
        mAudio = new Audio();
        mAudioTimer.setAudioElement(mAudio);

        // Play the audio as soon as it's ready - this is a hack to enable the
        // element while we're still part of a user interaction.
        mAudio.addEventListener("canplay", function () { this.play(); }, true);
      } catch (err) {
        mAudio = undefined;
      }
    }

    if (mAudio) {
      setStatus("Using Audio element playback");
    } else if (mAudioContext) {
      setStatus("Using WebAudio playback");
    } else {
      setStatus("No audio playback possible!");
    }

    // Load the song
    var songData = getURLSongData(mGETParams && mGETParams.data && mGETParams.data[0]);
    var song = songData ? binToSong(songData) : null;
    mSong = song ? song : makeNewSong();
    mSongUnmodified = deepCopy(mSong);

    buildPatternTable();
    buildFxTable();

    // Update UI according to the loaded song
    updateSongInfo();
    mSeq.update();
    mPattern.update();
    mFxTrack.update();
    updateInstrument(true);

    // Initialize the song
    setEditMode(EDIT_PATTERN);
    mSeq.setCursor(0, 0);
    mPattern.setCursor(0, 0);
    mFxTrack.setCursor(0, 0);

    // Misc event handlers
    document.getElementById("logo").onmousedown = about;
    document.getElementById("newSong").onmousedown = newSong;
    document.getElementById("openSong").onmousedown = openSong;
    document.getElementById("saveSong").onmousedown = saveSong;
    document.getElementById("exportJS").onmousedown = exportJS;
    document.getElementById("exportWAV").onmousedown = exportWAV;
    document.getElementById("playSong").onmousedown = playSong;
    document.getElementById("playRange").onmousedown = playRange;
    document.getElementById("stopPlaying").onmousedown = stopPlaying;
    document.getElementById("about").onmousedown = about;
    document.getElementById("bpm").onfocus = bpmFocus;
    document.getElementById("rpp").onfocus = rppFocus;

    document.getElementById("sequencerCopy").onmousedown = preventDefault(mSeq.copy);
    document.getElementById("sequencerPaste").onmousedown = preventDefault(mSeq.paste);
    document.getElementById("sequencerPatUp").onmousedown = preventDefault(function(e) {
      mSeq.modifySelection(function (value) {
        return value < MAX_PATTERNS ? value + 1 : value;
      });
    });

    document.getElementById("sequencerPatDown").onmousedown = preventDefault(function(e) {
      mSeq.modifySelection(function (value) {
        return value > 0 ? value - 1 : value;
      });
    });

    document.getElementById("patternCopy").onmousedown = preventDefault(mPattern.copy);
    document.getElementById("patternPaste").onmousedown = preventDefault(mPattern.paste);
    document.getElementById("patternNoteUp").onmousedown = preventDefault(function(e) {
      mPattern.modifySelection(function (value) {
        return value > 0 ? value + 1 : value;
      });
    });

    document.getElementById("patternNoteDown").onmousedown = preventDefault(function(e) {
      mPattern.modifySelection(function (value) {
        return value > 1 ? value - 1 : value;
      });
    });

    document.getElementById("patternOctaveUp").onmousedown = preventDefault(function(e) {
      mPattern.modifySelection(function (value) {
        return value > 0 ? value + 12 : 0;
      });
    });

    document.getElementById("patternOctaveDown").onmousedown = preventDefault(function(e) {
      mPattern.modifySelection(function (value) {
        return value > 12 ? value - 12 : value;
      });
    });

    document.getElementById("fxCopy").onmousedown = preventDefault(mFxTrack.copy);
    document.getElementById("fxPaste").onmousedown = preventDefault(mFxTrack.paste);

    document.getElementById("instrPreset").onfocus = instrPresetFocus;
    document.getElementById("instrPreset").onchange = selectPreset;
    document.getElementById("instrPreset").onkeydown = presetOnKeyDown;

    document.getElementById("osc1_wave_sin").addEventListener("mousedown", osc1WaveMouseDown, false);
    document.getElementById("osc1_wave_sin").addEventListener("touchstart", osc1WaveMouseDown, false);
    document.getElementById("osc1_wave_sqr").addEventListener("mousedown", osc1WaveMouseDown, false);
    document.getElementById("osc1_wave_sqr").addEventListener("touchstart", osc1WaveMouseDown, false);
    document.getElementById("osc1_wave_saw").addEventListener("mousedown", osc1WaveMouseDown, false);
    document.getElementById("osc1_wave_saw").addEventListener("touchstart", osc1WaveMouseDown, false);
    document.getElementById("osc1_wave_tri").addEventListener("mousedown", osc1WaveMouseDown, false);
    document.getElementById("osc1_wave_tri").addEventListener("touchstart", osc1WaveMouseDown, false);
    document.getElementById("osc1_vol").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("osc1_vol").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("osc1_semi").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("osc1_semi").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("osc1_xenv").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("osc1_xenv").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("osc2_wave_sin").addEventListener("mousedown", osc2WaveMouseDown, false);
    document.getElementById("osc2_wave_sin").addEventListener("touchstart", osc2WaveMouseDown, false);
    document.getElementById("osc2_wave_sqr").addEventListener("mousedown", osc2WaveMouseDown, false);
    document.getElementById("osc2_wave_sqr").addEventListener("touchstart", osc2WaveMouseDown, false);
    document.getElementById("osc2_wave_saw").addEventListener("mousedown", osc2WaveMouseDown, false);
    document.getElementById("osc2_wave_saw").addEventListener("touchstart", osc2WaveMouseDown, false);
    document.getElementById("osc2_wave_tri").addEventListener("mousedown", osc2WaveMouseDown, false);
    document.getElementById("osc2_wave_tri").addEventListener("touchstart", osc2WaveMouseDown, false);
    document.getElementById("osc2_vol").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("osc2_vol").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("osc2_semi").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("osc2_semi").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("osc2_det").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("osc2_det").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("osc2_xenv").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("osc2_xenv").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("noise_vol").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("noise_vol").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("env_att").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("env_att").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("env_sust").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("env_sust").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("env_rel").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("env_rel").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("env_decay").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("env_decay").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("arp_note1").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("arp_note1").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("arp_note2").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("arp_note2").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("arp_speed").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("arp_speed").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("lfo_wave_sin").addEventListener("mousedown", lfoWaveMouseDown, false);
    document.getElementById("lfo_wave_sin").addEventListener("touchstart", lfoWaveMouseDown, false);
    document.getElementById("lfo_wave_sqr").addEventListener("mousedown", lfoWaveMouseDown, false);
    document.getElementById("lfo_wave_sqr").addEventListener("touchstart", lfoWaveMouseDown, false);
    document.getElementById("lfo_wave_saw").addEventListener("mousedown", lfoWaveMouseDown, false);
    document.getElementById("lfo_wave_saw").addEventListener("touchstart", lfoWaveMouseDown, false);
    document.getElementById("lfo_wave_tri").addEventListener("mousedown", lfoWaveMouseDown, false);
    document.getElementById("lfo_wave_tri").addEventListener("touchstart", lfoWaveMouseDown, false);
    document.getElementById("lfo_amt").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("lfo_amt").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("lfo_freq").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("lfo_freq").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("lfo_fxfreq").addEventListener("mousedown", boxMouseDown, false);
    document.getElementById("lfo_fxfreq").addEventListener("touchstart", boxMouseDown, false);
    document.getElementById("fx_filt_lp").addEventListener("mousedown", fxFiltMouseDown, false);
    document.getElementById("fx_filt_lp").addEventListener("touchstart", fxFiltMouseDown, false);
    document.getElementById("fx_filt_hp").addEventListener("mousedown", fxFiltMouseDown, false);
    document.getElementById("fx_filt_hp").addEventListener("touchstart", fxFiltMouseDown, false);
    document.getElementById("fx_filt_bp").addEventListener("mousedown", fxFiltMouseDown, false);
    document.getElementById("fx_filt_bp").addEventListener("touchstart", fxFiltMouseDown, false);
    document.getElementById("fx_freq").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("fx_freq").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("fx_res").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("fx_res").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("fx_dly_amt").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("fx_dly_amt").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("fx_dly_time").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("fx_dly_time").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("fx_pan_amt").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("fx_pan_amt").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("fx_pan_freq").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("fx_pan_freq").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("fx_dist").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("fx_dist").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("fx_drive").addEventListener("mousedown", sliderMouseDown, false);
    document.getElementById("fx_drive").addEventListener("touchstart", sliderMouseDown, false);
    document.getElementById("octaveDown").addEventListener("mousedown", octaveDown, false);
    document.getElementById("octaveDown").addEventListener("touchstart", octaveDown, false);
    document.getElementById("octaveUp").addEventListener("mousedown", octaveUp, false);
    document.getElementById("octaveUp").addEventListener("touchstart", octaveUp, false);
    document.getElementById("keyboard").addEventListener("mousedown", keyboardMouseDown, false);
    document.getElementById("keyboard").addEventListener("touchstart", keyboardMouseDown, false);

    document.getElementById("instrCopy").addEventListener("click", instrCopyClick, false);
    document.getElementById("instrPaste").addEventListener("click", instrPasteClick, false);
    document.getElementById("instrSave").addEventListener("click", instrSaveClick, false);

    document.getElementById("displaySize").checked = false;
    document.getElementById("displaySize").onchange = displaySizeOnChange;

    document.getElementById("loopPlayback").checked = true;

    // Initialize the keyboard octave number.
    document.getElementById("keyboardOctave").innerHTML = "" + mKeyboardOctave;

    // Initialize the MIDI handler
    initMIDI();

    // Set up master event handlers
    activateMasterEvents();

    // Show the about dialog (if no song was loaded)
    if (!songData)
      showAboutDialog();

    // Hack!
    window.addEventListener('touchstart', unlockAudioPlaybackHack, false);

    // Checks if the user is about to leave the page without saving
    window.addEventListener('beforeunload', windowBeforeUnload, false);

    // Start the jammer
    mJammer.start();

    // Update the jammer rowLen (BPM) - requires that the jammer has been
    // started.
    mJammer.updateRowLen(mSong.rowLen);
  };

};


//------------------------------------------------------------------------------
// Program start
//------------------------------------------------------------------------------

function gui_init()
{
  try
  {
    // Create a global GUI object, and initialize it
    gGui = new CGUI();
    gGui.init();
  }
  catch (err)
  {
    alert("Unexpected error: " + err.message);
  }
}

//# sourceURL=gui.js

