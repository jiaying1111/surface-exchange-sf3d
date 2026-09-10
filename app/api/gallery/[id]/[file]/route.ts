import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; file: string }> },
) {
  const { id, file } = await params;
  if (
    !/^[a-f0-9-]{36}$/.test(id) ||
    !['a.glb', 'b.glb', 'surface-a.png', 'surface-b.png'].includes(file)
  ) {
    return new NextResponse('Not found', { status: 404 });
  }

  const object = await env.ASSETS.get(`gallery/${id}/${file}`);
  if (!object) return new NextResponse('Not found', { status: 404 });

  const type = file.endsWith('.glb') ? 'model/gltf-binary' : 'image/png';
  return new NextResponse(object.body, {
    headers: {
      'Content-Type': type,
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
