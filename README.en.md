# Desktop Pet

### Relationship breakup special command

Sending an explicit breakup phrase to Rem (in English or Indonesian) plays the bundled `assets/characters/i hate you` sequence on the display containing the pet. The 348 transparent PNG frames are played at 12 fps with a four-frame image cache; the matching `soundfx.mp3` is played when available. The final pose holds for 400 ms and fades out over 800 ms before the normal pet returns. Playback has a bounded failsafe. Press **Ctrl+Alt+Shift+Escape** at any time to restore the normal pet. Set `DESKTOP_PET_BREAKUP_MAX_DURATION_MS` to configure the failsafe (30,000–120,000 ms; default 40,000 ms); it reserves time for the exit transition.

The English README is now the default project homepage:

[Open README.md](README.md)

Other languages:

- [简体中文](README.zh-CN.md)
- [日本語](README.ja.md)
