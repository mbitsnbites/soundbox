/* -*- mode: javascript; tab-width: 2; indent-tabs-mode: nil; -*-
*
* Copyright (c) 2011-2017 Marcus Geelnard
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

// based on https://j11y.io/javascript/deep-copying-of-objects-and-arrays/
function deepCopy(obj)
{
  if (Object.prototype.toString.call(obj) === '[object Array]') {
    var out = [], i = 0, len = obj.length;
    for ( ; i < len; i++ ) {
      out[i] = arguments.callee(obj[i]);
    }
    return out;
  }
  if (typeof obj === 'object') {
    var out = {}, i;
    for ( i in obj ) {
      out[i] = arguments.callee(obj[i]);
    }
    return out;
  }
  return obj;
}


function deepEquals(a,b)
{   
  // if a and b are arrays, compare them as such
  if (Object.prototype.toString.call(a) === '[object Array]' && 
      Object.prototype.toString.call(b) === '[object Array]') {
    if (a.length != b.length)
      return false;
    for (var i=0;i < a.length; i++ ) {
      if (!arguments.callee(a[i],b[i]))
        return false;
    }
    return true;
  }
  // if a and b are associative arrays, compare them as such
  if (typeof a === 'object' && typeof b === 'object') {   
    var checkKeys = function(a,b) {
      for(key in a) //In a and not in b
        if(!(key in b))
          return false;
      return true;
    }
    if (!checkKeys(a,b) || !checkKeys(b,a))
      return false;
    for (i in a) {
      if (!arguments.callee(a[i],b[i]))
        return false;
    }
    return true;
  }   
  return a === b;
}

