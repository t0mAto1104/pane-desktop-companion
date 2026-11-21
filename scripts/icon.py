from pathlib import Path
from struct import pack
from math import hypot
from zlib import compress, crc32

segments = [((29,42),(29,29)),((29,29),(42,29)),((58,29),(71,29)),((71,29),(71,42)),
            ((71,58),(71,71)),((71,71),(58,71)),((42,71),(29,71)),((29,71),(29,58)),
            ((39,50),(61,50))]

def pixel(x, y):
    dx = max(27 - x, 0, x - 73)
    dy = max(27 - y, 0, y - 73)
    if hypot(dx, dy) > 24:
        return 0, 0, 0, 0
    for (x1,y1),(x2,y2) in segments:
        dx = max(min(x1,x2) - x, x - max(x1,x2), 0)
        dy = max(min(y1,y2) - y, y - max(y1,y2), 0)
        if hypot(dx,dy) <= 2.4:
            return 255, 255, 255, 255
    return 67, 84, 197, 255

def png(size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            samples = [pixel(100 * (x+ox) / size, 100 * (y+oy) / size) for ox in (.25,.75) for oy in (.25,.75)]
            opacity = sum(sample[3] for sample in samples)
            raw.extend(round(sum(sample[channel] * sample[3] for sample in samples) / opacity) if opacity else 0 for channel in range(3))
            raw.append(round(opacity / 4))
    def chunk(kind, data):
        return pack(">I",len(data)) + kind + data + pack(">I",crc32(kind + data))
    return bytes.fromhex("89504e470d0a1a0a") + chunk(b"IHDR",pack(">IIBBBBB",size,size,8,6,0,0,0)) + chunk(b"IDAT",compress(raw,9)) + chunk(b"IEND",b"")

root = Path(__file__).resolve().parents[1]
dest = root / "assets"
dest.mkdir(exist_ok=True)
public = root / "src" / "renderer" / "public"
public.mkdir(exist_ok=True)
sizes = [16, 24, 32, 48, 64, 128, 256]
images = [png(size) for size in sizes]
(public / "pane.png").write_bytes(images[4])
offset = 6 + 16 * len(sizes)
index = bytearray(pack("<HHH",0,1,len(sizes)))
for size, image in zip(sizes, images):
    index.extend(pack("<BBBBHHII",size % 256,size % 256,0,0,1,32,len(image),offset))
    offset += len(image)
(dest / "pane.ico").write_bytes(index + b"".join(images))
