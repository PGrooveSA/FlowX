import { useState } from 'react';
import { CheckCircle2, Download, FileUp, AlertTriangle } from 'lucide-react';
import { parseSpreadsheet, downloadBlob, downloadCsv } from '@/lib/csv';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export interface ValidatedRow { row: number; data: Record<string, string>; errors: string[] }
export interface CommitSummary { created: number; failed: number; messages: string[] }

export function ImportWizard({ requiredColumns, optionalColumns = [], template, templateName, validate, commit, maxRows = 50000, children }: {
  requiredColumns: string[];
  optionalColumns?: string[];
  template: string;
  templateName: string;
  validate: (rows: Record<string, string>[], onProgress: (pct: number) => void) => Promise<ValidatedRow[]>;
  commit: (rows: ValidatedRow[], onProgress: (pct: number) => void) => Promise<CommitSummary>;
  maxRows?: number;
  children?: React.ReactNode;
}) {
  const [step, setStep] = useState<'upload' | 'preview' | 'done'>('upload');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<ValidatedRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [summary, setSummary] = useState<CommitSummary | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);

  const onFile = async (file: File) => {
    setError(null);
    setFileName(file.name);
    try {
      const parsed = await parseSpreadsheet(file);
      if (!parsed.length) throw new Error('The file contains no data rows');
      if (parsed.length > maxRows) throw new Error(`The file has ${parsed.length} rows; the maximum per import is ${maxRows}`);
      const missing = requiredColumns.filter((c) => !(c in parsed[0]));
      if (missing.length) throw new Error(`Missing required column(s): ${missing.join(', ')}. Download the template for the expected structure.`);
      setProgress(0);
      const validated = await validate(parsed, setProgress);
      // detect duplicates inside the file for the first required column (identity column)
      setRows(validated);
      setStep('preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the file');
    } finally {
      setProgress(null);
    }
  };

  const valid = rows.filter((r) => r.errors.length === 0);
  const invalid = rows.length - valid.length;
  const shown = (onlyErrors ? rows.filter((r) => r.errors.length) : rows).slice(0, 500);
  const columns = [...requiredColumns, ...optionalColumns].filter((c) => rows.some((r) => r.data[c]));

  return (
    <div className="space-y-4">
      {step === 'upload' && (
        <Card>
          <CardHeader><CardTitle>1. Upload a CSV or Excel file</CardTitle>
            <Button variant="outline" size="sm" onClick={() => downloadBlob(template, templateName, 'text/csv')}><Download /> Template</Button></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>Required columns: {requiredColumns.map((c) => <code key={c} className="mr-1 rounded bg-muted px-1">{c}</code>)}</p>
            {optionalColumns.length > 0 && <p>Optional: {optionalColumns.map((c) => <code key={c} className="mr-1 rounded bg-muted px-1">{c}</code>)}</p>}
            {children}
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-8 text-center hover:bg-muted/40">
              <FileUp className="h-8 w-8 text-muted-foreground" aria-hidden />
              <span className="font-medium">Choose a file</span>
              <span className="text-xs text-muted-foreground">.csv or .xlsx — nothing is saved until you confirm</span>
              <input type="file" accept=".csv,.xlsx,.xls" className="sr-only" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
            </label>
            {progress !== null && <p role="status">Validating… {progress}%</p>}
            {error && <p role="alert" className="flex items-center gap-2 rounded bg-red-50 px-3 py-2 text-red-800"><AlertTriangle className="h-4 w-4" /> {error}</p>}
          </CardContent>
        </Card>
      )}

      {step === 'preview' && (
        <Card>
          <CardHeader>
            <CardTitle>2. Review {fileName}</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="green">{valid.length} valid</Badge>
              <Badge tone={invalid ? 'red' : 'gray'}>{invalid} with errors</Badge>
              {invalid > 0 && <Button size="sm" variant="outline" onClick={() => downloadCsv(rows.filter((r) => r.errors.length),
                [{ header: 'row', value: (r) => r.row }, ...columns.map((c) => ({ header: c, value: (r: ValidatedRow) => r.data[c] })), { header: 'errors', value: (r) => r.errors.join('; ') }], 'import-errors')}>
                <Download /> Error report</Button>}
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> Errors only</label>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 p-0">
            <div className="max-h-[50vh] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted text-left"><tr><th className="px-2 py-1.5">Row</th>{columns.map((c) => <th key={c} className="px-2 py-1.5">{c}</th>)}<th className="px-2 py-1.5">Validation</th></tr></thead>
                <tbody>{shown.map((r) => (
                  <tr key={r.row} className={r.errors.length ? 'bg-red-50' : ''}>
                    <td className="px-2 py-1">{r.row}</td>{columns.map((c) => <td key={c} className="mono px-2 py-1">{r.data[c]}</td>)}
                    <td className="px-2 py-1">{r.errors.length ? <span className="text-red-700">{r.errors.join('; ')}</span> : <span className="text-emerald-700">OK</span>}</td>
                  </tr>))}</tbody>
              </table>
              {rows.length > 500 && <p className="p-2 text-xs text-muted-foreground">Showing the first 500 rows.</p>}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t p-3">
              {progress !== null && <span className="mr-auto text-sm" role="status">Importing… {progress}%</span>}
              <Button variant="outline" onClick={() => { setStep('upload'); setRows([]); }} disabled={progress !== null}>Choose another file</Button>
              <Button disabled={!valid.length || progress !== null} loading={progress !== null} onClick={async () => {
                setProgress(0);
                try { setSummary(await commit(valid, setProgress)); setStep('done'); }
                catch (e) { setError(e instanceof Error ? e.message : 'Import failed'); }
                finally { setProgress(null); }
              }}>Confirm import of {valid.length} valid row{valid.length === 1 ? '' : 's'}{invalid ? ` (skip ${invalid})` : ''}</Button>
            </div>
            {error && <p role="alert" className="mx-3 mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
          </CardContent>
        </Card>
      )}

      {step === 'done' && summary && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-600" /> 3. Import summary</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><strong>{summary.created}</strong> created, <strong>{summary.failed}</strong> failed, {invalid} skipped for validation errors.</p>
            {summary.messages.length > 0 && <ul className="max-h-48 list-disc overflow-y-auto pl-5 text-red-700">{summary.messages.slice(0, 100).map((m, i) => <li key={i}>{m}</li>)}</ul>}
            <Button variant="outline" onClick={() => { setStep('upload'); setRows([]); setSummary(null); }}>Import another file</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Flags duplicate values of a key column within the uploaded file. */
export function markFileDuplicates(rows: ValidatedRow[], key: (r: ValidatedRow) => string | undefined, label: string) {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    if (seen.has(k)) r.errors.push(`Duplicate ${label} in file (also row ${seen.get(k)})`);
    else seen.set(k, r.row);
  }
  return rows;
}
