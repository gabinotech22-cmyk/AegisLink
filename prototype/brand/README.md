# Brand / marketing assets

Marketing hero graphics built from the real app mark (`mobile/assets/icon.svg` —
the vault hexagon) and the Vault palette (mint `#5bf2b9` on near-black `#0a0e0d`).

| File | Size | Use |
|------|------|-----|
| `brand-hero-1080x1920.svg` / `.png` | 1080×1920 | splash, store hero, story/portrait |
| `encrypted-hero-1080x1080.svg` / `.png` | 1080×1080 | social square (IG/X), avatars |
| `og-card-1200x630.svg` / `.png` | 1200×630 | OpenGraph / Twitter link-preview card |
| `store/01-e2ee-1080x2400.svg` / `.png` | 1080×2400 | Play Store screenshot — E2EE chat |
| `store/02-zero-metadata-1080x2400.svg` / `.png` | 1080×2400 | Play Store screenshot — zero metadata |
| `store/03-anonymous-1080x2400.svg` / `.png` | 1080×2400 | Play Store screenshot — anonymous onboarding |

The **SVG is the master** (vector, scales to any size). PNGs are rendered from it.
Store screenshots use 1080×2400 (Play phone 9:20); the headline + caption are baked in
so they upload as-is. Add more (calls, groups, panic mode) by copying a `store/*.svg`.

## Regenerate / resize the PNGs

```sh
# exact size baked into the SVG
magick -background none brand-hero-1080x1920.svg brand-hero-1080x1920.png
magick -background none encrypted-hero-1080x1080.svg encrypted-hero-1080x1080.png

# any custom size, e.g. a 1200×630 OG card from the square master
magick -background none -resize 1200x630 encrypted-hero-1080x1080.svg og-card.png
```

(Any SVG renderer works — Inkscape, rsvg-convert, Figma, or a browser export.)

These match the in-app chat wallpapers (`mobile/src/components/WallpaperPicker.tsx`,
the `Mark` / `Aurora` / `Hex` options) so the app and the marketing read as one brand.
