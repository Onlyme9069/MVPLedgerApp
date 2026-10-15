import React, { useCallback, useEffect, useState } from 'react';
import { FileSpreadsheet, FilePlus2, RefreshCw, CheckCircle2, AlertCircle, X, ShieldCheck, Eye, LockKeyhole } from 'lucide-react';
import { motion } from 'motion/react';
import { User as UserType } from '../types';
import { googleSheetsService, SheetReadResult } from '../services/googleSheetsService';

interface GoogleSheetsSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserType;
}

export default function GoogleSheetsSyncModal({ isOpen, onClose, currentUser }: GoogleSheetsSyncModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [statusType, setStatusType] = useState<'success' | 'error' | ''>('');
  const [sheetData, setSheetData] = useState<SheetReadResult | null>(null);
  const isAdmin = currentUser.role === 'Admin' || currentUser.role === 'Super Admin';

  const loadSheet = useCallback(async () => {
    setIsLoading(true);
    setStatusMessage('');
    setStatusType('');
    try {
      const result = await googleSheetsService.getSheetValues();
      setSheetData(result);
    } catch (error: any) {
      setStatusMessage(error?.message || 'Unable to load the shared Google Sheet.');
      setStatusType('error');
      setSheetData(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) void loadSheet();
  }, [isOpen, loadSheet]);

  if (!isOpen) return null;

  const handleSync = async () => {
    setIsSyncing(true);
    setStatusMessage('');
    setStatusType('');
    try {
      const result = await googleSheetsService.syncRecords();
      setStatusMessage(`Synced ${Math.max(0, result.updatedRows - 1)} ledger records to the shared sheet.`);
      setStatusType('success');
      await loadSheet();
    } catch (error: any) {
      setStatusMessage(error?.message || 'Unable to sync records to Google Sheets.');
      setStatusType('error');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleCreate = async () => {
    setIsCreating(true);
    setStatusMessage('');
    setStatusType('');
    try {
      const result = await googleSheetsService.createSheet();
      setStatusMessage(`${result.created ? 'Ledger sheet created' : 'Ledger sheet already exists'} and synced with ${Math.max(0, result.updatedRows - 1)} records. New entries and deletions will now sync automatically.`);
      setStatusType('success');
      await loadSheet();
    } catch (error: any) {
      setStatusMessage(error?.message || 'Unable to create the Ledger sheet.');
      setStatusType('error');
    } finally {
      setIsCreating(false);
    }
  };

  const values = sheetData?.values || [];
  const headers = values[0] || [];
  const rows = values.slice(1);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 ios-blur">
      <motion.div initial={{ opacity: 0, scale: 0.97, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} className="bg-white rounded-2xl max-w-6xl w-full max-h-[92vh] shadow-2xl border border-slate-200 relative flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 p-4 sm:p-5 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2.5 bg-emerald-100 text-emerald-700 rounded-xl"><FileSpreadsheet className="h-5 w-5" /></div>
            <div className="min-w-0">
              <h3 className="text-sm sm:text-base font-bold text-slate-900">Shared Google Sheets Ledger</h3>
              <p className="text-[11px] sm:text-xs text-slate-500">One private sheet shared securely through your logged-in account</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700 p-1.5 rounded-full hover:bg-slate-100"><X className="h-5 w-5" /></button>
        </div>

        <div className="p-4 sm:p-5 border-b border-slate-100 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <LockKeyhole className="h-4 w-4 text-emerald-700 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-bold text-slate-800">Private sheet · View access</p>
              <p className="text-[11px] text-slate-500">Logged-in users can view data. Only Admin/Super Admin can create the sheet or sync manually. Entries and deletions sync automatically once the sheet is created.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void loadSheet()} disabled={isLoading || isSyncing || isCreating} className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-50 inline-flex items-center gap-1.5"><RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} /> Refresh</button>
            {isAdmin && <button onClick={() => void handleCreate()} disabled={isLoading || isSyncing || isCreating} className="px-3 py-2 text-xs font-bold rounded-lg border border-emerald-700 text-emerald-800 bg-white hover:bg-emerald-50 disabled:opacity-50 inline-flex items-center gap-1.5"><FilePlus2 className={`h-3.5 w-3.5 ${isCreating ? 'animate-pulse' : ''}`} /> {isCreating ? 'Creating…' : 'Create Sheet'}</button>}
            {isAdmin && <button onClick={() => void handleSync()} disabled={isLoading || isSyncing || isCreating} className="px-3 py-2 text-xs font-bold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50 inline-flex items-center gap-1.5"><RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} /> Sync app records</button>}
          </div>
        </div>

        {statusMessage && <div className={`mx-4 mt-4 p-3 rounded-lg text-xs flex items-start gap-2 ${statusType === 'error' ? 'bg-red-50 text-red-800 border border-red-200' : 'bg-emerald-50 text-emerald-800 border border-emerald-200'}`}>
          {statusType === 'error' ? <AlertCircle className="h-4 w-4 shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}{statusMessage}
        </div>}

        <div className="flex-1 min-h-0 overflow-auto p-4 sm:p-5">
          {isLoading ? <div className="py-12 text-center text-sm text-slate-500"><RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />Loading shared sheet…</div> : values.length === 0 ? <div className="py-12 text-center"><Eye className="h-8 w-8 text-slate-300 mx-auto mb-3" /><p className="text-sm font-semibold text-slate-700">No sheet data to display</p><p className="text-xs text-slate-500 mt-1">{sheetData?.tabExists === false ? 'The Ledger sheet has not been created yet. An Admin can create it with the Create Sheet button.' : 'Ask the administrator to configure the shared sheet and sync the ledger.'}</p></div> : <div className="overflow-auto border border-slate-200 rounded-xl">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-slate-50 sticky top-0"><tr>{headers.map((header, index) => <th key={`${header}-${index}`} className="px-3 py-2.5 font-bold text-slate-600 whitespace-nowrap border-b border-slate-200">{header || `Column ${index + 1}`}</th>)}</tr></thead>
              <tbody>{rows.map((row, rowIndex) => <tr key={`row-${rowIndex}`} className="odd:bg-white even:bg-slate-50/60 hover:bg-emerald-50/40">{headers.map((_, colIndex) => <td key={`${rowIndex}-${colIndex}`} className="px-3 py-2 text-slate-700 border-b border-slate-100 whitespace-nowrap">{row[colIndex] ?? ''}</td>)}</tr>)}</tbody>
            </table>
          </div>}
        </div>
        <div className="px-4 py-3 border-t border-slate-100 bg-white text-[10px] text-slate-400 flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" />Access is enforced by the server; Google credentials are not sent to the browser.</div>
      </motion.div>
    </div>
  );
}
