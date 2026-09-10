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

/**
 * Turn a packed UV atlas (charts on black) into one continuous skin sheet
 * by flooding empty packing pixels with nearby surface colors.
 */
async function atlasToContinuousSkin(atlasUrl: string) {
  const img = await loadImage(atlasUrl);
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, 0, 0, size, size);

  const imageData = ctx.getImageData(0, 0, size, size);
  const { data } = imageData;
  const empty = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    const luma = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    empty[i] = luma < 22 ? 1 : 0;
  }

  // Grow surface colors into the black packing until the sheet is solid.
  for (let iter = 0; iter < 96; iter++) {
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
            if (dx === 0 && dy === 0) continue;
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

  ctx.putImageData(imageData, 0, 0);
  // Soft pass so the skin reads as one ordinary continuous map.
  ctx.filter = 'blur(1.2px)';
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = 'none';

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function makeTriplanarSkinMaterial(map: THREE.Texture, scale: number) {
  const material = new THREE.MeshStandardMaterial({
    map,
    roughness: 0.7,
    metalness: 0,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTriScale = { value: scale };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vSkinPos;
varying vec3 vSkinNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vSkinPos = transformed;
vSkinNormal = normalize(normal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vSkinPos;
varying vec3 vSkinNormal;
uniform float uTriScale;

vec4 sampleSkin(sampler2D tex, vec3 pos, vec3 nor) {
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
  vec4 sampledDiffuseColor = sampleSkin(map, vSkinPos, vSkinNormal);
  diffuseColor *= sampledDiffuseColor;
#endif`,
      );
  };

  material.customProgramCacheKey = () => `full-skin-triplanar-${scale.toFixed(3)}`;
  return material;
}

function fitModel(model: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 0.001);
  model.position.sub(center);
  model.scale.setScalar(2.8 / span);
  model.updateMatrixWorld(true);
}

export default function ModelViewer({
  modelUrl,
  label,
  skinAtlasUrl,
}: {
  modelUrl: string;
  label: string;
  /** Other body's UV atlas — converted into one continuous skin map. */
  skinAtlasUrl?: string;
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

    const materials: THREE.Material[] = [];
    const textures: THREE.Texture[] = [];
    let cancelled = false;

    new GLTFLoader().load(
      modelUrl,
      async (gltf) => {
        if (cancelled) return;
        const model = gltf.scene;
        fitModel(model);

        if (skinAtlasUrl) {
          try {
            const skin = await atlasToContinuousSkin(skinAtlasUrl);
            if (cancelled) {
              skin.dispose();
              return;
            }
            textures.push(skin);
            // Dense enough to read as apple peel / fur, not stretched bands.
            const material = makeTriplanarSkinMaterial(skin, 0.42);
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
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, [modelUrl, skinAtlasUrl]);

  return (
    <div
      ref={host}
      className="model-canvas"
      aria-label={`${label} uploaded 3D model`}
    >
      <span className="mesh-badge">
        {skinAtlasUrl ? 'FULL SKIN TEXTURE' : 'GLB + UV'}
      </span>
      <span className="orbit-hint">drag to orbit</span>
      <span className="axis">X&nbsp;&nbsp;Y&nbsp;&nbsp;Z</span>
    </div>
  );
}
