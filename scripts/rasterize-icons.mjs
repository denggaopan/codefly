#!/usr/bin/env node
// Rasterises build/icon.svg into the two files electron-builder actually ships:
// build/icon.png (the source electron-builder converts into the macOS .icns)
// and build/icon.ico (the Windows app icon, 7 frames).
//
// Why a script rather than a one-off: the repo has no image library, so both
// files have to be produced by hand, and the ICO layout is easy to get subtly
// wrong in ways Explorer renders as a blank or half-height icon. Run this after
// every edit to build/icon.svg.
//
//   node scripts/rasterize-icons.mjs
//
// Chromium (via the Playwright already in devDependencies) is the rasteriser
// because the artwork uses SVG gradients and an feDropShadow, and Chromium is
// the same engine that renders the in-app copy of the mark.
//
// ICO layout, which is the part worth writing down:
//   ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per frame + the frames.
//   A 256px frame writes its width and height as 0 in the entry - the field is
//   one byte, so 256 does not fit.
//   Each frame is a BITMAPINFOHEADER DIB, NOT a PNG: 40-byte header whose
//   biHeight is TWICE the image height (it covers the colour rows plus the mask
//   rows), then bottom-up BGRA rows, then a 1bpp AND mask whose rows are padded
//   to 4 bytes and whose bits are set where alpha is 0.
//   Note that GDI+ only ever hands back the 128px frame when asked for 256 -
//   that is a GDI+ limitation, not a broken file. Verify with WIC
//   (System.Windows.Media.Imaging.BitmapDecoder), which is what Explorer uses.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SVG_PATH = join(ROOT, 'build', 'icon.svg')
const PNG_PATH = join(ROOT, 'build', 'icon.png')
const ICO_PATH = join(ROOT, 'build', 'icon.ico')

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

// build/icon.png is what electron-builder converts into the macOS .icns, and it
// REFUSES anything under 512 - "Icon must be at least 512x512 pixels" fails the
// whole mac build, after the Electron download, inside the Linux container. It
// is therefore rendered on its own rather than reusing an ICO frame, none of
// which is large enough. Do not lower it to match a frame size.
const PNG_SIZE = 512

/**
 * Rasterise the SVG at one pixel size.
 *
 * The SVG's own width/height attributes are rewritten to the target size before
 * it is handed to Chromium. Without that the browser lays the image out at its
 * declared 256px and drawImage() scales that bitmap, so every size below 256
 * would be a downscale of one render instead of its own - visibly softer at
 * 16px, where the artwork needs every pixel it can get.
 */
async function rasterize(page, svgText, size) {
  const sized = svgText.replace(/width="\d+"\s+height="\d+"/, `width="${size}" height="${size}"`)
  const uri = 'data:image/svg+xml;base64,' + Buffer.from(sized, 'utf8').toString('base64')

  return page.evaluate(
    async ({ uri, size }) => {
      const img = new Image()
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = () => reject(new Error('SVG failed to decode'))
        img.src = uri
      })

      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, size, size)
      ctx.drawImage(img, 0, 0, size, size)

      const data = ctx.getImageData(0, 0, size, size).data
      // Chunked so the argument list of String.fromCharCode stays sane.
      let binary = ''
      for (let i = 0; i < data.length; i += 8192) {
        binary += String.fromCharCode.apply(null, data.subarray(i, i + 8192))
      }
      return { rgba: btoa(binary), png: canvas.toDataURL('image/png') }
    },
    { uri, size }
  )
}

/** One ICONDIRENTRY's worth of image data: DIB header + BGRA rows + AND mask. */
function dibFrame(rgba, size) {
  const maskStride = Math.ceil(size / 32) * 4
  const pixels = Buffer.alloc(size * size * 4)
  const mask = Buffer.alloc(maskStride * size)

  for (let y = 0; y < size; y += 1) {
    const sourceRow = size - 1 - y // DIB rows run bottom-up
    for (let x = 0; x < size; x += 1) {
      const s = (sourceRow * size + x) * 4
      const d = (y * size + x) * 4
      pixels[d] = rgba[s + 2]
      pixels[d + 1] = rgba[s + 1]
      pixels[d + 2] = rgba[s]
      pixels[d + 3] = rgba[s + 3]
      if (rgba[s + 3] === 0) {
        mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
  }

  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight - colour rows + mask rows
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // biCompression = BI_RGB
  header.writeUInt32LE(pixels.length + mask.length, 20) // biSizeImage

  return Buffer.concat([header, pixels, mask])
}

function buildIco(frames) {
  const directory = Buffer.alloc(6)
  directory.writeUInt16LE(0, 0) // reserved
  directory.writeUInt16LE(1, 2) // type: icon
  directory.writeUInt16LE(frames.length, 4)

  let offset = 6 + 16 * frames.length
  const entries = frames.map(({ size, data }) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0) // 256 is encoded as 0
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })

  return Buffer.concat([directory, ...entries, ...frames.map((f) => f.data)])
}

const svgText = readFileSync(SVG_PATH, 'utf8')
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>')

  const frames = []
  for (const size of ICO_SIZES) {
    const { rgba } = await rasterize(page, svgText, size)
    frames.push({ size, data: dibFrame(Buffer.from(rgba, 'base64'), size) })
    console.log(`rasterised ${size}x${size}`)
  }

  const ico = buildIco(frames)
  writeFileSync(ICO_PATH, ico)
  console.log(`wrote ${ICO_PATH} (${frames.length} frames, ${ico.length} bytes)`)

  const { png } = await rasterize(page, svgText, PNG_SIZE)
  const pngBuffer = Buffer.from(png.split(',')[1], 'base64')
  writeFileSync(PNG_PATH, pngBuffer)

  // Read the size back out of the IHDR rather than trusting the request: a PNG
  // that is silently too small only surfaces deep inside the mac build.
  const width = pngBuffer.readUInt32BE(16)
  const height = pngBuffer.readUInt32BE(20)
  if (width < 512 || height < 512) {
    throw new Error(`icon.png is ${width}x${height}; electron-builder needs at least 512x512 for macOS`)
  }
  console.log(`wrote ${PNG_PATH} (${width}x${height})`)
} finally {
  await browser.close()
}
