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
  | { status: 'error'; createdAt: number; error: string; detail?: string };

const jobs = new Map<string, Job>();

function cleanToken(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^Bearer\s+/i, '');
}

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
  if (/ZeroGPU runs limit|ZeroGPU quota exceeded|GPU quota/i.test(raw)) {
    return 'Hugging Face ZeroGPU quota is exhausted for this account. Pro includes more daily GPU time, but it can still run out — wait for the 24h reset, or add ZeroGPU credits at https://huggingface.co/settings/billing';
  }
  if (raw === 'An error occurred') {
    return 'Stable Fast 3D GPU is temporarily unavailable. Wait a minute and try again.';
  }
  if (/401|Unauthorized|Invalid username or password|Invalid credentials/i.test(raw)) {
    return 'Hugging Face rejected this token. Create a user access token (Read) at https://huggingface.co/settings/tokens while logged into your Pro account.';
  }
  if (/load failed|failed to fetch|networkerror|ENOTFOUND|ECONNRESET/i.test(raw)) {
    return 'Could not reach Hugging Face Stable Fast 3D. Check your token and network, then try again.';
  }
  return raw || 'Stable Fast 3D generation failed.';
}

export async function verifyHfToken(token: string) {
  const cleaned = cleanToken(token);
  if (!cleaned.startsWith('hf_')) {
    throw new Error(
      'Token must be a Hugging Face user access token starting with hf_.',
    );
  }
  const response = await fetch('https://huggingface.co/api/whoami-v2', {
    headers: { Authorization: `Bearer ${cleaned}` },
  });
  if (!response.ok) {
    throw new Error(
      'Hugging Face rejected this token. Use a token from the Pro account at https://huggingface.co/settings/tokens',
    );
  }
  const data = (await response.json()) as {
    name?: string;
    fullname?: string;
    isPro?: boolean;
    canPay?: boolean;
    plan?: string;
    auth?: { type?: string; accessToken?: { displayName?: string; role?: string } };
  };
  // whoami-v2 exposes isPro for Pro subscribers; canPay is a weaker signal.
  const isPro = Boolean(data.isPro || data.canPay || /pro/i.test(String(data.plan || '')));
  return {
    name: data.name || data.fullname || 'hf-user',
    isPro,
    token: cleaned,
  };
}

async function runJob(jobId: string, blob: Blob, token: string) {
  jobs.set(jobId, { status: 'running', createdAt: Date.now() });
  try {
    const identity = await verifyHfToken(token);
    const client = await Client.connect(DEFAULT_SPACE, {
      token: identity.token as `hf_${string}`,
      hf_token: identity.token as `hf_${string}`,
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

    const downloaded = await fetch(remoteUrl, {
      headers: { Authorization: `Bearer ${identity.token}` },
    });
    const finalResponse = downloaded.ok ? downloaded : await fetch(remoteUrl);
    if (!finalResponse.ok) {
      throw new Error(
        'The generated GLB could not be retrieved from Hugging Face.',
      );
    }
    const bytes = Buffer.from(await finalResponse.arrayBuffer());
    const id = randomUUID();
    await writeFile(path.join(temporaryDir, `${id}.glb`), bytes);
    jobs.set(jobId, {
      status: 'done',
      createdAt: Date.now(),
      modelUrl: `/api/generated/${id}`,
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error || '');
    jobs.set(jobId, {
      status: 'error',
      createdAt: Date.now(),
      error: explain(raw),
      detail: raw,
    });
  }
}

function tokenFromRequest(req: Request) {
  const bodyToken = cleanToken((req.body as { token?: string })?.token);
  const headerToken = cleanToken(req.headers['x-hf-token']);
  return bodyToken || headerToken || cleanToken(process.env.HF_TOKEN);
}

export async function generateSf3d(req: Request, res: Response) {
  try {
    const token = tokenFromRequest(req);
    if (!token) {
      res.status(401).json({
        error: 'Enter a Hugging Face token before generating.',
      });
      return;
    }

    const blob = await imageFromRequest(req);
    const jobId = randomUUID();
    jobs.set(jobId, { status: 'queued', createdAt: Date.now() });
    void runJob(jobId, blob, token);
    res.status(202).json({ jobId, statusUrl: `/api/sf3d/${jobId}` });
  } catch (error) {
    const raw = error instanceof Error ? error.message : '';
    res.status(400).json({ error: explain(raw), detail: raw });
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

export async function checkToken(req: Request, res: Response) {
  try {
    const token =
      cleanToken((req.body as { token?: string })?.token) ||
      cleanToken(req.headers['x-hf-token']) ||
      cleanToken(process.env.HF_TOKEN);
    if (!token) {
      res.status(401).json({ error: 'Missing Hugging Face token.' });
      return;
    }
    const identity = await verifyHfToken(token);
    res.json({
      ok: true,
      name: identity.name,
      isPro: identity.isPro,
      hint: identity.isPro
        ? 'Pro token accepted. ZeroGPU still has a daily quota; add credits if it is exhausted.'
        : 'Token works, but this account does not look like Pro. ZeroGPU free quota is small.',
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : '';
    res.status(401).json({ error: explain(raw), detail: raw });
  }
}
