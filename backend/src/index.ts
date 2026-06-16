export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  R2_PUBLIC_URL: string;
}

const ALLOWED_ORIGIN = 'https://pull.acidblob.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Token',
  'Vary': 'Origin',
};

const RATE_LIMIT_PER_DAY = 3;
const MAX_IMAGE_SIZE = 2 * 1024 * 1024;

interface PhotoRow {
  id: number;
  uid: string;
  lat: number;
  lng: number;
  image_key: string;
  status: string;
  name: string;
  uploader_role: string;
  taken_at: string | null;
  created_at: string;
  reject_reason: string | null;
}

interface TokenRow {
  id: string;
  uid: string;
  token: string | null;
  role: string;
  name: string;
  status: string;
  created_at: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

async function getRole(request: Request, env: Env): Promise<'admin' | 'power' | 'user'> {
  const token = request.headers.get('X-Token') ?? '';
  if (!token) return 'user';
  const row = await env.DB.prepare(
    `SELECT role FROM tokens WHERE token = ? AND status = 'active'`
  ).bind(token).first<{ role: string }>();
  return (row?.role as 'admin' | 'power') ?? 'user';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') ?? '';
    const isAllowed = origin === ALLOWED_ORIGIN
      || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const res = await dispatch(request, env);
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', isAllowed ? origin : ALLOWED_ORIGIN);
    headers.set('Vary', 'Origin');
    return new Response(res.body, { status: res.status, headers });
  },
};

async function dispatch(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path === '/me' && request.method === 'GET') {
      return handleMe(request, env);
    }

    if (path === '/photos') {
      if (request.method === 'POST') return handleUpload(request, env);
      if (request.method === 'GET')  return handleList(url, env, request);
    }

    if (path === '/photos/pending' && request.method === 'GET') {
      return handlePending(request, env);
    }

    const moderateMatch = path.match(/^\/photos\/(\d+)\/(approve|reject)$/);
    if (moderateMatch && request.method === 'POST') {
      return handleModerate(request, env, parseInt(moderateMatch[1]), moderateMatch[2] as 'approve' | 'reject');
    }

    if (path === '/admin/photos' && request.method === 'GET') {
      return handleAdminPhotos(request, env);
    }

    const moveMatch = path.match(/^\/photos\/(\d+)\/move$/);
    if (moveMatch && request.method === 'POST') {
      return handleMove(request, env, parseInt(moveMatch[1]));
    }

    const photoMatch = path.match(/^\/photos\/(\d+)$/);
    if (photoMatch && request.method === 'DELETE') {
      return handleDelete(request, env, parseInt(photoMatch[1]));
    }

    const promoteMatch = path.match(/^\/users\/([^/]+)\/promote$/);
    if (promoteMatch && request.method === 'POST') {
      return handlePromote(request, env, promoteMatch[1]);
    }

    if (path === '/tokens' && request.method === 'GET') {
      return handleTokenList(request, env);
    }

    const tokenMatch = path.match(/^\/tokens\/([0-9a-f-]{36})$/);
    if (tokenMatch && request.method === 'DELETE') {
      return handleTokenDelete(request, env, tokenMatch[1]);
    }

    return json({ error: 'Not Found' }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: 'Internal Server Error' }, 500);
  }
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get('X-Token') ?? '';
  const url   = new URL(request.url);
  const uid   = url.searchParams.get('uid') ?? '';

  if (!token) return json({ role: 'user' });

  // 이미 활성화된 토큰인지 확인
  const activeRow = await env.DB.prepare(
    `SELECT role FROM tokens WHERE token = ? AND status = 'active'`
  ).bind(token).first<{ role: string }>();

  if (activeRow) return json({ role: activeRow.role });

  // pending 상태 uid가 있으면 토큰 활성화
  if (uid) {
    const pendingRow = await env.DB.prepare(
      `SELECT id, role FROM tokens WHERE uid = ? AND status = 'pending'`
    ).bind(uid).first<{ id: string; role: string }>();

    if (pendingRow) {
      await env.DB.prepare(
        `UPDATE tokens SET token = ?, status = 'active' WHERE id = ?`
      ).bind(token, pendingRow.id).run();
      return json({ role: pendingRow.role, activated: true });
    }
  }

  return json({ role: 'user' });
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const role = await getRole(request, env);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: 'Invalid form data' }, 400);
  }

  const uid    = formData.get('uid')   as string | null;
  const latStr = formData.get('lat')   as string | null;
  const lngStr = formData.get('lng')   as string | null;
  const image  = formData.get('image') as File   | null;
  const rawName = (formData.get('name') as string | null) ?? '';
  const name = rawName.trim().slice(0, 20);
  const rawTakenAt = (formData.get('taken_at') as string | null) ?? '';
  const takenAt = rawTakenAt.length >= 10 ? rawTakenAt.slice(0, 19) : null;

  if (!uid || uid.length < 1 || uid.length > 64) return json({ error: 'Invalid uid' }, 400);
  if (!latStr || !lngStr) return json({ error: 'Missing coordinates' }, 400);

  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);

  if (isNaN(lat) || lat < -90  || lat > 90)  return json({ error: 'Invalid lat' }, 400);
  if (isNaN(lng) || lng < -180 || lng > 180) return json({ error: 'Invalid lng' }, 400);
  if (!image || image.size === 0)            return json({ error: 'Missing image' }, 400);
  if (image.size > MAX_IMAGE_SIZE)           return json({ error: 'Image too large (max 2MB)' }, 400);

  if (role === 'user') {
    const rateRow = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM photos WHERE uid = ? AND created_at >= datetime('now', '-1 day')`
    ).bind(uid).first<{ count: number }>();

    if ((rateRow?.count ?? 0) >= RATE_LIMIT_PER_DAY) {
      return json({ error: '하루 3개까지만 업로드할 수 있습니다.' }, 429);
    }
  }

  const imageKey = `photos/${crypto.randomUUID()}.jpg`;
  await env.BUCKET.put(imageKey, image.stream(), {
    httpMetadata: { contentType: 'image/jpeg' },
  });

  const status = role === 'user' ? 'pending' : 'approved';

  const result = await env.DB.prepare(
    `INSERT INTO photos (uid, lat, lng, image_key, status, name, uploader_role, taken_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(uid, lat, lng, imageKey, status, name, role, takenAt).run();

  return json({ id: result.meta.last_row_id, status }, 201);
}

async function handleList(url: URL, env: Env, request: Request): Promise<Response> {
  const minLat = parseFloat(url.searchParams.get('minLat') ?? '');
  const maxLat = parseFloat(url.searchParams.get('maxLat') ?? '');
  const minLng = parseFloat(url.searchParams.get('minLng') ?? '');
  const maxLng = parseFloat(url.searchParams.get('maxLng') ?? '');

  if ([minLat, maxLat, minLng, maxLng].some(v => isNaN(v))) {
    return json({ error: 'Invalid bounds' }, 400);
  }

  const role = await getRole(request, env);
  const uid = url.searchParams.get('uid') ?? '';
  const includePending = role !== 'user' && url.searchParams.get('includePending') === '1';

  const cols = `id, uid, lat, lng, image_key, status, name, uploader_role, taken_at, created_at`;
  const boundsCondition = `lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`;

  let query: string;
  let bindArgs: (string | number)[];

  if (role !== 'user') {
    const statusCondition = includePending ? `status IN ('approved', 'pending')` : `status = 'approved'`;
    query = `SELECT ${cols} FROM photos WHERE ${statusCondition} AND ${boundsCondition} ORDER BY created_at DESC LIMIT 500`;
    bindArgs = [minLat, maxLat, minLng, maxLng];
  } else if (uid) {
    query = `
      SELECT ${cols} FROM photos WHERE status = 'approved' AND ${boundsCondition}
      UNION
      SELECT ${cols} FROM photos WHERE status = 'pending' AND uid = ? AND ${boundsCondition}
      ORDER BY created_at DESC LIMIT 500`;
    bindArgs = [minLat, maxLat, minLng, maxLng, uid, minLat, maxLat, minLng, maxLng];
  } else {
    query = `SELECT ${cols} FROM photos WHERE status = 'approved' AND ${boundsCondition} ORDER BY created_at DESC LIMIT 500`;
    bindArgs = [minLat, maxLat, minLng, maxLng];
  }

  const { results } = await env.DB.prepare(query).bind(...bindArgs).all<PhotoRow>();

  return json(results.map(r => ({
    id: r.id,
    uid_short: r.uid.slice(0, 4),
    lat: r.lat,
    lng: r.lng,
    imageUrl: `${env.R2_PUBLIC_URL}/${r.image_key}`,
    status: r.status,
    name: r.name,
    uploader_role: r.uploader_role,
    taken_at: r.taken_at,
    created_at: r.created_at,
  })));
}

async function handlePending(request: Request, env: Env): Promise<Response> {
  const role = await getRole(request, env);
  if (role === 'user') return json({ error: 'Forbidden' }, 403);

  const { results } = await env.DB.prepare(
    `SELECT id, uid, lat, lng, image_key, created_at FROM photos
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT 100`
  ).all<PhotoRow>();

  return json(results.map(r => ({
    id: r.id,
    uid: r.uid,
    lat: r.lat,
    lng: r.lng,
    imageUrl: `${env.R2_PUBLIC_URL}/${r.image_key}`,
    created_at: r.created_at,
  })));
}

async function handleModerate(
  request: Request,
  env: Env,
  id: number,
  action: 'approve' | 'reject'
): Promise<Response> {
  const role = await getRole(request, env);
  if (role === 'user') return json({ error: 'Forbidden' }, 403);

  let reason = '';
  if (action === 'reject') {
    try {
      const body = await request.json() as { reason?: string };
      reason = ((body.reason ?? '') + '').trim().slice(0, 200);
    } catch { /* optional body */ }
  }

  const status = action === 'approve' ? 'approved' : 'rejected';
  const result = action === 'reject'
    ? await env.DB.prepare(
        `UPDATE photos SET status = ?, reject_reason = ? WHERE id = ? AND status = 'pending'`
      ).bind(status, reason, id).run()
    : await env.DB.prepare(
        `UPDATE photos SET status = ? WHERE id = ? AND status = 'pending'`
      ).bind(status, id).run();

  if (result.meta.changes === 0) return json({ error: 'Not found or already processed' }, 404);
  return json({ success: true, status });
}

async function handleAdminPhotos(request: Request, env: Env): Promise<Response> {
  const role = await getRole(request, env);
  if (role === 'user') return json({ error: 'Forbidden' }, 403);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '30'), 50);
  const beforeIdRaw = url.searchParams.get('before_id');
  const beforeId = beforeIdRaw !== null ? parseInt(beforeIdRaw) : null;
  if (beforeId !== null && isNaN(beforeId)) return json({ error: 'Invalid before_id' }, 400);

  const { results } = beforeId !== null
    ? await env.DB.prepare(
        `SELECT id, uid, lat, lng, image_key, status, name, uploader_role, taken_at, created_at, reject_reason
         FROM photos WHERE id < ? ORDER BY id DESC LIMIT ?`
      ).bind(beforeId, limit + 1).all<PhotoRow>()
    : await env.DB.prepare(
        `SELECT id, uid, lat, lng, image_key, status, name, uploader_role, taken_at, created_at, reject_reason
         FROM photos ORDER BY id DESC LIMIT ?`
      ).bind(limit + 1).all<PhotoRow>();

  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, limit) : results;

  return json({
    photos: items.map(r => ({
      id: r.id,
      uid: r.uid,
      lat: r.lat,
      lng: r.lng,
      imageUrl: `${env.R2_PUBLIC_URL}/${r.image_key}`,
      status: r.status,
      name: r.name,
      uploader_role: r.uploader_role,
      taken_at: r.taken_at,
      created_at: r.created_at,
      reject_reason: r.reject_reason,
    })),
    hasMore,
  });
}

async function handleDelete(request: Request, env: Env, id: number): Promise<Response> {
  const role = await getRole(request, env);
  const url  = new URL(request.url);
  const uid  = url.searchParams.get('uid') ?? '';

  let photo: PhotoRow | null;
  if (role === 'admin' || role === 'power') {
    photo = await env.DB.prepare(`SELECT * FROM photos WHERE id = ?`).bind(id).first<PhotoRow>();
  } else {
    if (!uid) return json({ error: 'Missing uid' }, 400);
    photo = await env.DB.prepare(`SELECT * FROM photos WHERE id = ? AND uid = ?`).bind(id, uid).first<PhotoRow>();
  }

  if (!photo) return json({ error: 'Not found or not yours' }, 404);

  await env.BUCKET.delete(photo.image_key);
  await env.DB.prepare(`DELETE FROM photos WHERE id = ?`).bind(id).run();

  return json({ success: true });
}

async function handleMove(request: Request, env: Env, id: number): Promise<Response> {
  const role = await getRole(request, env);
  if (role === 'user') return json({ error: 'Forbidden' }, 403);

  let body: { lat?: unknown; lng?: unknown };
  try { body = await request.json() as { lat?: unknown; lng?: unknown }; } catch { return json({ error: 'Invalid JSON' }, 400); }

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (isNaN(lat) || lat < -90  || lat > 90)  return json({ error: 'Invalid lat' }, 400);
  if (isNaN(lng) || lng < -180 || lng > 180) return json({ error: 'Invalid lng' }, 400);

  const result = await env.DB.prepare(
    `UPDATE photos SET lat = ?, lng = ? WHERE id = ?`
  ).bind(lat, lng, id).run();

  if (result.meta.changes === 0) return json({ error: 'Not found' }, 404);
  return json({ success: true });
}

async function handlePromote(request: Request, env: Env, uid: string): Promise<Response> {
  const role = await getRole(request, env);
  if (role !== 'admin') return json({ error: 'Forbidden' }, 403);

  if (!uid || uid.length > 64) return json({ error: 'Invalid uid' }, 400);

  const existing = await env.DB.prepare(`SELECT id FROM tokens WHERE uid = ?`)
    .bind(uid).first();
  if (existing) return json({ error: '이미 권한이 있는 사용자입니다.' }, 409);

  await env.DB.prepare(
    `INSERT INTO tokens (id, uid, token, role, name, status) VALUES (?, ?, NULL, 'power', '', 'pending')`
  ).bind(crypto.randomUUID(), uid).run();

  return json({ success: true });
}

async function handleTokenList(request: Request, env: Env): Promise<Response> {
  const role = await getRole(request, env);
  if (role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const { results } = await env.DB.prepare(
    `SELECT id, uid, role, name, status, created_at FROM tokens ORDER BY created_at ASC`
  ).all<TokenRow>();

  return json(results);
}

async function handleTokenDelete(request: Request, env: Env, id: string): Promise<Response> {
  const role = await getRole(request, env);
  if (role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const myToken = request.headers.get('X-Token') ?? '';
  const target = await env.DB.prepare(
    `SELECT token FROM tokens WHERE id = ?`
  ).bind(id).first<{ token: string }>();

  if (!target) return json({ error: 'Not found' }, 404);
  if (target.token === myToken) return json({ error: '자신의 토큰은 삭제할 수 없습니다.' }, 400);

  await env.DB.prepare(`DELETE FROM tokens WHERE id = ?`).bind(id).run();
  return json({ success: true });
}
