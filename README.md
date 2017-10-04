# SoundBox

SoundBox is a tool for composing synthetic music, in your browser. Its design
is basically that of a
[music tracker](https://en.wikipedia.org/wiki/Music_tracker), which means that
the music is organized in *tracks* and *patterns*.

The latest version of SoundBox is served at:
[sb.bitsnbites.eu](http://sb.bitsnbites.eu).

## Running locally

To run your own copy of SoundBox locally, you need to serve it via a web server
(using the file:// protocol is *not* supported).

A simple method is to use Python SimpleHTTPServer (that usually comes
preinstalled on Unix-like systems such as macOS and Linux):

```bash
cd path/to/soundbox
python -m SimpleHTTPServer 8008
```

Now point your browser to `http://localhost:8008/`.

## License

The SoundBox editor is licensed under the
[GNU General Public License version 3](gpl.txt).

However, the minimal player routine, [player-small.js](player-small.js), is
released under the [zlib/libpng license](https://opensource.org/licenses/Zlib).
This makes it suitable for inclusion in your own software.

