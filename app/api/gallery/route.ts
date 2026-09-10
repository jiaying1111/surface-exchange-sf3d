import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';

type Entry = {
  id: string;
  createdAt: string;
  a: { name: string };
  b: { name: string };
  surfaces: true;
};

export async function GET() {
  const listed = await env.ASSETS.list({ prefix: 'gallery/' });
  const entries: Entry[] = [];
  for (const object of listed.objects.filter((item) =>
    item.key.endsWith('/record.json'),
  )) {
    const saved = await env.ASSETS.get(object.key);
    if (saved) entries.push(await saved.json<Entry>());
  }
  return NextResponse.json(
    entries.sort((x, y) => y.createdAt.localeCompare(x.createdAt)),
  );
}

export async function POST(request: Request) {
  const form = await request.formData();
  const a = form.get('a');
  const b = form.get('b');
  const surfaceA = form.get('surfaceA');
  const surfaceB = form.get('surfaceB');

  if (
    !(a instanceof File) ||
    !(b instanceof File) ||
    !(surfaceA instanceof File) ||
    !(surfaceB instanceof File)
  ) {
    return NextResponse.json(
      { error: 'Two GLBs and two UV surfaces are required.' },
      { status: 400 },
    );
  }

  if (
    !a.name.toLowerCase().endsWith('.glb') ||
    !b.name.toLowerCase().endsWith('.glb')
  ) {
    return NextResponse.json(
      { error: 'Only GLB files can be archived.' },
      { status: 400 },
    );
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const record: Entry = {
    id,
    createdAt,
    a: { name: a.name },
    b: { name: b.name },
    surfaces: true,
  };
  const base = `gallery/${id}`;

  await Promise.all([
    env.ASSETS.put(`${base}/a.glb`, a.stream(), {
      httpMetadata: { contentType: 'model/gltf-binary' },
    }),
    env.ASSETS.put(`${base}/b.glb`, b.stream(), {
      httpMetadata: { contentType: 'model/gltf-binary' },
    }),
    env.ASSETS.put(`${base}/surface-a.png`, surfaceA.stream(), {
      httpMetadata: { contentType: 'image/png' },
    }),
    env.ASSETS.put(`${base}/surface-b.png`, surfaceB.stream(), {
      httpMetadata: { contentType: 'image/png' },
    }),
    env.ASSETS.put(`${base}/record.json`, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' },
    }),
  ]);

  return NextResponse.json(record, { status: 201 });
}
