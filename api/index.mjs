// Vercel function for the Skyward ATC API. vercel.json rewrites /api/<path> to /api?__p=<path>.

import { createApi } from '../server/api-core.mjs';
import { createPostgresStore } from '../server/store-postgres.mjs';

const handleApi = createApi(createPostgresStore(), { version: process.env.APP_VERSION || '1.0.0' });

export default async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const rest = url.searchParams.get('__p');
  const pathname = rest != null ? `/api/${rest}` : url.pathname;
  await handleApi(req, res, pathname);
}
