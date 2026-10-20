# Rem 2.0 animation frame map

The original `assets/characters/sprite rem 2.0.png` remains unchanged. It is an
RGBA PNG measuring 8865 × 9605 px. Its frame placements do not form a uniform
8 × 11 grid: transparent row gaps occur at different y coordinates, and the
export has a large transparent region to the right. A 1108 px frame width
crosses neighboring poses.

`assets/characters/rem/sprite-rem-extended.png` is a lossless derived atlas,
assembled without resampling. Its first eight rows are copied from the stable original Rem
atlas (6144 × 6656 px). The three new rows are copied from the source atlas as
eight 768 × 832 px frames, without resampling:

| State | Source y | Source x positions | Meaning |
| --- | ---: | --- | --- |
| `tsundere` (row 8) | 6904 | 1536, 2304, 3072, 3840, 4608 | Blushing, averted gaze, bashful and crossed-arm poses |
| `angry` (row 9) | 7782 | 0, 768, 1536, 2304, 3072, 3840, 4608, 5376 | Red anger marks, scolding and displeased poses |
| `listening_music` (row 10) | 8642 | 0, 768, 1536, 2304, 3072, 3840, 4608, 5376 | Headphones and listening gestures |

The listed frames play left to right. In the derived atlas they occupy rows 8,
9 and 10 with an 832 px row height. The original PNG is not edited or replaced.
Tsundere deliberately uses source columns 2–6 (five frames in order). Columns
0, 1 and 7 include gray rectangular background panels that interrupt the pose
sequence and distort its measured bounds, so they are left out.

The new frames have different transparent margins. `character.json` stores the
measured nontransparent bounds for each frame (alpha greater than 8/255). The
renderer crops only within that frame, preserves its aspect ratio, centers the
visible bounds horizontally, and places the bottom edge on the same canvas
baseline. Each visible frame is drawn at 832 px high in the 768 × 832 canvas;
the sprite window dimensions and drag surface are unchanged.
