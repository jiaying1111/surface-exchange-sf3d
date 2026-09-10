import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { getGalleryFile, listGallery, saveGallery } from './gallery';
import { checkToken, generateSf3d, getSf3dJob } from './sf3d';
import { dataRoot, distDir, ensureStorage, temporaryDir } from './storage';

function loadEnv() {
  const envPath = path.resolve(dataRoot, '..', '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i <= 0) continue;
    const key = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const app = express();
const port = Number(process.env.PORT || 8787);

app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'surface-exchange-sf3d',
    hasHfToken: Boolean(process.env.HF_TOKEN),
  });
});

app.post('/api/sf3d', upload.single('image'), generateSf3d);
app.get('/api/sf3d/:id', getSf3dJob);
app.post('/api/hf/whoami', express.json({ limit: '32kb' }), checkToken);

app.get('/api/generated/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-f0-9-]{36}$/.test(id)) {
    res.status(404).send('Not found');
    return;
  }
  try {
    const bytes = await readFile(path.join(temporaryDir, `${id}.glb`));
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(bytes);
  } catch {
    res.status(404).send('Not found');
  }
});

app.get('/api/gallery', listGallery);
app.post(
  '/api/gallery',
  upload.fields([
    { name: 'a', maxCount: 1 },
    { name: 'b', maxCount: 1 },
    { name: 'surfaceA', maxCount: 1 },
    { name: 'surfaceB', maxCount: 1 },
  ]),
  saveGallery,
);
app.get('/api/gallery/:id/:file', getGalleryFile);

app.use(express.static(distDir));
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) next();
  });
});

await ensureStorage();
app.listen(port, '0.0.0.0', () => {
  console.log(`Surface Exchange API on http://0.0.0.0:${port}`);
});
