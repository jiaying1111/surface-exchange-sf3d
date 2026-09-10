import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, handle_file } from '@gradio/client';
import type { Request, Response } from 'express';
import { temporaryDir } from './storage';

const DEFAULT_SPACE = process.env.SF3D_SPACE_ID || 'Upsampler/stable-fast-3d';
const DEFAULT_ENDPOINT = process.env.SF3D_API_NAME || '/image_to_glb';

type GradioFile = { url?: string; path?: string };

type Job =
  | { status: 'queued' | 'running'; createdAt: number }
  | { status: 'done'; createdAt: number; modelUrl: string }
  | { status: 'error'; createdAt: number; error: string };

const jobs = new Map<string, Job>();

function dataUrlToBlob(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!match) throw new Error('Please upload a PNG, JPEG, or WebP image.');
  const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: match[1] });
}

async function imageFromRequest(req: Request) {
  if (req.file) {
    return new Blob([new Uint8Array(req.file.buffer)], {
      type: req.file.mimetype || 'image/jpeg',
    });
  }
  const image = (req.body as { image?: string })?.image;
  if (typeof image === 'string' && image.startsWith('data:')) {
    return dataUrlToBlob(image);
  }
  throw new Error('Missing image.');
}

function explain(raw: string) {
  if (raw.includes('ZeroGPU runs limit')) {
    return 'Free GPU quota is exhausted. Use a Hugging Face Pro token or try again after the quota resets.';
  }
  if (raw === 'An error occurred') {
    return 'The free SF3D GPU is temporarily unavailable. Please wait a minute and try again.';
  }
  if (/load failed|failed to fetch|networkerror|ENOTFOUND|ECONNRESET/i.test(raw)) {
    return 'Could not reach Hugging Face Stable Fast 3D. Check your token and network, then try again.';
  }
  return raw || 'Stable Fast 3D generation failed.';
}

async function runJob(jobId: string, blob: Blob, token: string) {
  jobs.set(jobId, { status: 'running', createdAt: Date.now() });
  try {
    const client = await Client.connect(DEFAULT_SPACE, {
      token: token as `hf_${string}`,
    });
    const result = await client.predict(DEFAULT_ENDPOINT, {
      input_image: handle_file(blob),
      foreground_ratio: 0.85,
      remesh_option: 'None',
      vertex_count: -1,
      texture_size: 512,
    });

    const model = (result.data as GradioFile[])?.[0];
    const remoteUrl =
      model?.url ||
      (model?.path ? `${client.config?.root}/file=${model.path}` : undefined);
    if (!remoteUrl) throw new Error('Stable Fast 3D returned no model.');

    const downloaded = await fetch(remoteUrl);
    if (!downloaded.ok) {
      throw new Error('The generated GLB could not be retrieved from Hugging Face.');
    }
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    const id = randomUUID();
    await writeFile(path.join(temporaryDir, `${id}.glb`), bytes);
    jobs.set(jobId, {
      status: 'done',
      createdAt: Date.now(),
      modelUrl: `/api/generated/${id}`,
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : '';
    jobs.set(jobId, {
      status: 'error',
      createdAt: Date.now(),
      error: explain(raw),
    });
  }
}

export async function generateSf3d(req: Request, res: Response) {
  try {
    const token =
      (req.headers['x-hf-token'] as string | undefined) || process.env.HF_TOKEN;
    if (!token) {
      res.status(401).json({
        error: 'Enter a Hugging Face token before generating.',
      });
      return;
    }

    const blob = await imageFromRequest(req);
    const jobId = randomUUID();
    jobs.set(jobId, { status: 'queued', createdAt: Date.now() });
    // Run Gradio off the request path so proxies/tunnels stay healthy.
    void runJob(jobId, blob, token);
    res.status(202).json({ jobId, statusUrl: `/api/sf3d/${jobId}` });
  } catch (error) {
    const raw = error instanceof Error ? error.message : '';
    res.status(400).json({ error: explain(raw) });
  }
}

export function getSf3dJob(req: Request, res: Response) {
  const jobId = String(req.params.id || '');
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }
  res.json(job);
}
