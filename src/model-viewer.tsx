import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { prepareContinuousSkin } from './skin-transfer';

/**
 * Dual-scale triplanar coat: large unbroken color regions + finer skin detail.
 * Uses a continuous skin plate derived from the donor atlas (not raw UV packing).
 */
function makeBorrowedSkinMaterial(map: THREE.Texture) {
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.MirroredRepeatWrapping;
  map.anisotropy = 8;
  map.needsUpdate = true;

  const material = new THREE.MeshStandardMaterial({
    map,
    roughness: 0.62,
    metalness: 0.02,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTriScaleLarge = { value: 0.22 };
    shader.uniforms.uTriScaleFine = { value: 0.85 };
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
uniform float uTriScaleLarge;
uniform float uTriScaleFine;

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
  vec4 largeColor = sampleTriplanar(map, vTriPos, vTriNormal, uTriScaleLarge);
  vec4 fineColor = sampleTriplanar(map, vTriPos, vTriNormal, uTriScaleFine);
  // Prefer broad continuous coat, keep fine pigment variation.
  vec4 sampledDiffuseColor = mix(largeColor, fineColor, 0.28);
  sampledDiffuseColor.rgb = pow(max(sampledDiffuseColor.rgb, vec3(0.0)), vec3(0.92));
  diffuseColor *= sampledDiffuseColor;
#endif`,
      );
  };

  material.customProgramCacheKey = () => 'borrowed-skin-dual-triplanar-v2';
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
    let cancelled = false;
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

    const loadModel = async () => {
      const gltf = await new Promise<GLTF>((resolve, reject) => {
        new GLTFLoader().load(modelUrl, resolve, undefined, reject);
      });
      if (cancelled) return;

      const model = gltf.scene;
      fitModel(model);

      if (textureOverride) {
        const skinUrl = await prepareContinuousSkin(textureOverride, 768);
        if (cancelled) return;
        const tex = await new Promise<THREE.Texture>((resolve, reject) => {
          new THREE.TextureLoader().load(skinUrl, resolve, undefined, reject);
        });
        if (cancelled) {
          tex.dispose();
          return;
        }
        disposables.push(tex);
        const material = makeBorrowedSkinMaterial(tex);
        disposables.push(material);
        model.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.material = material;
        });
      }

      group.add(model);
    };

    loadModel().catch(() => {
      if (!cancelled) el.dataset.error = 'true';
    });

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
        {textureOverride ? 'CONTINUOUS SKIN' : 'GLB + UV'}
      </span>
      <span className="orbit-hint">drag to orbit</span>
      <span className="axis">X&nbsp;&nbsp;Y&nbsp;&nbsp;Z</span>
    </div>
  );
}
