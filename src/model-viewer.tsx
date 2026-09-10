import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load surface atlas.'));
    img.src = url;
  });
}

/**
 * Turn a packed UV atlas (with black gutters) into a continuous "coat" material
 * that can wrap another body without showing atlas packing holes.
 */
async function atlasToCoatTexture(atlasUrl: string) {
  const img = await loadImage(atlasUrl);
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, size, size);

  const image = ctx.getImageData(0, 0, size, size);
  const { data } = image;
  const valid = new Uint8Array(size * size);
  let meanR = 0,
    meanG = 0,
    meanB = 0,
    count = 0;
  let minX = size,
    minY = size,
    maxX = 0,
    maxY = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const o = i * 4;
      const luma =
        0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      if (luma > 16 && data[o + 3] > 8) {
        valid[i] = 1;
        meanR += data[o];
        meanG += data[o + 1];
        meanB += data[o + 2];
        count++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (count > 0) {
    meanR /= count;
    meanG /= count;
    meanB /= count;
  } else {
    meanR = meanG = meanB = 128;
  }

  // Grow valid surface colors into black packing until the sheet is full.
  for (let pass = 0; pass < 64; pass++) {
    let grew = 0;
    const snapshot = new Uint8ClampedArray(data);
    const nextValid = valid.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (valid[i]) continue;
        let r = 0,
          g = 0,
          b = 0,
          n = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (dx === 0 && dy === 0) continue;
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
            const j = yy * size + xx;
            if (!valid[j]) continue;
            const o = j * 4;
            r += snapshot[o];
            g += snapshot[o + 1];
            b += snapshot[o + 2];
            n++;
          }
        }
        const o = i * 4;
        if (n > 0) {
          data[o] = r / n;
          data[o + 1] = g / n;
          data[o + 2] = b / n;
          data[o + 3] = 255;
          nextValid[i] = 1;
          grew++;
        } else if (pass > 8) {
          data[o] = meanR;
          data[o + 1] = meanG;
          data[o + 2] = meanB;
          data[o + 3] = 255;
          nextValid[i] = 1;
          grew++;
        }
      }
    }
    valid.set(nextValid);
    if (!grew) break;
  }

  ctx.putImageData(image, 0, 0);

  // Rebuild a denser coat by tiling the content-rich crop 2×2.
  const coat = document.createElement('canvas');
  coat.width = coat.height = size;
  const cctx = coat.getContext('2d')!;
  const pad = 8;
  const sx = Math.max(0, minX - pad);
  const sy = Math.max(0, minY - pad);
  const sw = Math.max(32, Math.min(size - sx, maxX - minX + pad * 2));
  const sh = Math.max(32, Math.min(size - sy, maxY - minY + pad * 2));
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      cctx.drawImage(
        canvas,
        sx,
        sy,
        sw,
        sh,
        (tx * size) / 2,
        (ty * size) / 2,
        size / 2,
        size / 2,
      );
    }
  }
  // Soft blend seams
  cctx.globalAlpha = 0.35;
  cctx.drawImage(canvas, 0, 0, size, size);
  cctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(coat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function makeBorrowedSkinMaterial(map: THREE.Texture) {
  const material = new THREE.MeshStandardMaterial({
    map,
    roughness: 0.62,
    metalness: 0,
  });

  material.onBeforeCompile = (shader) => {
    // Dual scale: broad color fields + finer skin grain for fuller coverage.
    shader.uniforms.uTriScaleA = { value: 0.42 };
    shader.uniforms.uTriScaleB = { value: 1.15 };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vTriPos;
varying vec3 vTriNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vTriPos = transformed;
vTriNormal = normalize(normal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vTriPos;
varying vec3 vTriNormal;
uniform float uTriScaleA;
uniform float uTriScaleB;

vec4 sampleTriplanar(sampler2D tex, vec3 pos, vec3 nor, float scale) {
  vec3 blend = abs(normalize(nor));
  blend = pow(max(blend, vec3(0.0001)), vec3(3.0));
  blend /= dot(blend, vec3(1.0));
  vec4 cx = texture2D(tex, pos.zy * scale + 0.5);
  vec4 cy = texture2D(tex, pos.xz * scale + 0.5);
  vec4 cz = texture2D(tex, pos.xy * scale + 0.5);
  return cx * blend.x + cy * blend.y + cz * blend.z;
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  vec4 coatA = sampleTriplanar(map, vTriPos, vTriNormal, uTriScaleA);
  vec4 coatB = sampleTriplanar(map, vTriPos, vTriNormal, uTriScaleB);
  vec4 sampledDiffuseColor = mix(coatA, coatB, 0.45);
  // Keep the coat saturated and opaque across the whole body.
  sampledDiffuseColor.rgb = mix(
    sampledDiffuseColor.rgb,
    sampledDiffuseColor.rgb * 1.08 + 0.02,
    0.25
  );
  sampledDiffuseColor.a = 1.0;
  diffuseColor *= sampledDiffuseColor;
#endif`,
      );
  };

  material.customProgramCacheKey = () => 'borrowed-coat-dual-triplanar-v2';
  return material;
}

function fitModel(model: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 0.001);
  model.position.sub(center);
  model.scale.setScalar(2.8 / span);
  return span;
}

export default function ModelViewer({
  modelUrl,
  label,
  textureOverride,
}: {
  modelUrl: string;
  label: string;
  textureOverride?: string;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const el = host.current;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 1000);
    camera.position.set(0, 0.25, 4.7);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    el.appendChild(renderer.domElement);

    const group = new THREE.Group();
    scene.add(group);

    const disposables: Array<THREE.Material | THREE.Texture> = [];
    let cancelled = false;

    new GLTFLoader().load(
      modelUrl,
      (gltf) => {
        void (async () => {
          if (cancelled) return;
          const model = gltf.scene;
          fitModel(model);

          if (textureOverride) {
            try {
              const coat = await atlasToCoatTexture(textureOverride);
              if (cancelled) {
                coat.dispose();
                return;
              }
              disposables.push(coat);
              const material = makeBorrowedSkinMaterial(coat);
              disposables.push(material);
              model.traverse((node) => {
                const mesh = node as THREE.Mesh;
                if (!mesh.isMesh) return;
                mesh.material = material;
              });
            } catch {
              el.dataset.error = 'true';
            }
          }

          if (!cancelled) group.add(model);
        })();
      },
      undefined,
      () => {
        el.dataset.error = 'true';
      },
    );

    scene.add(new THREE.HemisphereLight(0xffffff, 0x242638, 2.7));
    const key = new THREE.DirectionalLight(0xffffff, 3.1);
    key.position.set(3, 5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x5366ff, 2);
    rim.position.set(-4, 1, -3);
    scene.add(rim);

    const grid = new THREE.GridHelper(5, 14, 0x4b4d4c, 0x292b2b);
    grid.position.y = -1.55;
    scene.add(grid);

    let down = false,
      lx = 0,
      ly = 0,
      vx = 0.003,
      vy = 0;
    const start = (e: PointerEvent) => {
      down = true;
      lx = e.clientX;
      ly = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!down) return;
      vx = (e.clientX - lx) * 0.01;
      vy = (e.clientY - ly) * 0.007;
      group.rotation.y += vx;
      group.rotation.x += vy;
      lx = e.clientX;
      ly = e.clientY;
    };
    const end = () => {
      down = false;
    };
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);

    const resize = () => {
      const w = el.clientWidth,
        h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let frame = 0;
    const tick = () => {
      if (!down) {
        vx *= 0.94;
        vy *= 0.94;
        group.rotation.y += 0.003 + vx;
        group.rotation.x += vy;
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      el.removeEventListener('pointerdown', start);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      for (const item of disposables) item.dispose();
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, [modelUrl, textureOverride]);

  return (
    <div
      ref={host}
      className="model-canvas"
      aria-label={`${label} uploaded 3D model`}
    >
      <span className="mesh-badge">
        {textureOverride ? 'FULL SKIN COAT' : 'GLB + UV'}
      </span>
      <span className="orbit-hint">drag to orbit</span>
      <span className="axis">X&nbsp;&nbsp;Y&nbsp;&nbsp;Z</span>
    </div>
  );
}
