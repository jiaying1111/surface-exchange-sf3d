import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/.test(id)) return new NextResponse('Not found', { status: 404 });

  const object = await env.ASSETS.get(`temporary/${id}.glb`);
  if (!object) return new NextResponse('Not found', { status: 404 });

  return new NextResponse(object.body, {
    headers: {
      'Content-Type': 'model/gltf-binary',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
