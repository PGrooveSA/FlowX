import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { SignaturePad } from '@/components/common/SignaturePad';
import { LoadingState } from '@/components/common';

interface Shipment { dispatch_number: string; institution: string; emis_number: string; dispatch_date: string; courier: string | null; tracking_number: string | null;
  organisation: string; pod_policy: string | null; devices: { dispatch_device_id: string; serial_number: string; model: string }[] | null }

/** Public, token-restricted page: shows exactly one shipment and accepts only its confirmation. */
export function RecipientConfirmPage() {
  const { token } = useParams();
  const q = useQuery({ queryKey: ['public-delivery', token], retry: false, queryFn: async () => {
    const { data, error } = await supabase.rpc('get_delivery_by_token', { p_token: token });
    if (error) throw new Error(friendlyMessage(error));
    return data as Shipment;
  } });
  const [results, setResults] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [comments, setComments] = useState('');
  const [signature, setSignature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shell = (children: React.ReactNode) => <div className="min-h-screen bg-slate-100 px-4 py-6"><div className="mx-auto max-w-lg rounded-xl border bg-white p-5 shadow">{children}</div></div>;
  if (q.isLoading) return shell(<LoadingState />);
  if (q.error) return shell(<p role="alert" className="text-sm text-red-800">{(q.error as Error).message}</p>);
  if (done) return shell(<div className="space-y-2 text-center"><CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" /><h1 className="text-lg font-semibold">Thank you</h1><p className="text-sm">Receipt recorded as {done}. You may close this page.</p></div>);
  const s = q.data!;
  const devices = s.devices ?? [];
  return shell(
    <div className="space-y-4">
      <div><p className="text-xs text-muted-foreground">{s.organisation}</p><h1 className="text-lg font-semibold">Confirm delivery {s.dispatch_number}</h1>
        <p className="text-sm text-muted-foreground">{s.institution} (EMIS {s.emis_number}) · dispatched {s.dispatch_date}{s.courier ? ` via ${s.courier}` : ''}</p></div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Check each device against the serial number on the device itself:</p>
        {devices.map((d) => (
          <div key={d.dispatch_device_id} className="flex items-center justify-between gap-2 rounded border px-3 py-2 text-sm">
            <span><span className="mono font-semibold">{d.serial_number}</span><br /><span className="text-xs text-muted-foreground">{d.model}</span></span>
            <Select aria-label={`Result for ${d.serial_number}`} className="h-9 w-36" value={results[d.dispatch_device_id] ?? 'received'} onChange={(e) => setResults({ ...results, [d.dispatch_device_id]: e.target.value })}
              options={[{ value: 'received', label: 'Received' }, { value: 'damaged', label: 'Damaged' }, { value: 'missing', label: 'Not received' }, { value: 'rejected', label: 'Rejected' }]} />
          </div>))}
      </div>
      <Field label="Your full name" htmlFor="pn" required><Input id="pn" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
      <Field label="Your role at the institution" htmlFor="pr"><Input id="pr" value={role} onChange={(e) => setRole(e.target.value)} /></Field>
      <Field label="Comments" htmlFor="pc"><Textarea id="pc" value={comments} onChange={(e) => setComments(e.target.value)} /></Field>
      <SignaturePad onChange={setSignature} />
      {s.pod_policy && <p className="text-xs text-muted-foreground">{s.pod_policy}</p>}
      {error && <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      <Button className="w-full" loading={busy} disabled={name.trim().length < 2} onClick={async () => {
        setBusy(true); setError(null);
        const { data, error: err } = await supabase.rpc('confirm_delivery_by_token', { p_token: token, p: {
          received_by_name: name, received_by_role: role, comments, signature_data: signature,
          devices: devices.map((d) => ({ dispatch_device_id: d.dispatch_device_id, result: results[d.dispatch_device_id] ?? 'received' })) } });
        setBusy(false);
        if (err) setError(friendlyMessage(err)); else setDone((data as { delivery_number: string }).delivery_number);
      }}>Confirm receipt</Button>
    </div>,
  );
}
