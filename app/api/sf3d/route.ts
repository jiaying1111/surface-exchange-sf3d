import { Client, handle_file } from '@gradio/client';
import { env } from 'cloudflare:workers';
import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_SPACE = 'Upsampler/stable-fast-3d';
const DEFAULT_ENDPOINT = '/image_to_glb';

type GradioFile = { url?: string; path?: string };

function dataUrlToBlob(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!match) throw new Error('Please upload a PNG, JPEG, or WebP image.');
  const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: match[1] });
}

export async function POST(request: NextRequest) {
  try {
    const { image } = (await request.json()) as { image?: string };
    if (!image) return NextResponse.json({ error: 'Missing image.' }, { status: 400 });

    const token = request.headers.get('x-hf-token') || process.env.HF_TOKEN;
    if (!token) {
      return NextResponse.json(
        { error: 'Enter a Hugging Face token before generating.' },
        { status: 401 },
      );
    }

    const client = await Client.connect(process.env.SF3D_SPACE_ID || DEFAULT_SPACE, {
      token,
    });
    const result = await client.predict(process.env.SF3D_API_NAME || DEFAULT_ENDPOINT, {
      input_image: handle_file(dataUrlToBlob(image)),
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
    if (!downloaded.ok || !downloaded.body) {
      throw new Error('The generated GLB could not be retrieved from Hugging Face.');
    }

    const id = crypto.randomUUID();
    await env.ASSETS.put(`temporary/${id}.glb`, downloaded.body, {
      httpMetadata: { contentType: 'model/gltf-binary' },
    });

    return NextResponse.json({ modelUrl: `/api/generated/${id}` });
  } catch (error) {
    const raw = error instanceof Error ? error.message : '';
    const message = raw.includes('ZeroGPU runs limit')
      ? 'Free GPU quota is exhausted. Use a Hugging Face Pro token or try again after the quota resets.'
      : raw === 'An error occurred'
        ? 'The free SF3D GPU is temporarily unavailable. Please wait a minute and try again.'
        : /load failed|failed to fetch|networkerror/i.test(raw)
          ? 'Could not reach Hugging Face Stable Fast 3D from the server. Check the token and try again from http://localhost:3000.'
          : raw || 'Stable Fast 3D generation failed.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
