# Media playback fixtures

Self-generated color test patterns; no third-party media. The one-second VP9 WebM
verifies actual browser decoding/playback without network access. The PNG verifies
same-origin image loading. Generated with:

```sh
ffmpeg -f lavfi -i testsrc=size=64x48:rate=8 -t 1 -c:v libvpx-vp9 -an test-pattern.webm
ffmpeg -f lavfi -i testsrc=size=64x48:rate=1 -frames:v 1 test-pattern.png
```

These are test fixtures only; production search never falls back to sample media.
