import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, handle_file } from '@gradio/client';
import type { Request, Response } from 'express';
import { temporaryDir } from './storage';

const DEFAULT_SPACE = process.env.SF3D_SPACE_ID || 'Upsampler/stable-fast-3d';
const DEFAULT_ENDPOINT = process.env.SF3D_API_NAME || '/image_to_glb';

type GradioFile = { url?: string; path?: string };

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

    res.json({ modelUrl: `/api/generated/${id}` });
  } catch (error) {
    const raw = error instanceof Error ? error.message : '';
    const message = raw.includes('ZeroGPU runs limit')
      ? 'Free GPU quota is exhausted. Use a Hugging Face Pro token or try again after the quota resets.'
      : raw === 'An error occurred'
        ? 'The free SF3D GPU is temporarily unavailable. Please wait a minute and try again.'
        : /load failed|failed to fetch|networkerror|ENOTFOUND|ECONNRESET/i.test(
              raw,
            )
          ? 'Could not reach Hugging Face Stable Fast 3D. Check your token and network, then try again.'
          : raw || 'Stable Fast 3D generation failed.';
    res.status(502).json({ error: message });
  }
}
