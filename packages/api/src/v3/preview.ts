import { Hono } from 'hono';
import { getUserId } from '../api/auth';
import type { PreviewEnvironment } from '../preview/environment';

export default new Hono<{ Bindings: PreviewEnvironment }>()
  .post('/sessions', async c => {
    c.header('Cache-Control', 'no-store');
    const userId = await getUserId(c);
    if (!userId) return c.json({ message: 'Authentication is required' }, 401);
    const namespace = c.env?.BEUTL_PREVIEW_SESSIONS;
    if (!namespace) return c.json({ message: 'Preview relay is not configured' }, 503);
    const id = namespace.idFromName(userId);
    // The initialization route is only reachable through this authenticated endpoint.
    return namespace.get(id).fetch(new Request('https://preview.internal/init', {
      method: 'POST',
      body: JSON.stringify({ objectId: id.toString(), origin: new URL(c.env.PUBLIC_ORIGIN || c.req.url).origin }),
    }));
  });
