# Aaronz & Co — Personal Branding Wheel

Standalone page. No build step, no dependencies — open index.html or drop the folder into your dashboard and route to it (or embed via <iframe src="aaronz-branding-wheel/index.html">).

## Files
- index.html — the whole page (markup + scroll logic + clip audio control inline)
- clips/ — yapper-1.mp4, yapper-2.mp4, yapper-3.mp4
- images/
  - aaronz-logo-white.png — white wordmark, transparent, tight-cropped
  - stay-ready.jpg / stay-cool.jpg / stay-broke.jpg / stay-informed.jpg — the 4 wheel quadrant photos

## Swapping the wheel images
Replace the files in images/ keeping the same names (or edit the four <img> src paths near the top of index.html, ids sgw-img-0..3). Landscape-ish crops work best; object-position on each <img> controls framing.

## The Yapper clips
Three iPhone frames, each holding clips/yapper-1..3.mp4. They autoplay muted and loop; the round
button bottom-right unmutes one clip at a time (click again to mute), so three people never talk
at once.

To swap one, replace the file keeping the name. Vertical 9:16 fits the frames. Encode small —
the source cuts were 218MB together, which is not a web page; these are 480x854, ~750kbps video
and 64kbps mono audio, 19MB for all three, written moov-atom-first so they start before the file
has finished arriving. Autoplay only works while muted, so do not remove the `muted` attribute.

To change the number of frames, add or remove a frame div — the script binds by class
(.sgw-clip / .sgw-audio), not by count.

## Fonts
Loaded from Google Fonts (Archivo, Poppins, Playfair Display). For an offline dashboard, self-host and update the <link> in <head>.

## Brand
Navy #0C2036 · Warm Cream #EFEAE0 · Black #0E0E0E · Gold accent #C8A24B
