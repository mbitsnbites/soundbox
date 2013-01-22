/* -*- mode: javascript; tab-width: 2; indent-tabs-mode: nil; -*-
*
* Copyright (c) 2011-2012 Marcus Geelnard
*
* This file is part of SoundBox Lite.
*
* SoundBox Lite is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* (at your option) any later version.
*
* SoundBox Lite is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with SoundBox Lite.  If not, see <http://www.gnu.org/licenses/>.
*
*/

function include(filename)
{
	var head = document.getElementsByTagName('head')[0];
	var s = document.createElement('script');
	s.type = 'text/javascript';
	s.src = filename;
	head.appendChild(s);
}

