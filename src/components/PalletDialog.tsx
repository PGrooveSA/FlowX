import { useState } from 'react';
import { toast } from 'sonner';
import { Package } from 'lucide-react';
import { rpc } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form-controls';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';

interface Props {
  deviceIds: string[];
  warehouseId?: string;
  defaultReference?: string;
  summary?: React.ReactNode;
  onClose: () => void;
  onCreated?: (pallet: { id: string; pallet_number: string }) => void;
}

/** Puts devices on a new numbered pallet and opens its A4 pallet label. */
export function PalletDialog({ deviceIds, warehouseId, defaultReference, summary, onClose, onCreated }: Props) {
  const [reference, setReference] = useState(defaultReference ?? '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    // open the tab now, while the click still counts as the user's, then point it at the label once the pallet exists
    const tab = window.open('about:blank', '_blank');
    setBusy(true);
    try {
      const res = await rpc<{ id: string; pallet_number: string; devices: number }>('create_pallet', { p: { device_ids: deviceIds, warehouse_id: warehouseId, reference, notes } });
      const url = `/print/pallet?id=${res.id}`;
      if (tab) { tab.opener = null; tab.location.href = url; } else window.open(url, '_blank', 'noopener');
      toast.success(`Pallet ${res.pallet_number} created with ${res.devices} device(s)`);
      onCreated?.(res);
      onClose();
    } catch (e) {
      tab?.close();
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title="Create pallet label" description={summary ?? `${deviceIds.length} device(s) go on a new pallet. Devices already on another pallet move to this one.`} />
        <div className="grid gap-3">
          <Field label="Reference (purchase order, delivery note…)" htmlFor="pl-ref"><Input id="pl-ref" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
          <Field label="Notes" htmlFor="pl-notes"><Input id="pl-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!deviceIds.length} onClick={() => void create()}><Package /> Create and print ({deviceIds.length})</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
