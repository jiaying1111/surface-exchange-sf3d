import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

function fitModel(model: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 0.001);
  model.position.sub(center);
  model.scale.setScalar(2.8 / span);
}

function asStandard(
  source: THREE.Material | THREE.Material[],
  mapOverride?: THREE.Texture,
) {
  const first = (Array.isArray(source) ? source[0] : source) as
    | THREE.MeshStandardMaterial
    | THREE.MeshBasicMaterial
    | undefined;
  const map =
    mapOverride ||
    ('map' in (first || {}) ? (first as THREE.MeshStandardMaterial).map : null);
  if (map) {
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    map.needsUpdate = true;
  }
  return new THREE.MeshStandardMaterial({
    map: map || null,
    color: map ? 0xffffff : first && 'color' in first ? first.color : 0xcccccc,
    roughness: 0.72,
    metalness: 0,
  });
}

function loadTexture(url: string) {
  return new Promise<THREE.Texture>((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, reject);
  });
}

export default function ModelViewer({
  modelUrl,
  label,
  materialMapUrl,
}: {
  modelUrl: string;
  label: string;
  /** Other object's detached albedo — swapped onto this body as a plain material map. */
  materialMapUrl?: string;
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

        let override: THREE.Texture | undefined;
        if (materialMapUrl) {
          try {
            override = await loadTexture(materialMapUrl);
            if (cancelled) {
              override.dispose();
              return;
            }
            textures.push(override);
          } catch {
            el.dataset.error = 'true';
          }
        }

        model.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (!mesh.isMesh) return;
          const material = asStandard(mesh.material, override);
          materials.push(material);
          mesh.material = material;
        });

        if (!cancelled) group.add(model);
      },
      undefined,
      () => {
        el.dataset.error = 'true';
      },
    );

    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2c38, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.8);
    key.position.set(3, 5, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 1.2);
    fill.position.set(-3, 2, -2);
    scene.add(fill);

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
  }, [modelUrl, materialMapUrl]);

  return (
    <div
      ref={host}
      className="model-canvas"
      aria-label={`${label} uploaded 3D model`}
    >
      <span className="mesh-badge">
        {materialMapUrl ? 'SWAPPED MATERIAL' : 'ORIGINAL MATERIAL'}
      </span>
      <span className="orbit-hint">drag to orbit</span>
      <span className="axis">X&nbsp;&nbsp;Y&nbsp;&nbsp;Z</span>
    </div>
  );
}
