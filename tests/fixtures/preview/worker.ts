import { handlePreviewRequest, type PreviewEnvironment } from '../../../packages/api/src/preview/environment';
export { PreviewSessionDurableObject } from '../../../packages/api/src/preview/session';
// Local fixture only; production creation uses the authenticated v3 API.
export default {
  async fetch(request: Request, env: PreviewEnvironment) {
    if (new URL(request.url).pathname === '/create') {
      const namespace = env.BEUTL_PREVIEW_SESSIONS!;
      const id = namespace.idFromName('test-account');
      return namespace.get(id).fetch(new Request('https://preview.internal/init', {
        method: 'POST', body: JSON.stringify({ objectId: id.toString(), origin: new URL(request.url).origin }),
      }));
    }
    return await handlePreviewRequest(request, env) || new Response(null, { status: 404 });
  },
};
