import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/form-controls';
import { useDebounce } from '@/components/common';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

export interface InstitutionLite { id: string; name: string; emis_number: string; town: string | null; status: string }

/** Searchable institution selector (server-side search by name or EMIS number). */
export function InstitutionPicker({ value, onChange, id, invalid }: {
  value: InstitutionLite | null; onChange: (i: InstitutionLite | null) => void; id?: string; invalid?: boolean;
}) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const q = useDebounce(term.trim(), 250);
  const results = useQuery({
    queryKey: ['institution-search', q],
    enabled: open,
    queryFn: async () => {
      let req = supabase.from('institutions').select('id, name, emis_number, town, status').eq('status', 'active').order('name').limit(12);
      if (q) req = req.or(`name.ilike.%${q.replace(/[%_,()]/g, '')}%,emis_number.ilike.%${q.replace(/[%_,()]/g, '')}%`);
      const { data } = await req;
      return (data ?? []) as InstitutionLite[];
    },
  });

  if (value && !open) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
        <span><span className="font-medium">{value.name}</span> <span className="text-muted-foreground">· EMIS {value.emis_number}{value.town ? ` · ${value.town}` : ''}</span></span>
        <button type="button" className="text-xs text-primary hover:underline" onClick={() => { setOpen(true); setTerm(''); }}>Change</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Input id={id} role="combobox" aria-expanded={open} aria-autocomplete="list" aria-invalid={invalid}
        placeholder="Search by school name or EMIS number" value={term}
        onChange={(e) => { setTerm(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && (
        <ul role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-card shadow-lg">
          {results.data?.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No active institutions match</li>}
          {results.data?.map((i) => (
            <li key={i.id} role="option" aria-selected={value?.id === i.id}>
              <button type="button" className={cn('block w-full px-3 py-2 text-left text-sm hover:bg-muted')}
                onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(i); setOpen(false); }}>
                <span className="font-medium">{i.name}</span>
                <span className="block text-xs text-muted-foreground">EMIS {i.emis_number}{i.town ? ` · ${i.town}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
