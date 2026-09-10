import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataRoot = path.join(root, 'data');
export const temporaryDir = path.join(dataRoot, 'temporary');
export const galleryDir = path.join(dataRoot, 'gallery');
export const distDir = path.join(root, 'dist');

export async function ensureStorage() {
  await Promise.all([
    mkdir(temporaryDir, { recursive: true }),
    mkdir(galleryDir, { recursive: true }),
  ]);
}
