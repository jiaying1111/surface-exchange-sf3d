import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Fill black atlas packing so the map reads as one continuous skin sheet. */
async function makeContinuousMap(atlasUrl: string) {
  const img = await loadImage(atlasUrl);
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, size, size);
  const imageData = ctx.getImageData(0, 0, size, size);
  const { data } = imageData;
  const empty = new Uint8Array(size * size);

  let sumR = 0,
    sumG = 0,
    sumB = 0,
    solid = 0;
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    const luma = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    if (luma < 22) {
      empty[i] = 1;
      continue;
    }
    empty[i] = 0;
    sumR += data[o];
    sumG += data[o + 1];
    sumB += data[o + 2];
    solid++;
  }

  const avgR = solid ? sumR / solid : 180;
  const avgG = solid ? sumG / solid : 40;
  const avgB = solid ? sumB / solid : 35;
  // How "apple-like" (warm red) the source map is.
  const appleBias = Math.max(0, Math.min(1, (avgR - avgG) / 120));

  for (let iter = 0; iter < 80; iter++) {
    const nextEmpty = new Uint8Array(empty);
    const nextData = new Uint8ClampedArray(data);
    let changed = false;
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = y * size + x;
        if (!empty[i]) continue;
        let r = 0,
          g = 0,
          b = 0,
          n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const j = (y + dy) * size + (x + dx);
            if (empty[j]) continue;
            const o = j * 4;
            r += data[o];
            g += data[o + 1];
            b += data[o + 2];
            n++;
          }
        }
        if (!n) continue;
        const o = i * 4;
        nextData[o] = r / n;
        nextData[o + 1] = g / n;
        nextData[o + 2] = b / n;
        nextData[o + 3] = 255;
        nextEmpty[i] = 0;
        changed = true;
      }
    }
    data.set(nextData);
    empty.set(nextEmpty);
    if (!changed) break;
  }

  // Push residual voids toward the average skin color (helps apple red read solid).
  for (let i = 0; i < size * size; i++) {
    if (!empty[i]) continue;
    const o = i * 4;
    data[o] = avgR;
    data[o + 1] = avgG;
    data[o + 2] = avgB;
    data[o + 3] = 255;
  }

  // Warm / saturate a bit when the source is apple-like.
  if (appleBias > 0.15) {
    for (let i = 0; i < size * size; i++) {
      const o = i * 4;
      data[o] = Math.min(255, data[o] * (1 + 0.12 * appleBias) + 8 * appleBias);
      data[o + 1] = Math.max(0, data[o + 1] * (1 - 0.08 * appleBias));
      data[o + 2] = Math.max(0, data[o + 2] * (1 - 0.1 * appleBias));
    }
  }

  ctx.putImageData(imageData, 0, 0);
  ctx.filter = 'blur(0.8px)';
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = 'none';

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return { texture, appleBias };
}

function makeWrappedMaterial(map: THREE.Texture, appleBias: number) {
  const material = new THREE.MeshPhysicalMaterial({
    map,
    roughness: 0.45 + (1 - appleBias) * 0.3,
    metalness: 0,
    clearcoat: 0.15 + appleBias * 0.55,
    clearcoatRoughness: 0.35 - appleBias * 0.15,
    sheen: appleBias > 0.2 ? 0.15 : 0,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0xfff0e8),
  });

  const scale = 0.38;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTriScale = { value: scale };
    shader.uniforms.uAppleBoost = { value: appleBias };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWrapPos;
varying vec3 vWrapNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vWrapPos = transformed;
vWrapNormal = normalize(normal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWrapPos;
varying vec3 vWrapNormal;
uniform float uTriScale;
uniform float uAppleBoost;

vec4 sampleWrap(sampler2D tex, vec3 pos, vec3 nor) {
  vec3 blend = abs(normalize(nor));
  blend = pow(max(blend, vec3(0.0001)), vec3(3.0));
  blend /= dot(blend, vec3(1.0));
  vec4 x = texture2D(tex, pos.zy * uTriScale);
  vec4 y = texture2D(tex, pos.xz * uTriScale);
  vec4 z = texture2D(tex, pos.xy * uTriScale);
  return x * blend.x + y * blend.y + z * blend.z;
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = sampleWrap(map, vWrapPos, vWrapNormal);
  // Keep apple reds richer on the borrowed body.
  sampledDiffuseColor.rgb = mix(
    sampledDiffuseColor.rgb,
    sampledDiffuseColor.rgb * vec3(1.12, 0.92, 0.88) + vec3(0.04, 0.0, 0.0),
    uAppleBoost
  );
  diffuseColor *= sampledDiffuseColor;
#endif`,
      );
  };
  material.customProgramCacheKey = () =>
    `swap-wrap-${scale.toFixed(2)}-${appleBias.toFixed(2)}`;
  return material;
}

function fitModel(model: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 0.001);
  model.position.sub(center);
  model.scale.setScalar(2.8 / span);
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
    renderer.toneMappingExposure = 1.15;
    el.appendChild(renderer.domElement);

    const group = new THREE.Group();
    scene.add(group);

    const materials: THREE.Material[] = [];
    const textures: THREE.Texture[] = [];
    let cancelled = false;

    new GLTFLoader().load(
      modelUrl,
      async (gltf) => {
        if (cancelled) return;
        const model = gltf.scene;
        fitModel(model);

        if (textureOverride) {
          try {
            const { texture, appleBias } =
              await makeContinuousMap(textureOverride);
            if (cancelled) {
              texture.dispose();
              return;
            }
            textures.push(texture);
            const material = makeWrappedMaterial(texture, appleBias);
            materials.push(material);
            model.traverse((node) => {
              const mesh = node as THREE.Mesh;
              if (mesh.isMesh) mesh.material = material;
            });
          } catch {
            el.dataset.error = 'true';
          }
        }

        if (!cancelled) group.add(model);
      },
      undefined,
      () => {
        el.dataset.error = 'true';
      },
    );

    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2030, 2.5));
    const key = new THREE.DirectionalLight(0xfff2e8, 3.2);
    key.position.set(3, 5, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffd0c0, 1.1);
    fill.position.set(-2, 2, 2);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0x5366ff, 1.6);
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
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
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
        {textureOverride ? 'SWAPPED MAP' : 'GLB + UV'}
      </span>
      <span className="orbit-hint">drag to orbit</span>
      <span className="axis">X&nbsp;&nbsp;Y&nbsp;&nbsp;Z</span>
    </div>
  );
}
