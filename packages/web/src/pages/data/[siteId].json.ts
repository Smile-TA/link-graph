import type { APIRoute } from 'astro';
import { getSnapshot } from '../../server/captures';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  if (!params.siteId) return new Response('Missing site identifier', { status: 400 });
  try {
    return Response.json(await getSnapshot(params.siteId), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch {
    return new Response('Unknown imported site', { status: 404 });
  }
};
