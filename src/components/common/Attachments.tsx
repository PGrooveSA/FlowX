import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Paperclip, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { fetchAll, signedUrl, uploadAttachment } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form-controls';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/common';
import { useAuth } from '@/hooks/useAuth';

interface Attachment { id: string; file_name: string; storage_path: string; category: string; mime_type: string; size_bytes: number; created_at: string }

const ALLOWED = 'image/jpeg,image/png,image/webp,application/pdf,.csv,.xlsx';

export function AttachmentsPanel({ entityType, entityId, title = 'Attachments' }: { entityType: string; entityId: string; title?: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState('document');
  const [busy, setBusy] = useState(false);
  const key = ['attachments', entityType, entityId];
  const list = useQuery({
    queryKey: key,
    queryFn: () => fetchAll<Attachment>('attachments', '*', (q) => q.eq('entity_type', entityType).eq('entity_id', entityId).order('created_at', { ascending: false })),
  });

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        if (f.size > 10 * 1024 * 1024) { toast.error(`${f.name} is larger than 10 MB`); continue; }
        await uploadAttachment(entityType, entityId, f, category);
      }
      toast.success('Uploaded');
      void qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const open = async (a: Attachment) => {
    try { window.open(await signedUrl(a.storage_path), '_blank', 'noopener'); } catch (e) { toast.error(e instanceof Error ? e.message : 'Cannot open file'); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Paperclip className="h-4 w-4" /> {title}</CardTitle>
        {can('attachments.upload') && (
          <div className="flex items-center gap-2">
            <Select aria-label="Attachment type" className="h-8 w-36" value={category} onChange={(e) => setCategory(e.target.value)}
              options={['document', 'photo', 'before', 'after', 'pod', 'other'].map((c) => ({ value: c, label: c === 'pod' ? 'Proof of delivery' : c[0].toUpperCase() + c.slice(1) }))} />
            <input ref={input} type="file" multiple accept={ALLOWED} className="hidden" onChange={(e) => void onFiles(e.target.files)} />
            <Button size="sm" variant="outline" loading={busy} onClick={() => input.current?.click()}><Upload /> Upload</Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {list.data?.length ? (
          <ul className="divide-y">
            {list.data.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
                <button className="min-w-0 flex-1 truncate text-left text-primary hover:underline" onClick={() => void open(a)}>{a.file_name}</button>
                <span className="text-xs text-muted-foreground">{a.category}</span>
                <span className="hidden text-xs text-muted-foreground sm:inline">{formatDateTime(a.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="No attachments yet" description="Photos, supporting documents and proof of delivery appear here." />}
      </CardContent>
    </Card>
  );
}
