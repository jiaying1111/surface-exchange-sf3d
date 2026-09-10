/** Build a continuous skin plate from a packed UV atlas (fills black gutters, blends charts). */

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load surface atlas.'));
    img.src = src;
  });
}

function isBackground(r: number, g: number, b: number, a: number) {
  if (a < 12) return true;
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  // SF3D atlases pack charts on near-black / empty pixels.
  return luma < 18;
}

function contentBounds(data: ImageData) {
  const { data: px, width, height } = data;
  let minX = width,
    minY = height,
    maxX = 0,
    maxY = 0,
    found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isBackground(px[i], px[i + 1], px[i + 2], px[i + 3])) continue;
      found = true;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!found) return { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };
  const pad = 4;
  return {
    minX: Math.max(0, minX - pad),
    minY: Math.max(0, minY - pad),
    maxX: Math.min(width - 1, maxX + pad),
    maxY: Math.min(height - 1, maxY + pad),
  };
}

function dilateBackground(data: ImageData, passes: number) {
  const { width, height } = data;
  let cur = new Uint8ClampedArray(data.data);
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8ClampedArray(cur);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4;
        if (!isBackground(cur[i], cur[i + 1], cur[i + 2], cur[i + 3])) continue;
        let r = 0,
          g = 0,
          b = 0,
          n = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (!ox && !oy) continue;
            const j = ((y + oy) * width + (x + ox)) * 4;
            if (isBackground(cur[j], cur[j + 1], cur[j + 2], cur[j + 3])) continue;
            r += cur[j];
            g += cur[j + 1];
            b += cur[j + 2];
            n++;
          }
        }
        if (!n) continue;
        next[i] = Math.round(r / n);
        next[i + 1] = Math.round(g / n);
        next[i + 2] = Math.round(b / n);
        next[i + 3] = 255;
      }
    }
    cur = next;
  }
  data.data.set(cur);
}

function softBlur(data: ImageData, radius: number) {
  if (radius <= 0) return;
  const { width, height } = data;
  const src = new Uint8ClampedArray(data.data);
  const dst = data.data;
  const kernel = radius;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        wsum = 0;
      for (let oy = -kernel; oy <= kernel; oy++) {
        for (let ox = -kernel; ox <= kernel; ox++) {
          const xx = Math.min(width - 1, Math.max(0, x + ox));
          const yy = Math.min(height - 1, Math.max(0, y + oy));
          const j = (yy * width + xx) * 4;
          const w = kernel + 1 - Math.max(Math.abs(ox), Math.abs(oy));
          r += src[j] * w;
          g += src[j + 1] * w;
          b += src[j + 2] * w;
          a += src[j + 3] * w;
          wsum += w;
        }
      }
      const i = (y * width + x) * 4;
      dst[i] = r / wsum;
      dst[i + 1] = g / wsum;
      dst[i + 2] = b / wsum;
      dst[i + 3] = a / wsum;
    }
  }
}

function boostPresence(data: ImageData) {
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    let r = px[i] / 255,
      g = px[i + 1] / 255,
      b = px[i + 2] / 255;
    // Mild contrast + saturation so apple red / fur reads as a real coat.
    r = (r - 0.5) * 1.12 + 0.5;
    g = (g - 0.5) * 1.12 + 0.5;
    b = (b - 0.5) * 1.12 + 0.5;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = 1.28;
    r = luma + (r - luma) * sat;
    g = luma + (g - luma) * sat;
    b = luma + (b - luma) * sat;
    px[i] = Math.min(255, Math.max(0, Math.round(r * 255)));
    px[i + 1] = Math.min(255, Math.max(0, Math.round(g * 255)));
    px[i + 2] = Math.min(255, Math.max(0, Math.round(b * 255)));
    px[i + 3] = 255;
  }
}

/** Turn a packed UV atlas into a continuous, wrap-friendly skin texture. */
export async function prepareContinuousSkin(atlasUrl: string, size = 768) {
  const img = await loadImage(atlasUrl);
  const probe = document.createElement('canvas');
  probe.width = img.width;
  probe.height = img.height;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true })!;
  probeCtx.drawImage(img, 0, 0);
  const bounds = contentBounds(
    probeCtx.getImageData(0, 0, probe.width, probe.height),
  );
  const cropW = bounds.maxX - bounds.minX + 1;
  const cropH = bounds.maxY - bounds.minY + 1;

  const work = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = work;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(
    img,
    bounds.minX,
    bounds.minY,
    cropW,
    cropH,
    0,
    0,
    work,
    work,
  );

  const imageData = ctx.getImageData(0, 0, work, work);
  dilateBackground(imageData, 22);
  softBlur(imageData, 1);
  boostPresence(imageData);
  ctx.putImageData(imageData, 0, 0);

  // Build a mirrored plate for more natural large-scale wrapping.
  const plate = document.createElement('canvas');
  plate.width = plate.height = size;
  const pctx = plate.getContext('2d')!;
  const half = size / 2;
  pctx.imageSmoothingEnabled = true;
  pctx.drawImage(canvas, 0, 0, half, half);
  pctx.save();
  pctx.translate(size, 0);
  pctx.scale(-1, 1);
  pctx.drawImage(canvas, 0, 0, half, half);
  pctx.restore();
  pctx.save();
  pctx.translate(0, size);
  pctx.scale(1, -1);
  pctx.drawImage(canvas, 0, 0, half, half);
  pctx.restore();
  pctx.save();
  pctx.translate(size, size);
  pctx.scale(-1, -1);
  pctx.drawImage(canvas, 0, 0, half, half);
  pctx.restore();

  return plate.toDataURL('image/jpeg', 0.92);
}
