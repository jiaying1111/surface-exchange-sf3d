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
import TextureAtlas from './texture-atlas';
import Gallery, { GalleryEntry } from './gallery';

type Obj = {
  name: string;
  preview: string;
  data: string;
  modelUrl?: string;
  modelFile?: File;
};
type Phase = 'idle' | 'geometry' | 'ready' | 'swapped';
type Atlases = { a?: string; b?: string };

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
  return raw || 'Stable Fast 3D generation failed';
}

async function generateOne(image: string, token: string) {
  let response: Response;
  try {
    response = await fetch('/api/sf3d', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hf-token': token },
      body: JSON.stringify({ image: await prepareImage(image) }),
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
  texture,
  onPick,
  onClear,
}: {
  label: string;
  obj: Obj | null;
  texture?: string;
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
            textureOverride={texture}
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
            <Check size={13} /> GLB + UV
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
      <small>USED ONLY FOR THIS GENERATION. NEVER SAVED.</small>
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
    [atlases, setAtlases] = useState<Atlases>({}),
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
    setAtlases({});
    setError('');
    setProgress([0, 0]);
    setArchiveState('idle');
  };

  const generate = async (token: string) => {
    if (!a || !b) return;
    setShowToken(false);
    setError('');
    setPhase('geometry');
    setDetached(false);
    setAtlases({});
    setProgress([8, 8]);
    try {
      const pa = generateOne(a.data, token).then((model) => {
          setProgress((p) => [100, p[1]]);
          return model;
        }),
        pb = generateOne(b.data, token).then((model) => {
          setProgress((p) => [p[0], 100]);
          return model;
        }),
        [modelA, modelB] = await Promise.all([pa, pb]);
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
    setAtlases({});
    setError('');
    setProgress([0, 0]);
    setArchiveState('idle');
  };

  const openPair = (entry: GalleryEntry) => {
    reset();
    setA({
      name: entry.a.name.replace(/\.glb$/i, ''),
      preview: '',
      data: '',
      modelUrl: `/api/gallery/${entry.id}/a.glb`,
    });
    setB({
      name: entry.b.name.replace(/\.glb$/i, ''),
      preview: '',
      data: '',
      modelUrl: `/api/gallery/${entry.id}/b.glb`,
    });
    setPhase('ready');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const archive = async () => {
    if (
      !a?.modelFile ||
      !b?.modelFile ||
      !atlases.a ||
      !atlases.b ||
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
        new File(
          [await fetch(atlases.a).then((r) => r.blob())],
          'surface-a.png',
          { type: 'image/png' },
        ),
      );
      form.append(
        'surfaceB',
        new File(
          [await fetch(atlases.b).then((r) => r.blob())],
          'surface-b.png',
          { type: 'image/png' },
        ),
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
    mapsReady = !!(atlases.a && atlases.b);

  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="#">
          SURFACE
          <br />
          EXCHANGE
        </a>
        <div className="edition">
          OPEN MODEL STUDY <span>№ 06</span>
        </div>
        <button className="reset-top" onClick={reset}>
          <RotateCcw size={15} /> reset
        </button>
      </header>

      <div className="intro three-intro">
        <div>
          <span className="kicker">
            IMAGE → SF3D MESH → UV ATLAS → EXCHANGE
          </span>
          <h1>
            Two real bodies.
            <br />
            <em>Borrowed skins.</em>
          </h1>
        </div>
        <div className="steps">
          <div className={a && b ? 'done' : ''}>
            <b>01</b>
            <span>
              upload
              <br />
              objects
            </span>
          </div>
          <div className={generated ? 'done' : ''}>
            <b>02</b>
            <span>
              generate
              <br />
              3D bodies
            </span>
          </div>
          <div className={detached ? 'done' : ''}>
            <b>03</b>
            <span>
              unwrap
              <br />
              surfaces
            </span>
          </div>
        </div>
      </div>

      <div className={`lab ${busy ? 'generating' : ''}`}>
        <Slot
          label="OBJECT A"
          obj={a}
          texture={swapped ? atlases.b : undefined}
          onPick={(f) => pick('a', f)}
          onClear={() => {
            setA(null);
            setPhase('idle');
            setDetached(false);
            setAtlases({});
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
                THE SURFACE HAS
                <br />
                LEFT THE OBJECT.
              </div>
              <TextureAtlas
                modelUrl={a.modelUrl}
                label="SURFACE A"
                onReady={(atlas) =>
                  setAtlases((current) => ({ ...current, a: atlas }))
                }
              />
              <TextureAtlas
                modelUrl={b.modelUrl}
                label="SURFACE B"
                onReady={(atlas) =>
                  setAtlases((current) => ({ ...current, b: atlas }))
                }
              />
              <button
                className="swap3d exchange-button"
                disabled={!mapsReady}
                onClick={exchange}
              >
                <ArrowLeftRight size={18} />
                {mapsReady ? (swapped ? 'RESTORE' : 'EXCHANGE') : 'UNWRAPPING…'}
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
                disabled={!generated}
                onClick={() => setDetached(true)}
              >
                <Scissors size={16} />
                DETACH BOTH
                <br />
                SURFACES
              </button>
            </>
          )}
          <p>
            {busy
              ? 'The free GPU may queue. Keep this tab open while both bodies form.'
              : detached
                ? 'The two UV atlases are now independent, persistent surfaces.'
                : generated
                  ? 'Detach both surfaces before they can travel.'
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
          texture={swapped ? atlases.a : undefined}
          onPick={(f) => pick('b', f)}
          onClear={() => {
            setB(null);
            setPhase('idle');
            setDetached(false);
            setAtlases({});
          }}
        />
      </div>

      {swapped && (
        <div className="result-bar">
          <div>
            <span className="result-dot" /> SURFACE EXCHANGE COMPLETE{' '}
            <small>
              {archiveState === 'saving' ? (
                'ARCHIVING MODELS + UV SURFACES…'
              ) : archiveState === 'saved' ? (
                <>
                  <Archive size={13} /> MODELS + UV SURFACES SAVED
                </>
              ) : archiveState === 'error' ? (
                'COULD NOT SAVE THIS PAIR'
              ) : (
                'THE BODIES REMAIN. THEIR UV MAPS HAVE CHANGED PLACES.'
              )}
            </small>
          </div>
          <button onClick={() => setPhase('ready')}>ORIGINAL SURFACES</button>
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
