#!/usr/bin/env bash
# Makes the sample files the browser test uploads. Needs python3 with Pillow, and ffmpeg.
#   backend/test/browser/make-media.sh            (writes to backend/test/browser/media)
set -euo pipefail
OUT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/media}"
mkdir -p "$OUT"
cd "$OUT"
python3 - <<'PY'
from PIL import Image, ImageDraw
import random
random.seed(1)
im = Image.new('RGB', (4000, 3000), (200, 120, 60))
d = ImageDraw.Draw(im)
for _ in range(400):
    x, y = random.randint(0, 3900), random.randint(0, 2900)
    d.rectangle([x, y, x + random.randint(20, 300), y + random.randint(20, 300)], fill=tuple(random.randint(0, 255) for _ in range(3)))
exif = Image.Exif()
exif[274] = 6  # rotated 90 degrees, so the test proves the page turns it upright
im.save('photo-rotated.jpg', 'JPEG', quality=92, exif=exif)
PY
ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=20:size=640x360:rate=24 -f lavfi -i sine=frequency=440:duration=20 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest clip20.mp4
ffmpeg -loglevel error -y -f lavfi -i testsrc=duration=75:size=320x180:rate=10 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p long75.mp4
printf '%%PDF-1.4 fake' >notvideo.mp4
echo "Sample media written to $OUT"
