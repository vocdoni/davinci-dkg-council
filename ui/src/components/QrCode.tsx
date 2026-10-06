import { useMemo } from 'react';
import { renderSVG } from 'uqr';

/** Local QR rendering (uqr, no network, no canvas). */
export function QrCode({ text, label }: { text: string; label?: string }) {
  const svg = useMemo(() => renderSVG(text, { ecc: 'M', border: 2 }), [text]);
  return (
    <div
      className="mx-auto w-full max-w-55 [&>svg]:h-auto [&>svg]:w-full"
      role="img"
      aria-label={label ?? 'QR code'}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
