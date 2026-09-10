import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Center the model at origin and normalize size so framing is consistent. */
function prepareModel(model: THREE.Object3D) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 0.001);
  model.position.sub(center);
  model.scale.setScalar(1 / span);
  model.updateMatrixWorld(true);
}

/** Place camera so the whole object fits inside the viewport with margin. */
function frameCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  aspect: number,
) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fitHeight = maxDim / (2 * Math.tan(fov / 2));
  const fitWidth = fitHeight / Math.max(aspect, 0.001);
  const distance = Math.max(fitHeight, fitWidth) * 1.55;
  camera.position.set(center.x, center.y + maxDim * 0.04, center.z + distance);
  camera.near = Math.max(0.01, distance / 100);
  camera.far = distance * 100;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return { center, maxDim, distance };
}

/** Ordinary photo as a full surface coat — object-space projection, no mesh UV atlas. */
function makePhotoMaterial(map: THREE.Texture) {
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  map.needsUpdate = true;

  const material = new THREE.MeshStandardMaterial({
    map,
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPhotoScale = { value: 0.42 };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vPhotoPos;
varying vec3 vPhotoNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vPhotoPos = transformed;
vPhotoNormal = normalize(normal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vPhotoPos;
varying vec3 vPhotoNormal;
uniform float uPhotoScale;

vec4 samplePhotoCoat(sampler2D tex, vec3 pos, vec3 nor) {
  vec3 blend = abs(normalize(nor));
  blend = pow(max(blend, vec3(0.0001)), vec3(4.0));
  blend /= (blend.x + blend.y + blend.z);
  vec2 ux = clamp(pos.zy * uPhotoScale + 0.5, 0.0, 1.0);
  vec2 uy = clamp(pos.xz * uPhotoScale + 0.5, 0.0, 1.0);
  vec2 uz = clamp(pos.xy * uPhotoScale + 0.5, 0.0, 1.0);
  return texture2D(tex, ux) * blend.x
       + texture2D(tex, uy) * blend.y
       + texture2D(tex, uz) * blend.z;
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = samplePhotoCoat(map, vPhotoPos, vPhotoNormal);
  diffuseColor *= sampledDiffuseColor;
#endif`,
      );
  };

  material.customProgramCacheKey = () => 'ordinary-photo-coat';
  return material;
}

function asOriginal(source: THREE.Material | THREE.Material[]) {
  const first = (Array.isArray(source) ? source[0] : source) as
    | THREE.MeshStandardMaterial
    | undefined;
  const map = first?.map || null;
  if (map) {
    map.colorSpace = THREE.SRGBColorSpace;
    map.needsUpdate = true;
  }
  return new THREE.MeshStandardMaterial({
    map,
    color: map ? 0xffffff : first?.color || 0xcccccc,
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
  /** Other object's ordinary photo — painted onto this body. */
  materialMapUrl?: string;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const el = host.current;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 1000);
    camera.position.set(0, 0.1, 3.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    el.appendChild(renderer.domElement);

    const group = new THREE.Group();
    scene.add(group);

    const materials: THREE.Material[] = [];
    const textures: THREE.Texture[] = [];
    let cancelled = false;
    let framed = false;

    const grid = new THREE.GridHelper(4, 12, 0x4b4d4c, 0x292b2b);
    grid.position.y = -0.55;
    scene.add(grid);

    const resize = () => {
      const w = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (framed && group.children.length) {
        frameCamera(camera, group, camera.aspect);
        const box = new THREE.Box3().setFromObject(group);
        grid.position.y = box.min.y - 0.02;
      }
    };

    new GLTFLoader().load(
      modelUrl,
      async (gltf) => {
        if (cancelled) return;
        const model = gltf.scene;
        prepareModel(model);

        let photoMat: THREE.MeshStandardMaterial | undefined;
        if (materialMapUrl) {
          try {
            const tex = await loadTexture(materialMapUrl);
            if (cancelled) {
              tex.dispose();
              return;
            }
            textures.push(tex);
            photoMat = makePhotoMaterial(tex);
            materials.push(photoMat);
          } catch {
            el.dataset.error = 'true';
          }
        }

        model.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (!mesh.isMesh) return;
          if (photoMat) {
            mesh.material = photoMat;
          } else {
            const material = asOriginal(mesh.material);
            materials.push(material);
            mesh.material = material;
          }
        });

        if (cancelled) return;
        group.clear();
        group.add(model);
        framed = true;
        resize();
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
      group.rotation.x = THREE.MathUtils.clamp(
        group.rotation.x + vy,
        -0.85,
        0.85,
      );
      lx = e.clientX;
      ly = e.clientY;
    };
    const end = () => {
      down = false;
    };
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let frame = 0;
    const tick = () => {
      if (!down) {
        vx *= 0.94;
        vy *= 0.94;
        group.rotation.y += 0.003 + vx;
        group.rotation.x += vy * 0.2;
        group.rotation.x = THREE.MathUtils.clamp(group.rotation.x, -0.85, 0.85);
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
        {materialMapUrl ? 'SWAPPED PHOTO MAP' : 'ORIGINAL MATERIAL'}
      </span>
      <span className="orbit-hint">drag to orbit</span>
      <span className="axis">X&nbsp;&nbsp;Y&nbsp;&nbsp;Z</span>
    </div>
  );
}
