// Shared by the web app and classic workers. No requests run during setup.
// url null = service off: images load straight from their source, link previews are skipped and the
// HTML code-block preview stays in its fallback state.
// To turn a service on, set url to the deployed services/proxy Worker (see services/proxy/README.md)
// or the deployed services/html-preview container (see services/html-preview/README.md).
// typstWasm is not a service and does not follow that rule: null means the Typst engine loads from the
// file next to the app, which is the normal case. Set it only where the host refuses a 27 MiB asset,
// such as Cloudflare Pages; see services/typst-wasm/README.md.
(() => {
  const config = Object.freeze({
    imageProxy: Object.freeze({url: 'https://proxy.bstrong68.com/api/worker/image-proxy'}),
    linkPreview: Object.freeze({url: 'https://proxy.bstrong68.com/api/worker/link-preview'}),
    htmlPreview: Object.freeze({url: 'https://bstrong68-html.pages.dev/container'}),
    typstWasm: Object.freeze({url: 'https://tep.bstrong68.com/ead9717ca076a6ca.wasm'}),
    previewTimeoutMs: 15000,
  });

  // Bundle callers also pass a serverBase; it is ignored on purpose. A proxy that serves outside
  // content on the app's own origin (<origin>/api/worker/...) would be an XSS risk.
  // A bad URL only turns the service off. The bundle calls this while evaluating a module, so throwing
  // here would blank the whole app over one typo in the config above.
  // A hostname ending in '.' is rejected: "app.example.com." reaches the app's own server but its origin
  // does not match, so it would slip past the same-origin check.
  function endpoint(kind) {
    try {
      const service = config[kind];
      if (!service || typeof service !== 'object') throw new Error('Unknown service');
      if (!service.url) return null;
      const url = new URL(service.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash ||
          url.hostname.endsWith('.') || url.origin === globalThis.location.origin) {
        throw new Error('Invalid service URL');
      }
      return url.href;
    } catch (error) {
      console.error(`[bstr] dịch vụ ${kind} bị từ chối, dịch vụ này đang tắt`, error);
      return null;
    }
  }

  // The HTML preview iframe carries allow-scripts and allow-same-origin, so the container must never
  // share the app's origin: the previewed HTML could drop the sandbox and read the app's data.
  // A bad URL only disables the preview (the component falls back); throwing here would break startup.
  function htmlPreviewFrame() {
    try {
      const src = endpoint('htmlPreview');
      if (!src) return null;
      const url = new URL(src);
      // Plain http only for local testing; anywhere else the container must be served over https.
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
        throw new Error('Invalid service URL');
      }
      return {src, origin: url.origin};
    } catch (error) {
      console.error('[bstr] khung xem trước HTML bị từ chối', error);
      return null;
    }
  }

  function isImageProxyUrl(value, proxy = endpoint('imageProxy')) {
    if (!proxy) return false;
    try {
      const url = new URL(value, globalThis.location.origin);
      const target = new URL(proxy, globalThis.location.origin);
      return url.searchParams.has('url') && url.origin === target.origin && url.pathname === target.pathname;
    } catch { return false; }
  }

  function imageUrl(value, proxy = endpoint('imageProxy')) {
    if (!proxy || value.startsWith('data:') || value.startsWith('blob:') || isImageProxyUrl(value, proxy)) return value;
    const url = new URL(proxy, globalThis.location.origin);
    url.searchParams.set('url', value);
    return url.href;
  }

  // The bundle asks api.fxtwitter.com directly for tweet cards. That host is a third-party
  // middleman, so it is never called from the browser: with the link-preview service off there is no tweet
  // card, and with it on the request goes to the tweet route of the same Worker.
  function tweetUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return url; }
    if (parsed.hostname !== 'api.fxtwitter.com') return url;
    const id = /^\/status\/(\d{1,25})$/.exec(parsed.pathname)?.[1];
    const service = endpoint('linkPreview');
    if (!id || !service) return null;
    const target = new URL('tweet', service);
    target.search = '';
    target.searchParams.set('id', id);
    return target.href;
  }

  // Bound preview fetch and body parsing together; release timers/listeners.
  // A null url means the preview service is off: resolve null without any request.
  async function previewJson(url, options = {}) {
    url = url && tweetUrl(url);
    if (!url) return null;
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason || new DOMException('Aborted', 'AbortError'));
    controller.signal.addEventListener('abort', onAbort, {once:true});
    options.signal?.addEventListener('abort', abort, {once:true});
    const timer = setTimeout(() => controller.abort(new DOMException('Preview timed out', 'TimeoutError')), config.previewTimeoutMs);
    try {
      if (options.signal?.aborted) abort();
      const work = (async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        const response = await fetch(url, {...options, signal:controller.signal});
        if (!response.ok) throw new Error('Preview service returned HTTP ' + response.status);
        return response.json();
      })();
      return await Promise.race([work, aborted]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  // Keep the existing proxy-then-direct fallback, using a worker-safe origin.
  async function fetchImage(value, options, proxy) {
    try {
      if (options?.signal?.aborted) return null;
      const target = new URL(value, globalThis.location.origin);
      const local = target.origin === globalThis.location.origin;
      if (!proxy || target.protocol === 'blob:' || target.protocol === 'data:' || local) {
        const response = await fetch(value, options);
        return response.ok ? response : null;
      }
      try {
        const response = await fetch(imageUrl(value, proxy), options);
        if (response.ok) return response;
      } catch { /* Preserve direct fallback for ordinary network errors. */ }
      if (options?.signal?.aborted) return null;
      const response = await fetch(value, options);
      return response.ok ? response : null;
    } catch { return null; }
  }

  globalThis.bstrServices = Object.freeze({config, endpoint, htmlPreviewFrame, isImageProxyUrl, imageUrl, previewJson, fetchImage});
})();
