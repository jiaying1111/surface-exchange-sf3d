import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const BAKE_SIZE = 1024;

const bakeVertexShader = /* glsl */ `
attribute vec3 aObjPos;
attribute vec3 aObjNormal;
varying vec3 vObjPos;
varying vec3 vObjNormal;

void main() {
  vObjPos = aObjPos;
  vObjNormal = normalize(aObjNormal);
  // Flatten the mesh into UV space for atlas baking.
  vec2 uvNdc = uv * 2.0 - 1.0;
  gl_Position = vec4(uvNdc, 0.0, 1.0);
}
`;

const bakeFragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D uSource;
uniform float uTriScale;
varying vec3 vObjPos;
varying vec3 vObjNormal;

vec4 sampleTriplanar(sampler2D tex, vec3 pos, vec3 nor) {
  vec3 blend = abs(normalize(nor));
  blend = pow(max(blend, vec3(0.0001)), vec3(4.0));
  blend /= dot(blend, vec3(1.0));
  vec4 cx = texture2D(tex, pos.zy * uTriScale + 0.5);
  vec4 cy = texture2D(tex, pos.xz * uTriScale + 0.5);
  vec4 cz = texture2D(tex, pos.xy * uTriScale + 0.5);
  return cx * blend.x + cy * blend.y + cz * blend.z;
}

void main() {
  vec4 color = sampleTriplanar(uSource, vObjPos, vObjNormal);
  float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  // Fill atlas packing voids so the baked map reads as a continuous coat.
  if (luma < 0.05) {
    color.rgb = vec3(0.55, 0.12, 0.1);
  }
  gl_FragColor = vec4(color.rgb, 1.0);
}
`;

function ensureUVs(geometry: THREE.BufferGeometry) {
  if (geometry.getAttribute('uv')) return;
  const pos = geometry.getAttribute('position');
  const uvs = new Float32Array(pos.count * 2);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    uvs[i * 2] = 0.5 + Math.atan2(v.z, v.x) / (Math.PI * 2);
    uvs[i * 2 + 1] = 0.5 - Math.asin(THREE.MathUtils.clamp(v.y, -1, 1)) / Math.PI;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

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

/** Bake borrowed albedo into this mesh's own UV atlas (real texture map). */
function bakeTextureMap(
  renderer: THREE.WebGLRenderer,
  mesh: THREE.Mesh,
  source: THREE.Texture,
) {
  const geometry = mesh.geometry.clone();
  ensureUVs(geometry);
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();

  // Object-space positions/normals after the parent fit transform.
  mesh.updateWorldMatrix(true, false);
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  const objPos = new Float32Array(pos.count * 3);
  const objNor = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    n.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
    objPos[i * 3] = p.x;
    objPos[i * 3 + 1] = p.y;
    objPos[i * 3 + 2] = p.z;
    objNor[i * 3] = n.x;
    objNor[i * 3 + 1] = n.y;
    objNor[i * 3 + 2] = n.z;
  }

  geometry.setAttribute('aObjPos', new THREE.BufferAttribute(objPos, 3));
  geometry.setAttribute('aObjNormal', new THREE.BufferAttribute(objNor, 3));

  source.colorSpace = THREE.SRGBColorSpace;
  source.wrapS = source.wrapT = THREE.RepeatWrapping;
  source.needsUpdate = true;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSource: { value: source },
      uTriScale: { value: 0.55 },
    },
    vertexShader: bakeVertexShader,
    fragmentShader: bakeFragmentShader,
    side: THREE.DoubleSide,
  });

  const bakeMesh = new THREE.Mesh(geometry, material);
  const scene = new THREE.Scene();
  scene.add(bakeMesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const target = new THREE.WebGLRenderTarget(BAKE_SIZE, BAKE_SIZE, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.SRGBColorSpace,
  });

  const prevTarget = renderer.getRenderTarget();
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;

  renderer.setRenderTarget(target);
  renderer.setClearColor(0x1a0a08, 1);
  renderer.autoClear = true;
  renderer.clear();
  renderer.render(scene, camera);

  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAutoClear;

  material.dispose();
  geometry.dispose();

  const map = target.texture;
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  map.flipY = false;
  map.needsUpdate = true;
  return { map, target };
}

function applyBakedMaps(
  renderer: THREE.WebGLRenderer,
  model: THREE.Object3D,
  source: THREE.Texture,
) {
  const materials: THREE.Material[] = [];
  const targets: THREE.WebGLRenderTarget[] = [];

  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const { map, target } = bakeTextureMap(renderer, mesh, source);
    targets.push(target);
    const material = new THREE.MeshStandardMaterial({
      map,
      roughness: 0.7,
      metalness: 0,
    });
    materials.push(material);
    mesh.material = material;
  });

  return { materials, targets };
}

function loadTexture(url: string) {
  return new Promise<THREE.Texture>((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, reject);
  });
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
    renderer.toneMappingExposure = 1.1;
    el.appendChild(renderer.domElement);

    const group = new THREE.Group();
    scene.add(group);

    const materials: THREE.Material[] = [];
    const targets: THREE.WebGLRenderTarget[] = [];
    let cancelled = false;

    new GLTFLoader().load(
      modelUrl,
      async (gltf) => {
        if (cancelled) return;
        const model = gltf.scene;
        fitModel(model);

        if (textureOverride) {
          try {
            const source = await loadTexture(textureOverride);
            if (cancelled) return;
            const baked = applyBakedMaps(renderer, model, source);
            materials.push(...baked.materials);
            targets.push(...baked.targets);
            source.dispose();
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
      for (const target of targets) target.dispose();
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
        {textureOverride ? 'BAKED TEXTURE MAP' : 'GLB + UV'}
      </span>
      <span className="orbit-hint">drag to orbit</span>
      <span className="axis">X&nbsp;&nbsp;Y&nbsp;&nbsp;Z</span>
    </div>
  );
}
