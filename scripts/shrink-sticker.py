"""把表情包等比缩小到最长边 <= size（GIF 保留动画），QQ 会按像素尺寸显示得更小。
用法: python shrink-sticker.py <src> <dst> <size>
"""
import sys
from PIL import Image, ImageSequence

src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src)
w, h = im.size
scale = min(1.0, size / max(w, h))
nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
fmt = (im.format or 'PNG').upper()
if fmt == 'GIF' and getattr(im, 'is_animated', False):
    frames, durations = [], []
    for f in ImageSequence.Iterator(im):
        durations.append(f.info.get('duration', 80))
        frames.append(f.convert('RGBA').resize((nw, nh), Image.LANCZOS))
    frames[0].save(dst, format='GIF', save_all=True, append_images=frames[1:], duration=durations,
                   loop=im.info.get('loop', 0), disposal=2, optimize=False)
elif fmt in ('JPEG', 'JPG'):
    im.convert('RGB').resize((nw, nh), Image.LANCZOS).save(dst, format='JPEG', quality=90)
elif fmt == 'GIF':
    im.convert('RGBA').resize((nw, nh), Image.LANCZOS).save(dst, format='GIF')
else:
    im.convert('RGBA').resize((nw, nh), Image.LANCZOS).save(dst, format='PNG', optimize=True)
print(f'{w}x{h}->{nw}x{nh}')
