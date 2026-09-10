import { ChangeEvent, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Archive,
  Box,
  Check,
  ImagePlus,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  Scissors,
  X,
} from 'lucide-react';
import ModelViewer from './model-viewer';
import Gallery, { GalleryEntry } from './gallery';
import { prepareContinuousSkin } from './skin-transfer';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

type Obj = {
  name: string;
  preview: string;
  data: string;
  modelUrl?: string;
  modelFile?: File;
  /** Gallery archive id when reopened from Gallery. */
  galleryId?: string;
};
type Phase = 'idle' | 'geometry' | 'ready' | 'swapped';
/** Ordinary material maps (photos, or continuous skins from GLB). */
type Maps = { a?: string; b?: string };

/** Pull albedo from a GLB, then fill packing gaps into one ordinary wrap map. */
async function mapFromModel(modelUrl: string) {
  const atlas = await new Promise<string>((resolve, reject) => {
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
        if (!image) {
          reject(new Error('No material map in this GLB.'));
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1024;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(image, 0, 0, 1024, 1024);
        resolve(canvas.toDataURL('image/png'));
      },
      undefined,
      () => reject(new Error('Could not read material from GLB.')),
    );
  });
  return prepareContinuousSkin(atlas);
}

async function resolveMap(obj: Obj, side: 'a' | 'b') {
  if (obj.data) return obj.data;
  if (obj.galleryId) {
    return `/api/gallery/${obj.galleryId}/surface-${side}.png`;
  }
  if (!obj.modelUrl) throw new Error('Missing model.');
  return mapFromModel(obj.modelUrl);
}

const fileData = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

/** Shrink photos before SF3D so tunnel / Worker uploads stay reliable. */
async function prepareImage(dataUrl: string, maxSide = 1024) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read the uploaded photo.'));
    img.src = dataUrl;
  });
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.9);
}

function explainFailure(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || '');
  if (/load failed|failed to fetch|networkerror|bad gateway|502/i.test(raw)) {
    return 'Network failed while talking to Stable Fast 3D. Check that the API server is running and your Hugging Face token is valid.';
  }
  if (/string did not match the expected pattern|InvalidCharacterError/i.test(raw)) {
    return 'Image could not be decoded. Use a smaller PNG or JPEG and try again.';
  }
  return raw || 'Stable Fast 3D generation failed';
}

async function dataUrlToBlob(dataUrl: string) {
  const match = dataUrl.match(
    /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i,
  );
  if (!match) throw new Error('Could not read image data.');
  const mime = (match[1] || 'image/jpeg').replace('image/jpg', 'image/jpeg');
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  if (!isBase64) {
    return new Blob([decodeURIComponent(payload)], { type: mime });
  }
  let b64 = payload.replace(/\s/g, '');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function urlToBlob(url: string) {
  if (url.startsWith('data:')) return dataUrlToBlob(url);
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load image.');
  return response.blob();
}

async function generateOne(image: string, token: string) {
  let response: Response;
  try {
    const prepared = await prepareImage(image);
    const blob = await dataUrlToBlob(prepared);
    const form = new FormData();
    form.append('image', blob, 'photo.jpg');
    form.append('token', token.trim());
    response = await fetch('/api/sf3d', {
      method: 'POST',
      headers: { 'x-hf-token': token.trim() },
      body: form,
    });
  } catch (error) {
    throw new Error(explainFailure(error));
  }

  const startText = await response.text();
  let start: { error?: string; jobId?: string; modelUrl?: string } = {};
  try {
    start = startText ? JSON.parse(startText) : {};
  } catch {
    throw new Error(
      explainFailure(
        new Error(`HTTP ${response.status}: ${startText.slice(0, 80)}`),
      ),
    );
  }
  if (!response.ok && response.status !== 202) {
    throw new Error(
      explainFailure(new Error(start.error || `HTTP ${response.status}`)),
    );
  }

  // Legacy sync response
  let modelUrl = start.modelUrl;
  if (!modelUrl && start.jobId) {
    const statusUrl = `/api/sf3d/${start.jobId}`;
    const deadline = Date.now() + 8 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const statusRes = await fetch(statusUrl);
      const status = (await statusRes.json()) as {
        status?: string;
        modelUrl?: string;
        error?: string;
      };
      if (!statusRes.ok) {
        throw new Error(status.error || 'Generation job failed.');
      }
      if (status.status === 'done' && status.modelUrl) {
        modelUrl = status.modelUrl;
        break;
      }
      if (status.status === 'error') {
        throw new Error(status.error || 'Stable Fast 3D generation failed.');
      }
    }
    if (!modelUrl) {
      throw new Error('Stable Fast 3D timed out. Please try again.');
    }
  }
  if (!modelUrl) throw new Error('Stable Fast 3D returned no model URL.');

  const binary = await fetch(modelUrl).then((res) => {
    if (!res.ok) throw new Error('Could not download the generated GLB.');
    return res.blob();
  });
  return {
    url: modelUrl,
    file: new File([binary], 'stable-fast-3d.glb', {
      type: 'model/gltf-binary',
    }),
  };
}

function Slot({
  label,
  obj,
  materialMapUrl,
  onPick,
  onClear,
}: {
  label: string;
  obj: Obj | null;
  materialMapUrl?: string;
  onPick: (f: File) => void;
  onClear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section className="slot">
      <div className="slot-head">
        <b>{label}</b>
        <span>
          {obj?.modelUrl
            ? 'SF3D MODEL READY'
            : obj
              ? 'IMAGE READY'
              : 'SOURCE OBJECT'}
        </span>
      </div>
      <div className="viewport">
        {!obj ? (
          <button className="upload" onClick={() => input.current?.click()}>
            <span>
              <ImagePlus size={23} />
            </span>
            <b>ADD OBJECT PHOTO</b>
            <small>one object · clear background · full body</small>
          </button>
        ) : obj.modelUrl ? (
          <ModelViewer
            modelUrl={obj.modelUrl}
            label={label}
            materialMapUrl={materialMapUrl}
          />
        ) : (
          <div className="source-preview">
            <img src={obj.preview} alt={`${label} source`} />
            <span>awaiting reconstruction</span>
          </div>
        )}
        <input
          ref={input}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            e.target.value = '';
          }}
        />
        {obj && (
          <button
            className="clear"
            onClick={onClear}
            aria-label={`Remove ${label}`}
          >
            <X size={15} />
          </button>
        )}
      </div>
      <div className="slot-foot">
        <span>{obj?.name || 'NO INPUT'}</span>
        {obj?.modelUrl && (
          <span className="ready">
            <Check size={13} /> MATERIAL READY
          </span>
        )}
      </div>
    </section>
  );
}

function TokenPrompt({
  onCancel,
  onContinue,
}: {
  onCancel: () => void;
  onContinue: (token: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="token-prompt">
      <KeyRound size={17} />
      <b>HUGGING FACE TOKEN</b>
      <input
        ref={input}
        type="password"
        autoFocus
        placeholder="hf_…"
        aria-label="Hugging Face token"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && input.current?.value.trim())
            onContinue(input.current.value.trim());
        }}
      />
      <small>
        USE A USER ACCESS TOKEN FROM YOUR PRO ACCOUNT. ZEROGPU STILL HAS A DAILY
        QUOTA.
      </small>
      <div>
        <button onClick={onCancel}>CANCEL</button>
        <button
          className="token-continue"
          onClick={() => {
            if (input.current?.value.trim())
              onContinue(input.current.value.trim());
          }}
        >
          CONTINUE
        </button>
      </div>
    </div>
  );
}

export default function Home() {
  const [a, setA] = useState<Obj | null>(null),
    [b, setB] = useState<Obj | null>(null),
    [phase, setPhase] = useState<Phase>('idle'),
    [detached, setDetached] = useState(false),
    [maps, setMaps] = useState<Maps>({}),
    [progress, setProgress] = useState<[number, number]>([0, 0]),
    [error, setError] = useState(''),
    [archiveState, setArchiveState] = useState<
      'idle' | 'saving' | 'saved' | 'error'
    >('idle'),
    [galleryKey, setGalleryKey] = useState(0),
    [showToken, setShowToken] = useState(false);

  const pick = async (side: 'a' | 'b', f: File) => {
    const data = await fileData(f),
      next = {
        name: f.name.replace(/\.[^.]+$/, ''),
        preview: URL.createObjectURL(f),
        data,
      };
    side === 'a' ? setA(next) : setB(next);
    setPhase('idle');
    setDetached(false);
    setMaps({});
    setError('');
    setProgress([0, 0]);
    setArchiveState('idle');
  };

  const generate = async (token: string) => {
    if (!a || !b) return;
    const cleaned = token.trim();
    setShowToken(false);
    setError('');
    setPhase('geometry');
    setDetached(false);
    setMaps({});
    setProgress([8, 8]);
    try {
      const who = await fetch('/api/hf/whoami', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hf-token': cleaned,
        },
        body: JSON.stringify({ token: cleaned }),
      });
      const whoData = await who.json();
      if (!who.ok) {
        throw new Error(whoData.error || 'Hugging Face token was rejected.');
      }

      // Sequential: parallel ZeroGPU calls burn quota/runs twice as fast.
      const modelA = await generateOne(a.data, cleaned);
      setProgress((p) => [100, p[1]]);
      const modelB = await generateOne(b.data, cleaned);
      setProgress((p) => [p[0], 100]);
      setA({ ...a, modelUrl: modelA.url, modelFile: modelA.file });
      setB({ ...b, modelUrl: modelB.url, modelFile: modelB.file });
      setPhase('ready');
    } catch (e) {
      setError(explainFailure(e));
      setPhase('idle');
    }
  };

  const reset = () => {
    setA(null);
    setB(null);
    setPhase('idle');
    setDetached(false);
    setMaps({});
    setError('');
    setProgress([0, 0]);
    setArchiveState('idle');
  };

  const openPair = (entry: GalleryEntry) => {
    reset();
    setA({
      name: entry.a.name.replace(/\.glb$/i, ''),
      preview: `/api/gallery/${entry.id}/surface-a.png`,
      data: '',
      modelUrl: `/api/gallery/${entry.id}/a.glb`,
      galleryId: entry.id,
    });
    setB({
      name: entry.b.name.replace(/\.glb$/i, ''),
      preview: `/api/gallery/${entry.id}/surface-b.png`,
      data: '',
      modelUrl: `/api/gallery/${entry.id}/b.glb`,
      galleryId: entry.id,
    });
    setPhase('ready');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const [detaching, setDetaching] = useState(false);

  const detach = async () => {
    if (!a?.modelUrl || !b?.modelUrl || detaching) return;
    setError('');
    setDetaching(true);
    try {
      const [mapA, mapB] = await Promise.all([
        resolveMap(a, 'a'),
        resolveMap(b, 'b'),
      ]);
      setMaps({ a: mapA, b: mapB });
      setDetached(true);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not detach material maps from these models.',
      );
    } finally {
      setDetaching(false);
    }
  };

  const archive = async () => {
    if (
      !a?.modelFile ||
      !b?.modelFile ||
      !maps.a ||
      !maps.b ||
      archiveState === 'saving'
    )
      return;
    setArchiveState('saving');
    try {
      const form = new FormData();
      form.append('a', a.modelFile);
      form.append('b', b.modelFile);
      form.append(
        'surfaceA',
        new File([await urlToBlob(maps.a)], 'surface-a.png', {
          type: 'image/png',
        }),
      );
      form.append(
        'surfaceB',
        new File([await urlToBlob(maps.b)], 'surface-b.png', {
          type: 'image/png',
        }),
      );
      const response = await fetch('/api/gallery', {
        method: 'POST',
        body: form,
      });
      if (!response.ok) throw new Error();
      setArchiveState('saved');
      setGalleryKey((key) => key + 1);
    } catch {
      setArchiveState('error');
    }
  };

  const exchange = () => {
    if (phase === 'swapped') {
      setPhase('ready');
      return;
    }
    setPhase('swapped');
    void archive();
  };

  const busy = phase === 'geometry',
    generated = !!(a?.modelUrl && b?.modelUrl),
    swapped = phase === 'swapped',
    mapsReady = !!(maps.a && maps.b);

  return (
    <main>
      <header className="site-header site-header-simple">
        <a className="wordmark" href="#">
          SURFACE
          <br />
          EXCHANGE
        </a>
        <button className="reset-top" onClick={reset} type="button">
          <RotateCcw size={15} /> reset
        </button>
      </header>

      <div className={`lab ${busy ? 'generating' : ''}`}>
        <Slot
          label="OBJECT A"
          obj={a}
          materialMapUrl={swapped ? maps.b : undefined}
          onPick={(f) => pick('a', f)}
          onClear={() => {
            setA(null);
            setPhase('idle');
            setDetached(false);
            setMaps({});
          }}
        />
        <div className="lab-control">
          <div className="vertical-rule" />
          {busy ? (
            <div className="ai-progress">
              <LoaderCircle />
              <b>SF3D IS RECONSTRUCTING</b>
              <span>
                A&nbsp; {progress[0] === 100 ? 'READY' : 'QUEUED / RUNNING'}
              </span>
              <i style={{ width: `${progress[0]}%` }} />
              <span>
                B&nbsp; {progress[1] === 100 ? 'READY' : 'QUEUED / RUNNING'}
              </span>
              <i style={{ width: `${progress[1]}%` }} />
            </div>
          ) : detached && a?.modelUrl && b?.modelUrl ? (
            <div className="between-surfaces">
              <div className="between-note">
                ORDINARY PHOTO MAPS.
                <br />
                SWAP THEM BETWEEN BODIES.
              </div>
              <article className="surface-map">
                <img src={maps.a} alt="Material A photo" />
                <b>MATERIAL A</b>
              </article>
              <article className="surface-map">
                <img src={maps.b} alt="Material B photo" />
                <b>MATERIAL B</b>
              </article>
              <button
                className="swap3d exchange-button"
                disabled={!mapsReady}
                onClick={exchange}
              >
                <ArrowLeftRight size={18} />
                {swapped ? 'RESTORE' : 'SWAP MAPS'}
              </button>
            </div>
          ) : (
            <>
              {showToken ? (
                <TokenPrompt
                  onCancel={() => setShowToken(false)}
                  onContinue={generate}
                />
              ) : (
                <button
                  disabled={!a || !b || generated}
                  onClick={() => setShowToken(true)}
                >
                  <Box size={18} />
                  GENERATE REAL 3D
                </button>
              )}
              <button
                className="detach-button"
                disabled={!generated || detaching}
                onClick={() => void detach()}
              >
                <Scissors size={16} />
                {detaching ? (
                  <>
                    READING
                    <br />
                    MAPS…
                  </>
                ) : (
                  <>
                    DETACH BOTH
                    <br />
                    MATERIALS
                  </>
                )}
              </button>
            </>
          )}
          <p>
            {busy
              ? 'The free GPU may queue. Keep this tab open while both bodies form.'
              : detached
                ? 'Two ordinary photos are detached as maps. Swap paints each photo onto the other body — no UV atlas grid.'
                : generated
                  ? 'Detach materials from the photos when available, or from each GLB map if you reopened a Gallery pair.'
                  : "Add two isolated photos. Generation runs on this app's own Node API via Hugging Face Stable Fast 3D."}
          </p>
          {error && (
            <div className="api-error">
              <KeyRound size={15} />
              <span>{error}</span>
            </div>
          )}
          <div className="vertical-rule" />
        </div>
        <Slot
          label="OBJECT B"
          obj={b}
          materialMapUrl={swapped ? maps.a : undefined}
          onPick={(f) => pick('b', f)}
          onClear={() => {
            setB(null);
            setPhase('idle');
            setDetached(false);
            setMaps({});
          }}
        />
      </div>

      {swapped && (
        <div className="result-bar">
          <div>
            <span className="result-dot" /> MATERIAL SWAP COMPLETE{' '}
            <small>
              {archiveState === 'saving' ? (
                'ARCHIVING MODELS + MATERIAL MAPS…'
              ) : archiveState === 'saved' ? (
                <>
                  <Archive size={13} /> MODELS + MATERIAL MAPS SAVED
                </>
              ) : archiveState === 'error' ? (
                'COULD NOT SAVE THIS PAIR'
              ) : (
                'THE BODIES REMAIN. THEIR MATERIAL MAPS HAVE CHANGED PLACES.'
              )}
            </small>
          </div>
          <button onClick={() => setPhase('ready')}>ORIGINAL MATERIALS</button>
        </div>
      )}

      <Gallery refreshKey={galleryKey} onOpen={openPair} />

      <footer>
        <span>GEOMETRY BY STABLE FAST 3D.</span>
        <span>SURFACE TRAVELS.</span>
        <span>PERSISTENT ARCHIVE.</span>
      </footer>
    </main>
  );
}
