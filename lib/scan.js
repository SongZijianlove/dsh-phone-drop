/**
 * dsh-phone-drop scanner: the image math, kept apart from the page.
 *
 * A phone camera cannot be asked for its "document scan" mode through
 * `<input type=file>` — that mode belongs to the camera app and is not exposed
 * to the web. So the scan is done here instead, after the shot: grayscale,
 * integral-image adaptive threshold, despeckle, then trim to the ink.
 *
 * Everything takes and returns plain arrays so it runs the same in the page
 * and under `node --test`, which is the only way to prove the filters work
 * without a browser in the loop.
 */

/** Rec.601 luma in 0..255, one value per pixel of an RGBA buffer. */
export function toGray(rgba) {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    out[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return out;
}

/**
 * Pixels darker than this are ink no matter what their neighbourhood says.
 *
 * Adaptive thresholding has one famous artefact: a *large* solid dark area has
 * a neighbourhood that is entirely dark too, so its own mean equals its own
 * value and the centre comes out white — a filled checkbox or a heavy headline
 * gets hollowed out like a doughnut. An absolute floor closes that hole, and
 * text is unaffected because the inside of an "o" is paper-bright.
 *
 * The floor is a fraction of the image's median rather than a hard 70: a photo
 * taken in a dim room is dark all over, and a fixed cutoff would flood it with
 * ink. Paper is the bulk of a document, so the median tracks the paper.
 */
const INK_FLOOR_MAX = 70;
const INK_FLOOR_OF_MEDIAN = 0.5;

/** Median of a grayscale plane, from a 256-bin histogram. */
function medianOf(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[Math.min(255, Math.max(0, Math.round(gray[i])))]++;
  const half = gray.length / 2;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= half) return v;
  }
  return 255;
}

/**
 * Adaptive threshold: a pixel goes black when it is darker than the mean of its
 * `winSize` neighbourhood by more than `c`. The mean comes from an integral
 * image, so the cost is O(w*h) no matter how large the window — which is what
 * lets a 2000px photo finish in tens of milliseconds on a phone.
 *
 * A global threshold would be the obvious shortcut and the wrong one: uneven
 * lamp light makes one side of a page grey and the other white, and a single
 * cutoff erases whichever half it disagrees with.
 *
 * @returns {Uint8ClampedArray} one 0 (ink) or 255 (paper) per pixel
 */
export function adaptiveThreshold(gray, w, h, winSize, c, floor) {
  const inkFloor = floor ?? Math.min(INK_FLOOR_MAX, medianOf(gray) * INK_FLOOR_OF_MEDIAN);
  const W = w + 1;
  const integral = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * W + (x + 1)] = integral[y * W + (x + 1)] + rowSum;
    }
  }
  const out = new Uint8ClampedArray(w * h);
  const r = Math.max(3, Math.floor(winSize / 2));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * W + (x1 + 1)] -
        integral[y0 * W + (x1 + 1)] -
        integral[(y1 + 1) * W + x0] +
        integral[y0 * W + x0];
      const v = gray[y * w + x];
      out[y * w + x] = v < inkFloor || v < sum / area - c ? 0 : 255;
    }
  }
  return out;
}

/**
 * Drop isolated ink: paper texture and JPEG ringing leave single dark pixels
 * that read as fly specks on the scan. A real stroke always has a neighbour.
 */
export function despeckle(bits, w, h) {
  const out = new Uint8ClampedArray(bits);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (bits[i] !== 0) continue;
      let dark = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (bits[(y + dy) * w + (x + dx)] === 0) dark++;
        }
      }
      if (dark <= 2) out[i] = 255;
    }
  }
  return out;
}

/**
 * The brightness at the `q`-th percentile, from a 256-bin histogram.
 *
 * Paper detection needs a "how bright is the paper here" reference that a few
 * dark pixels cannot drag down and a few specular highlights cannot drag up,
 * which is what a percentile gives and a mean does not.
 */
function percentileOf(gray, q) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[Math.min(255, Math.max(0, Math.round(gray[i])))]++;
  const want = gray.length * q;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= want) return v;
  }
  return 255;
}

/**
 * The paper's bounding box, in pixels, or `null` for "do not crop".
 *
 * This crops to the *paper*, not to the ink. Cropping to the ink was the first
 * thing tried and it failed on real photos for a reason worth remembering: a
 * document shot on a desk has a dark table around it, the table is "ink" by any
 * brightness test, so the ink box is the entire frame and the crop does
 * nothing. Paper, on the other hand, is the bright blob in the middle, and its
 * edges are exactly the page edges the user wants.
 *
 * It reads the *grayscale* plane, not the thresholded one, and that is not a
 * detail. The first version of this read the black-and-white output, where a
 * dark desk and a white page are both "white" — adaptive thresholding has no
 * idea one of them is a table — so the bounding box came back as the whole
 * frame and nothing was ever cropped. Measured on a synthetic desk photo:
 * desk 45, paper 237, and the crop was a no-op.
 *
 * A row or column only counts as paper when a fair share of it is paper, so a
 * bright stray object in one corner cannot stretch the box to the frame edge.
 *
 * `null` when there is no paper to find (an all-dark frame), when the paper is
 * too small to be the subject, or when it already fills the frame — cropping
 * then would only risk eating a margin.
 */
export function paperBox(gray, w, h) {
  // "How bright is paper in this frame": the 90th percentile. Paper is the
  // brightest thing in a document photo, but a single specular highlight must
  // not become the reference, hence 90 rather than 100.
  const hi = percentileOf(gray, 0.9);
  if (hi < 40) return null;                 // a dark frame: no page to find
  const cut = hi * 0.6;                     // paper is well above the table

  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  let bright = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (gray[row + x] > cut) {
        rows[y]++;
        cols[x]++;
        bright++;
      }
    }
  }
  if (bright < w * h * 0.05) return null;

  // A row or column belongs to the page only when a fair share of it is paper.
  // Without this, a bright object in one corner sets the box to the frame edge.
  const rowMin = Math.round(w * 0.2);
  const colMin = Math.round(h * 0.2);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    if (rows[y] < rowMin) continue;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  for (let x = 0; x < w; x++) {
    if (cols[x] < colMin) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  if (x1 < 0 || y1 < 0) return null;

  // pull in by 1% of the short side: the paper's own drop shadow reads as a
  // grey halo, and keeping it makes the scan look like it was cut with a blunt
  // knife.
  const inset = Math.round(Math.min(w, h) * 0.01);
  const left = Math.min(x1, x0 + inset);
  const top = Math.min(y1, y0 + inset);
  const right = Math.max(left, x1 - inset);
  const bottom = Math.max(top, y1 - inset);
  const box = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };

  if (box.w < w * 0.15 || box.h < h * 0.15) return null;
  if (box.w > w * 0.97 && box.h > h * 0.97) return null;
  return box;
}

/**
 * Contrast-stretch a grayscale plane and lift the mid-tones so pencil and thin
 * print come out solid instead of feathered.
 *
 * @returns {Uint8ClampedArray} a full RGBA buffer, ready for `putImageData`
 */
export function grayEnhance(gray, w, h) {
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < lo) lo = gray[i];
    if (gray[i] > hi) hi = gray[i];
  }
  const span = Math.max(1, hi - lo);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0, o = 0; p < gray.length; p++, o += 4) {
    const v = 255 * Math.pow(Math.max(0, gray[p] - lo) / span, 1.35);
    out[o] = out[o + 1] = out[o + 2] = v;
    out[o + 3] = 255;
  }
  return out;
}

/**
 * The whole black-and-white pipeline in one call.
 *
 * @returns {{data: Uint8ClampedArray, width: number, height: number, box: null | {x:number,y:number,w:number,h:number}}}
 *   `data` is RGBA; width/height are the cropped size; `box` is the crop that
 *   was applied, or `null` when the frame was kept whole.
 */
export function scanDocument(gray, w, h, options = {}) {
  const c = Number.isFinite(options.c) ? options.c : 12;
  const winSize = Number.isFinite(options.winSize) ? options.winSize : 28;
  const despeckled = options.despeckle === false ? null : true;

  let bits = adaptiveThreshold(gray, w, h, winSize, c);
  if (despeckled) bits = despeckle(bits, w, h);

  const box = options.crop === false ? null : paperBox(gray, w, h);
  const ow = box === null ? w : box.w;
  const oh = box === null ? h : box.h;
  const data = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const sx = box === null ? x : x + box.x;
      const sy = box === null ? y : y + box.y;
      const v = bits[sy * w + sx];
      const o = (y * ow + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { data, width: ow, height: oh, box };
}
