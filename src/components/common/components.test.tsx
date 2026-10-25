import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog, ScanInput } from '@/components/common';
import { StatusBadge } from '@/components/ui/badge';
import { loginSchema, passwordSchema } from '@/pages/auth/AuthPages';
import { workOrderSchema } from '@/pages/work-orders/WorkOrderFormPage';

describe('ScanInput (USB scanner / manual entry)', () => {
  it('submits the scanned value on Enter like a keyboard-wedge scanner and clears the field', async () => {
    const onScan = vi.fn();
    render(<ScanInput onScan={onScan} />);
    const input = screen.getByLabelText('Serial number');
    await userEvent.type(input, '  PF4J000123{Enter}');
    expect(onScan).toHaveBeenCalledWith('PF4J000123');
    expect(input).toHaveValue('');
  });
  it('ignores empty scans', async () => {
    const onScan = vi.fn();
    render(<ScanInput onScan={onScan} />);
    await userEvent.type(screen.getByLabelText('Serial number'), '   {Enter}');
    expect(onScan).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog', () => {
  it('requires a reason before a sensitive action can be confirmed', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ConfirmDialog open onOpenChange={() => {}} title="Cancel work order" reasonLabel="Reason" onConfirm={onConfirm} confirmLabel="Cancel it" />);
    const button = screen.getByRole('button', { name: 'Cancel it' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Reason/), 'Duplicate request');
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Duplicate request'));
  });
});

describe('StatusBadge', () => {
  it('renders a readable label', () => {
    render(<StatusBadge status="pending_authorisation" kind="wo" />);
    expect(screen.getByText('Pending Authorisation')).toBeInTheDocument();
  });
});

describe('form validation schemas', () => {
  it('validates login input', () => {
    expect(loginSchema.safeParse({ email: 'bad', password: '' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'user@example.org', password: 'x' }).success).toBe(true);
  });
  it('enforces password strength and confirmation', () => {
    expect(passwordSchema.safeParse({ password: 'short', confirm: 'short' }).success).toBe(false);
    expect(passwordSchema.safeParse({ password: 'Longenough123', confirm: 'Different123x' }).success).toBe(false);
    expect(passwordSchema.safeParse({ password: 'Longenough123', confirm: 'Longenough123' }).success).toBe(true);
  });
  it('requires an institution and positive whole quantities on work orders', () => {
    const base = { work_order_type_id: crypto.randomUUID(), recipient_type: 'school', priority: 'normal' };
    const inst = { id: crypto.randomUUID(), name: 'X', emis_number: '1', town: null, status: 'active' };
    expect(workOrderSchema.safeParse({ ...base, lines: [{ category_id: crypto.randomUUID(), requested_qty: 1 }] }).success).toBe(false);
    expect(workOrderSchema.safeParse({ ...base, institution: inst, lines: [{ category_id: crypto.randomUUID(), requested_qty: 0 }] }).success).toBe(false);
    expect(workOrderSchema.safeParse({ ...base, institution: inst, lines: [{ category_id: crypto.randomUUID(), requested_qty: 2.5 }] }).success).toBe(false);
    expect(workOrderSchema.safeParse({ ...base, institution: inst, lines: [{ category_id: crypto.randomUUID(), requested_qty: '3' }] }).success).toBe(true);
  });
});
