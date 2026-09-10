import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const PEEL_WIDTH = 2048;
const PEEL_HEIGHT = 1024;

const peelBakeVert = /* glsl */ `
attribute vec3 aObjPos;
attribute vec2 aSkinUv;
uniform float uYMin;
uniform float uYMax;
varying vec2 vSkinUv;

void main() {
  vSkinUv = aSkinUv;
  float u = atan(aObjPos.x, aObjPos.z) / (2.0 * 3.14159265) + 0.5;
  float v = clamp((aObjPos.y - uYMin) / max(uYMax - uYMin, 1e-5), 0.0, 1.0);
  gl_Position = vec4(u * 2.0 - 1.0, v * 2.0 - 1.0, 0.0, 1.0);
}
`;

const peelBakeFrag = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uHasMap;
varying vec2 vSkinUv;

void main() {
  vec3 color = uColor;
  if (uHasMap > 0.5) {
    color *= texture2D(uMap, vSkinUv).rgb;
  }
  gl_FragColor = vec4(color, 1.0);
}
`;

function fitModel(model: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 0.001);
  model.position.sub(center);
  model.scale.setScalar(2.8 / span);
  model.updateMatrixWorld(true);
  return span;
}

function worldBounds(root: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(root);
  return {
    yMin: box.min.y,
    yMax: box.max.y,
    radius: Math.max(box.getSize(new THREE.Vector3()).x, box.getSize(new THREE.Vector3()).z, 0.001) * 0.5,
  };
}

function applyCylindricalUVs(geometry: THREE.BufferGeometry, yMin: number, yMax: number) {
  const pos = geometry.getAttribute('position');
  const uvs = new Float32Array(pos.count * 2);
  const p = new THREE.Vector3();
  const range = Math.max(yMax - yMin, 1e-5);
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    uvs[i * 2] = Math.atan2(p.x, p.z) / (Math.PI * 2) + 0.5;
    uvs[i * 2 + 1] = THREE.MathUtils.clamp((p.y - yMin) / range, 0, 1);
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

/**
 * Bake the source body's original textured look into one continuous
 * cylindrical "peel" image — like unwrapping a single apple skin sheet.
 */
function bakeContinuousPeel(
  renderer: THREE.WebGLRenderer,
  sourceRoot: THREE.Object3D,
) {
  const { yMin, yMax } = worldBounds(sourceRoot);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const disposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  sourceRoot.updateMatrixWorld(true);
  sourceRoot.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;

    const srcGeo = mesh.geometry;
    const posAttr = srcGeo.getAttribute('position');
    const uvAttr = srcGeo.getAttribute('uv');
    if (!posAttr) return;

    const geo = new THREE.BufferGeometry();
    const objPos = new Float32Array(posAttr.count * 3);
    const skinUv = new Float32Array(posAttr.count * 2);
    const p = new THREE.Vector3();

    for (let i = 0; i < posAttr.count; i++) {
      p.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      objPos[i * 3] = p.x;
      objPos[i * 3 + 1] = p.y;
      objPos[i * 3 + 2] = p.z;
      if (uvAttr) {
        skinUv[i * 2] = uvAttr.getX(i);
        skinUv[i * 2 + 1] = uvAttr.getY(i);
      } else {
        skinUv[i * 2] = 0.5;
        skinUv[i * 2 + 1] = 0.5;
      }
    }

    geo.setAttribute('aObjPos', new THREE.BufferAttribute(objPos, 3));
    geo.setAttribute('aSkinUv', new THREE.BufferAttribute(skinUv, 2));
    // Dummy position so Three is happy; clip space comes from aObjPos in the shader.
    geo.setAttribute('position', new THREE.BufferAttribute(objPos, 3));
    if (srcGeo.index) geo.setIndex(srcGeo.index.clone());

    const matIn = (
      Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    ) as THREE.MeshStandardMaterial;
    const map = matIn?.map ?? null;
    const color = matIn?.color ? matIn.color.clone() : new THREE.Color(0xffffff);
    if (map) {
      map.colorSpace = THREE.SRGBColorSpace;
      map.needsUpdate = true;
    }

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uColor: { value: color },
        uHasMap: { value: map ? 1 : 0 },
        uYMin: { value: yMin },
        uYMax: { value: yMax },
      },
      vertexShader: peelBakeVert,
      fragmentShader: peelBakeFrag,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });

    disposables.push(geo, material);
    scene.add(new THREE.Mesh(geo, material));
  });

  const target = new THREE.WebGLRenderTarget(PEEL_WIDTH, PEEL_HEIGHT, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.SRGBColorSpace,
  });

  const prev = renderer.getRenderTarget();
  const prevColor = new THREE.Color();
  renderer.getClearColor(prevColor);
  const prevAlpha = renderer.getClearAlpha();

  renderer.setRenderTarget(target);
  renderer.setClearColor(0x6b1d14, 1);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(prev);
  renderer.setClearColor(prevColor, prevAlpha);

  for (const item of disposables) item.dispose();

  const map = target.texture;
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.flipY = false;
  map.needsUpdate = true;
  return { map, target, yMin, yMax };
}

function wrapWithPeel(
  root: THREE.Object3D,
  peel: THREE.Texture,
  yMin: number,
  yMax: number,
) {
  const materials: THREE.Material[] = [];
  root.updateMatrixWorld(true);

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;

    // Build world-space positions into a bake-friendly local copy for UV gen.
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const world = new Float32Array(pos.count * 3);
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      world[i * 3] = p.x;
      world[i * 3 + 1] = p.y;
      world[i * 3 + 2] = p.z;
    }
    const tmp = new THREE.BufferGeometry();
    tmp.setAttribute('position', new THREE.BufferAttribute(world, 3));
    applyCylindricalUVs(tmp, yMin, yMax);
    geo.setAttribute('uv', tmp.getAttribute('uv'));

    const material = new THREE.MeshStandardMaterial({
      map: peel,
      roughness: 0.72,
      metalness: 0,
    });
    materials.push(material);
    mesh.material = material;
  });

  return materials;
}

function loadGltf(url: string) {
  return new Promise<THREE.Group>((resolve, reject) => {
    new GLTFLoader().load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      reject,
    );
  });
}

export default function ModelViewer({
  modelUrl,
  label,
  borrowFromUrl,
}: {
  modelUrl: string;
  label: string;
  /** Other body's GLB — its original textured look becomes one continuous peel map. */
  borrowFromUrl?: string;
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
    renderer.toneMappingExposure = 1.1;
    el.appendChild(renderer.domElement);

    const group = new THREE.Group();
    scene.add(group);

    const materials: THREE.Material[] = [];
    const targets: THREE.WebGLRenderTarget[] = [];
    let cancelled = false;

    (async () => {
      try {
        const model = await loadGltf(modelUrl);
        if (cancelled) return;
        fitModel(model);

        if (borrowFromUrl) {
          const source = await loadGltf(borrowFromUrl);
          if (cancelled) return;
          fitModel(source);
          const peel = bakeContinuousPeel(renderer, source);
          targets.push(peel.target);
          // Match peel vertical framing to the wearing body.
          const body = worldBounds(model);
          materials.push(
            ...wrapWithPeel(model, peel.map, body.yMin, body.yMax),
          );
        }

        if (!cancelled) group.add(model);
      } catch {
        el.dataset.error = 'true';
      }
    })();

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
      for (const target of targets) target.dispose();
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, [modelUrl, borrowFromUrl]);

  return (
    <div
      ref={host}
      className="model-canvas"
      aria-label={`${label} uploaded 3D model`}
    >
      <span className="mesh-badge">
        {borrowFromUrl ? 'CONTINUOUS PEEL MAP' : 'GLB + UV'}
      </span>
      <span className="orbit-hint">drag to orbit</span>
      <span className="axis">X&nbsp;&nbsp;Y&nbsp;&nbsp;Z</span>
    </div>
  );
}
