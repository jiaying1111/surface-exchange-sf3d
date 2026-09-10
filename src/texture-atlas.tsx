import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Pull the first albedo map out of a GLB so it can be swapped as a material. */
export default function TextureAtlas({
  modelUrl,
  label,
  onReady,
}: {
  modelUrl: string;
  label: string;
  onReady: (atlas: string) => void;
}) {
  const [atlas, setAtlas] = useState('');
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let active = true;
    setAtlas('');
    setMissing(false);
    new GLTFLoader().load(
      modelUrl,
      (gltf) => {
        let image: CanvasImageSource | undefined;
        gltf.scene.traverse((node) => {
          if (image || !(node as THREE.Mesh).isMesh) return;
          const material = (node as THREE.Mesh).material as
            | THREE.MeshStandardMaterial
            | THREE.MeshStandardMaterial[];
          const first = Array.isArray(material) ? material[0] : material;
          image = first?.map?.image as CanvasImageSource | undefined;
        });
        if (!active) return;
        if (!image) {
          setMissing(true);
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1024;
        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, 1024, 1024);
        ctx.drawImage(image, 0, 0, 1024, 1024);
        const data = canvas.toDataURL('image/png');
        setAtlas(data);
        onReady(data);
      },
      undefined,
      () => {
        if (active) setMissing(true);
      },
    );
    return () => {
      active = false;
    };
  }, [modelUrl]);

  return (
    <article className="surface-map">
      {atlas ? (
        <img src={atlas} alt={`${label} material map`} />
      ) : (
        <div className="atlas-loading">
          {missing
            ? 'NO MATERIAL MAP\nIN THIS GLB'
            : 'READING\nMATERIAL…'}
        </div>
      )}
      <b>{label}</b>
    </article>
  );
}
