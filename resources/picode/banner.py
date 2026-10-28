# Renders picode-banner.png next to this file (the README header). Run: python resources/picode/banner.py
import math
from PIL import Image, ImageDraw, ImageFilter, ImageFont

S = 4                      # supersampling over a 1200x400 design grid
W, H = 1200 * S, 400 * S
BLUE, WHITE, MUTED = (59, 155, 255), (245, 245, 245), (150, 160, 175)
F = 'C:/Windows/Fonts/'

img = Image.new('RGB', (W, H), (13, 17, 23))
px = img.load()
# Vertical gradient plus a soft blue glow behind the mark.
glow = Image.new('RGB', (W, H), (0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([-60 * S, -60 * S, 460 * S, 460 * S], fill=(12, 34, 66))
gd.ellipse([780 * S, 120 * S, 1300 * S, 520 * S], fill=(6, 18, 36))
glow = glow.filter(ImageFilter.GaussianBlur(90 * S))
bg = Image.new('RGB', (W, H))
bd = ImageDraw.Draw(bg)
for y in range(H):
    t = y / H
    bd.line([(0, y), (W, y)], fill=(int(13 + 8 * t), int(17 + 8 * t), int(23 + 12 * t)))
img = Image.blend(bg, Image.eval(Image.merge('RGB', [Image.composite(g, g, g) for g in glow.split()]), lambda v: v), 0)
from PIL import ImageChops
img = ImageChops.add(bg, glow)
d = ImageDraw.Draw(img)

def stroke(points, w, fill):
    pts = [(x * S, y * S) for x, y in points]
    d.line(pts, fill=fill, width=int(w * S), joint='curve')
    r = w * S / 2
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=fill)

def dot(x, y, r, fill):
    d.ellipse([(x - r) * S, (y - r) * S, (x + r) * S, (y + r) * S], fill=fill)

# Mark, centred on x=150 (same drawing as picode-status.svg).
cx, top, sw = 150, 112, 20
r = 18
body = [(cx - 43, 258), (cx - 43, top + r)]
body += [(cx - 43 + r - r * math.cos(a), top + r - r * math.sin(a)) for a in [i * math.pi / 2 / 12 for i in range(13)]]
body += [(cx + 43 - r + r * math.sin(a), top + r - r * math.cos(a)) for a in [i * math.pi / 2 / 12 for i in range(13)]]
body += [(cx + 43, 258)]
stroke(body, sw, WHITE)
stroke([(cx - 82, 188), (cx + 82, 188)], sw, WHITE)
stroke([(cx, 92), (cx, top)], 8, WHITE)
dot(cx, 88, 11, BLUE)
dot(cx - 17, 152, 8, BLUE)
dot(cx + 17, 152, 8, BLUE)
stroke([(cx - 24, 236), (cx - 44, 256), (cx - 24, 276)], sw, BLUE)
stroke([(cx + 24, 236), (cx + 44, 256), (cx + 24, 276)], sw, BLUE)

def text(x, y, s, font, fill):
    d.text((x * S, y * S), s, font=font, fill=fill, anchor='ls')
    return d.textlength(s, font=font) / S

big = ImageFont.truetype(F + 'segoeuib.ttf', 112 * S)
x = 300
w = text(x, 205, 'Pi', big, WHITE)
text(x + w + 2, 205, 'Code', big, BLUE)
text(x + 4, 258, 'The agentic code editor with its own AI inside.',
     ImageFont.truetype(F + 'segoeui.ttf', 30 * S), (200, 208, 220))
d.rounded_rectangle([x * S + 4 * S, 278 * S, (x + 120) * S, 281 * S], radius=2 * S, fill=BLUE)

# Feature chips.
chip = ImageFont.truetype(F + 'segoeuib.ttf', 18 * S)
cx0 = x + 4
for label in ['Pi agent', 'Gentle AI', 'Engram memory', 'MCP servers', 'Free & open source']:
    tw = d.textlength(label, font=chip) / S
    d.rounded_rectangle([cx0 * S, 306 * S, (cx0 + tw + 28) * S, 344 * S], radius=19 * S,
                        fill=(22, 32, 48), outline=(44, 84, 140), width=2 * S)
    d.text(((cx0 + 14) * S, 325 * S), label, font=chip, fill=(170, 205, 255), anchor='lm')
    cx0 += tw + 28 + 10

img.resize((2400, 800), Image.LANCZOS).save(__import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), 'picode-banner.png'), optimize=True)
