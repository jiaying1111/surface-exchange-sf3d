import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { galleryDir } from './storage';
import type { Request, Response } from 'express';

export type GalleryEntry = {
  id: string;
  createdAt: string;
  a: { name: string };
  b: { name: string };
  surfaces: true;
};

const ALLOWED_FILES = new Set([
  'a.glb',
  'b.glb',
  'surface-a.png',
  'surface-b.png',
  'record.json',
]);

type MulterFile = {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
};
type Uploaded = { [field: string]: MulterFile[] };

export async function listGallery(_req: Request, res: Response) {
  try {
    const dirs = await readdir(galleryDir, { withFileTypes: true });
    const entries: GalleryEntry[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      try {
        const raw = await readFile(
          path.join(galleryDir, dir.name, 'record.json'),
          'utf8',
        );
        entries.push(JSON.parse(raw) as GalleryEntry);
      } catch {
        // skip incomplete archives
      }
    }
    entries.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    res.json(entries);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Gallery list failed.',
    });
  }
}

export async function saveGallery(req: Request, res: Response) {
  try {
    const files = req.files as Uploaded | undefined;
    const a = files?.a?.[0];
    const b = files?.b?.[0];
    const surfaceA = files?.surfaceA?.[0];
    const surfaceB = files?.surfaceB?.[0];

    if (!a || !b || !surfaceA || !surfaceB) {
      res.status(400).json({
        error: 'Two GLBs and two UV surfaces are required.',
      });
      return;
    }
    if (
      !a.originalname.toLowerCase().endsWith('.glb') ||
      !b.originalname.toLowerCase().endsWith('.glb')
    ) {
      res.status(400).json({ error: 'Only GLB files can be archived.' });
      return;
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const record: GalleryEntry = {
      id,
      createdAt,
      a: { name: a.originalname },
      b: { name: b.originalname },
      surfaces: true,
    };
    const base = path.join(galleryDir, id);
    await mkdir(base, { recursive: true });
    await Promise.all([
      writeFile(path.join(base, 'a.glb'), a.buffer),
      writeFile(path.join(base, 'b.glb'), b.buffer),
      writeFile(path.join(base, 'surface-a.png'), surfaceA.buffer),
      writeFile(path.join(base, 'surface-b.png'), surfaceB.buffer),
      writeFile(path.join(base, 'record.json'), JSON.stringify(record, null, 2)),
    ]);
    res.status(201).json(record);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Gallery save failed.',
    });
  }
}

export async function getGalleryFile(req: Request, res: Response) {
  const id = String(req.params.id || '');
  const file = String(req.params.file || '');
  if (
    !/^[a-f0-9-]{36}$/.test(id) ||
    !ALLOWED_FILES.has(file) ||
    file === 'record.json'
  ) {
    res.status(404).send('Not found');
    return;
  }
  try {
    const bytes = await readFile(path.join(galleryDir, id, file));
    res.setHeader(
      'Content-Type',
      file.endsWith('.glb') ? 'model/gltf-binary' : 'image/png',
    );
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(bytes);
  } catch {
    res.status(404).send('Not found');
  }
}
