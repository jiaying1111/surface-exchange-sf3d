import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Flood atlas packing gaps so the borrowed skin can coat the whole body. */
function densifyAtlas(source: CanvasImageSource): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source as CanvasImageSource, 0, 0, size, size);

  const img = ctx.getImageData(0, 0, size, size);
  const { data } = img;
  const isInk = (i: number) =>
    data[i] + data[i + 1] + data[i + 2] < 40 && data[i + 3] > 8;

  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (isInk(i)) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  const mean: [number, number, number] = n
    ? [r / n, g / n, b / n]
    : [180, 60, 50];

  // Dilate colored texels into nearby black packing several times.
  let cur = new Uint8ClampedArray(data);
  for (let pass = 0; pass < 10; pass++) {
    const next = new Uint8ClampedArray(cur);
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = (y * size + x) * 4;
        if (cur[i] + cur[i + 1] + cur[i + 2] >= 40) continue;
        let best = -1,
          br = 0,
          bg = 0,
          bb = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (!ox && !oy) continue;
            const j = ((y + oy) * size + (x + ox)) * 4;
            const s = cur[j] + cur[j + 1] + cur[j + 2];
            if (s > best) {
              best = s;
              br = cur[j];
              bg = cur[j + 1];
              bb = cur[j + 2];
            }
          }
        }
        if (best >= 40) {
          next[i] = br;
          next[i + 1] = bg;
          next[i + 2] = bb;
          next[i + 3] = 255;
        }
      }
    }
    cur = next;
  }

  for (let i = 0; i < cur.length; i += 4) {
    if (cur[i] + cur[i + 1] + cur[i + 2] < 40) {
      cur[i] = mean[0];
      cur[i + 1] = mean[1];
      cur[i + 2] = mean[2];
      cur[i + 3] = 255;
    }
    // Push chroma for a more absurd borrowed look.
    const y = 0.299 * cur[i] + 0.587 * cur[i + 1] + 0.114 * cur[i + 2];
    cur[i] = Math.min(255, y + (cur[i] - y) * 1.55);
    cur[i + 1] = Math.min(255, y + (cur[i + 1] - y) * 1.55);
    cur[i + 2] = Math.min(255, y + (cur[i + 2] - y) * 1.55);
  }

  img.data.set(cur);
  ctx.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function loadDensifiedTexture(url: string) {
  return new Promise<THREE.CanvasTexture>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(densifyAtlas(image));
    image.onerror = () => reject(new Error('texture load failed'));
    image.src = url;
  });
}

/**
 * Dense, warped triplanar coat — full coverage, deliberately uncanny.
 */
function makeAbsurdSkinMaterial(map: THREE.Texture) {
  const material = new THREE.MeshStandardMaterial({
    map,
    roughness: 0.55,
    metalness: 0.05,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    material.userData.uTime = shader.uniforms.uTime;

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
uniform float uTime;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec4 sampleTri(sampler2D tex, vec3 pos, vec3 nor, vec3 axisScale, float twist) {
  vec3 blend = abs(normalize(nor));
  blend = pow(max(blend, vec3(0.0001)), vec3(1.6));
  blend /= dot(blend, vec3(1.0));

  vec3 p = pos;
  float a = twist + uTime * 0.15;
  float c = cos(a), s = sin(a);
  p.xz = mat2(c, -s, s, c) * p.xz;
  p += 0.12 * sin(p.yzx * 2.4 + uTime * 0.35);

  vec2 ux = p.zy * axisScale.x + vec2(0.13, 0.07);
  vec2 uy = p.xz * axisScale.y + vec2(-0.09, 0.21);
  vec2 uz = p.xy * axisScale.z + vec2(0.17, -0.11);

  vec4 cx = texture2D(tex, ux);
  vec4 cy = texture2D(tex, uy);
  vec4 cz = texture2D(tex, uz);
  return cx * blend.x + cy * blend.y + cz * blend.z;
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  // Layered coats at different densities = fuller, stranger coverage.
  vec4 coatA = sampleTri(map, vTriPos, vTriNormal, vec3(1.15, 0.95, 1.35), 0.4);
  vec4 coatB = sampleTri(map, vTriPos * 1.7, vTriNormal, vec3(2.4, 2.1, 2.8), -0.9);
  vec4 coatC = sampleTri(map, vTriPos.zyx * 0.8, -vTriNormal, vec3(0.7, 1.1, 0.85), 1.3);
  float wiggle = 0.35 + 0.25 * hash21(vTriPos.xy * 3.0 + uTime);
  vec4 sampledDiffuseColor = mix(coatA, coatB, 0.45);
  sampledDiffuseColor = mix(sampledDiffuseColor, coatC, wiggle * 0.4);

  // Crush blacks, punch saturation for an absurd borrowed-skin look.
  sampledDiffuseColor.rgb = max(sampledDiffuseColor.rgb, vec3(0.04));
  float luma = dot(sampledDiffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  sampledDiffuseColor.rgb = clamp(
    luma + (sampledDiffuseColor.rgb - luma) * 1.7,
    0.0,
    1.0
  );
  sampledDiffuseColor.rgb = pow(sampledDiffuseColor.rgb, vec3(0.9));
  diffuseColor *= sampledDiffuseColor;
#endif`,
      );
  };

  material.customProgramCacheKey = () => 'absurd-full-coat-v2';
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
    renderer.toneMappingExposure = 1.18;
    el.appendChild(renderer.domElement);

    const group = new THREE.Group();
    scene.add(group);

    const disposables: Array<THREE.Material | THREE.Texture> = [];
    let cancelled = false;

    new GLTFLoader().load(
      modelUrl,
      (gltf) => {
        const model = gltf.scene;
        fitModel(model);

        const apply = (material?: THREE.Material) => {
          if (cancelled) return;
          if (material) {
            model.traverse((node) => {
              const mesh = node as THREE.Mesh;
              if (!mesh.isMesh) return;
              mesh.material = material;
            });
          }
          group.add(model);
        };

        if (textureOverride) {
          void loadDensifiedTexture(textureOverride)
            .then((tex) => {
              if (cancelled) {
                tex.dispose();
                return;
              }
              disposables.push(tex);
              const material = makeAbsurdSkinMaterial(tex);
              disposables.push(material);
              apply(material);
            })
            .catch(() => apply());
        } else {
          apply();
        }
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

    const clock = new THREE.Clock();
    let frame = 0;
    const tick = () => {
      if (!down) {
        vx *= 0.94;
        vy *= 0.94;
        group.rotation.y += 0.003 + vx;
        group.rotation.x += vy;
      }
      const t = clock.getElapsedTime();
      for (const item of disposables) {
        if (item instanceof THREE.Material && item.userData.uTime) {
          item.userData.uTime.value = t;
        }
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
        {textureOverride ? 'ABSURD FULL COAT' : 'GLB + UV'}
      </span>
      <span className="orbit-hint">drag to orbit</span>
      <span className="axis">X&nbsp;&nbsp;Y&nbsp;&nbsp;Z</span>
    </div>
  );
}
