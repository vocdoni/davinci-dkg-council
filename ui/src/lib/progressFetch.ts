/**
 * A fetch wrapper that reports download progress, for the SDK's pinned
 * artifact fetcher (which stream-verifies sha256 itself).
 */

export interface DownloadProgress {
  url: string;
  loadedBytes: number;
  totalBytes?: number;
}

export function progressFetch(
  onProgress: (p: DownloadProgress) => void,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await baseFetch(input, init);
    if (!res.ok || !res.body) return res;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const lengthHeader = res.headers.get('content-length');
    const totalBytes = lengthHeader ? Number(lengthHeader) : undefined;
    let loadedBytes = 0;
    const reader = res.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        loadedBytes += value.length;
        onProgress({ url, loadedBytes, totalBytes });
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return wrapped as typeof fetch;
}
