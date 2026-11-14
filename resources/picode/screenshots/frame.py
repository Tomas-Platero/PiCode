"""Builds the README screenshots: crops the website's captures and frames them.

Usage: python frame.py <website-public-dir>
Reads the raw captures from the website project and writes the framed PNGs here.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))

# (output, source relative to the website's public dir, crop box or None)
SHOTS = [
	('layout-agent.png', 'images/screenshots/picode-layout-agent.png', None),
	('layout-editor.png', 'images/screenshots/picode-layout-editor.png', None),
	('chat.png', 'images/screenshots/picode-subagent-tasks-sessions.png', (350, 36, 1604, 1052)),
	('chat-settings.png', 'images/screenshots/picode-chat-settings-status.png', (262, 126, 1654, 940)),
	('issues.png', 'email/demos/issues.png', None),
]

BG_TOP = (11, 16, 32)
BG_BOTTOM = (16, 36, 72)
GLOW = (59, 155, 255)
BORDER = (52, 66, 96)


def rounded(img, radius):
	mask = Image.new('L', img.size, 0)
	ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius, fill=255)
	out = img.convert('RGBA')
	out.putalpha(mask)
	return out


def frame(shot, pad=64, radius=16):
	w, h = shot.width + 2 * pad, shot.height + 2 * pad
	canvas = Image.new('RGB', (w, h), BG_TOP)
	draw = ImageDraw.Draw(canvas)
	for y in range(h):
		t = y / max(1, h - 1)
		draw.line((0, y, w, y), fill=tuple(int(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))
	# Soft brand glow behind the window.
	glow = Image.new('L', (w, h), 0)
	ImageDraw.Draw(glow).ellipse((w * 0.15, h * 0.25, w * 0.85, h * 1.1), fill=90)
	glow = glow.filter(ImageFilter.GaussianBlur(min(w, h) // 6))
	canvas = Image.composite(Image.new('RGB', (w, h), GLOW), canvas, glow)
	# Drop shadow.
	shadow = Image.new('L', (w, h), 0)
	ImageDraw.Draw(shadow).rounded_rectangle((pad, pad + 18, pad + shot.width, pad + shot.height + 18), radius, fill=170)
	shadow = shadow.filter(ImageFilter.GaussianBlur(22))
	canvas = Image.composite(Image.new('RGB', (w, h), (0, 0, 0)), canvas, shadow)
	# The window itself, with a thin border.
	window = rounded(shot, radius)
	canvas.paste(window, (pad, pad), window)
	ImageDraw.Draw(canvas).rounded_rectangle((pad - 1, pad - 1, pad + shot.width, pad + shot.height), radius, outline=BORDER, width=1)
	return rounded(canvas, 24)


def status_columns(agent):
	"""The Status column of the Agent layout, split in two so it reads wide instead of tall."""
	col = agent.crop((1610, 72, 1896, 1040))
	top, bottom = col.crop((0, 0, col.width, 398)), col.crop((0, 398, col.width, col.height))
	bg, gap = col.getpixel((col.width - 10, col.height - 10)), 28
	out = Image.new('RGB', (2 * col.width + 3 * gap, max(top.height, bottom.height) + 2 * gap), bg)
	out.paste(top, (gap, gap))
	out.paste(bottom, (2 * gap + col.width, gap))
	return out


def main(public):
	for name, src, box in SHOTS:
		img = Image.open(os.path.join(public, src)).convert('RGB')
		if box:
			img = img.crop(box)
		frame(img).save(os.path.join(HERE, name), optimize=True)
	agent = Image.open(os.path.join(public, SHOTS[0][1])).convert('RGB')
	frame(status_columns(agent), pad=56).save(os.path.join(HERE, 'status.png'), optimize=True)


if __name__ == '__main__':
	main(sys.argv[1])
