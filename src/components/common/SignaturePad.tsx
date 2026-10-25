import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';

/** Pointer-based signature capture that emits a PNG data URL. */
export function SignaturePad({ onChange, label = 'Recipient signature' }: { onChange: (dataUrl: string | null) => void; label?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    const c = canvas.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio;
    c.height = c.offsetHeight * ratio;
    const ctx = c.getContext('2d')!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0f172a';
  }, []);

  const pos = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <canvas ref={canvas} aria-label={label} role="img" className="h-36 w-full touch-none rounded-md border bg-white"
        onPointerDown={(e) => { drawing.current = true; const p = pos(e); const ctx = canvas.current!.getContext('2d')!; ctx.beginPath(); ctx.moveTo(p.x, p.y); canvas.current!.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (!drawing.current) return; const p = pos(e); const ctx = canvas.current!.getContext('2d')!; ctx.lineTo(p.x, p.y); ctx.stroke(); dirty.current = true; }}
        onPointerUp={() => { drawing.current = false; if (dirty.current) onChange(canvas.current!.toDataURL('image/png')); }} />
      <Button type="button" size="sm" variant="ghost" onClick={() => {
        const c = canvas.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); dirty.current = false; onChange(null);
      }}>Clear signature</Button>
    </div>
  );
}
