/**
 * Decode a barcode out of a PNG buffer, in Node.
 *
 * This is the test that actually matters. The SVG renderer is hand-written, so the
 * only convincing proof that a printed label will scan is to rasterise what the app
 * renders and read it back with an independent decoder — ZXing, the same engine the
 * phone-camera path uses.
 *
 * sharp comes from the backend's dependencies; @zxing/library from the frontend's.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sharp = require(path.join(ROOT, 'backend', 'node_modules', 'sharp'));
const zxing = require(path.join(ROOT, 'frontend', 'node_modules', '@zxing', 'library'));

const {
  MultiFormatReader,
  BarcodeFormat,
  DecodeHintType,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
} = zxing;

/**
 * @param {Buffer} png
 * @param {object} [opts]
 * @param {number} [opts.scale] upscale factor before decoding; a 38 mm label captured
 *   at CSS resolution can be too few pixels per module for the binarizer.
 * @returns {Promise<{text: string, format: string}>}
 */
async function decodeBarcodeFromPng(png, { scale = 1 } = {}) {
  let img = sharp(png).flatten({ background: '#ffffff' }); // drop alpha; bars must be on white

  if (scale !== 1) {
    const meta = await sharp(png).metadata();
    img = img.resize({
      width: Math.round(meta.width * scale),
      height: Math.round(meta.height * scale),
      kernel: 'nearest', // keep bar edges hard — smoothing blurs narrow bars together
    });
  }

  const { data, info } = await img.greyscale().raw().toBuffer({ resolveWithObject: true });

  const luminances = new Uint8ClampedArray(data.buffer, data.byteOffset, info.width * info.height);
  const source = new RGBLuminanceSource(luminances, info.width, info.height);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));

  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);

  const reader = new MultiFormatReader();
  reader.setHints(hints);
  const result = reader.decode(bitmap);

  return { text: result.getText(), format: BarcodeFormat[result.getBarcodeFormat()] };
}

/** Try a few scales before giving up — mirrors what a real scanner does by moving. */
async function decodeBarcodeResilient(png, scales = [3, 4, 2, 6, 1]) {
  const errors = [];
  for (const scale of scales) {
    try {
      return { ...(await decodeBarcodeFromPng(png, { scale })), scale };
    } catch (err) {
      errors.push(`${scale}x: ${err.constructor?.name || err.message}`);
    }
  }
  throw new Error(`no barcode decoded at any scale (${errors.join('; ')})`);
}

module.exports = { decodeBarcodeFromPng, decodeBarcodeResilient };
