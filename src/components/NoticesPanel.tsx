import React, { useState, useEffect } from 'react';
import { 
  AlertTriangle, 
  CheckCircle, 
  RefreshCw, 
  User, 
  Calendar,
  Send,
  Trash2,
  ArrowUpRight,
  ArrowDownLeft
} from 'lucide-react';
import { User as UserType, TransactionRecord, Notice } from '../types';
import { dbService } from '../services/dbService';

interface NoticesPanelProps {
  currentUser: UserType;
  records: TransactionRecord[];
  onRefreshRecords: () => void;
  onToggleChat?: () => void;
}

export default function NoticesPanel({
  currentUser,
  records,
  onRefreshRecords,
  onToggleChat
}: NoticesPanelProps) {
  // Notices states
  const [notices, setNotices] = useState<Notice[]>([]);
  const [isNoticesLoading, setIsNoticesLoading] = useState(false);
  const [filterType, setFilterType] = useState<'all' | 'reported' | 'resolved' | 'payments'>('all');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const canDelete = currentUser.role === 'Super Admin' || currentUser.role === 'Admin';

  const fetchNotices = async () => {
    setIsNoticesLoading(true);
    try {
      const allNotices = await dbService.getNotices();
      setNotices(allNotices || []);
    } catch (err) {
      console.error('Error loading notices:', err);
    } finally {
      setIsNoticesLoading(false);
    }
  };

  useEffect(() => {
    fetchNotices();
  }, []);

  // Filter notices for display
  const displayedNotices = notices.filter(n => {
    if (filterType === 'all') return true;
    if (filterType === 'payments') return n.kind === 'payment';
    return n.kind !== 'payment' && n.status === filterType;
  });

  // Handle the Resolve action
  const handleResolveNotice = async (noticeId: string) => {
    try {
      await dbService.resolveNotice(noticeId);
      // Refresh local list and outer ledger list
      fetchNotices();
      onRefreshRecords();
    } catch (err) {
      console.error('Failed to resolve notice:', err);
    }
  };

  const handleDeleteNotice = async () => {
    if (!deleteId) return;
    try {
      await dbService.deleteNotice(deleteId);
      setNotices(prev => prev.filter(n => n.id !== deleteId));
    } catch (err) {
      console.error('Failed to delete notice:', err);
    } finally {
      setDeleteId(null);
    }
  };

  return (
    <div id="notices-panel-container" className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-gray-950 tracking-tight flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500 animate-pulse shrink-0" />
            Wrong Ledger Dispute Terminal
          </h2>
          <p className="text-xs text-gray-500">View reported ledger discrepancies and monitor resolution status.</p>
        </div>
        <div className="flex items-center gap-2.5 self-start shrink-0">
          {onToggleChat && (
            <button
              onClick={onToggleChat}
              className="flex items-center gap-2 bg-gray-950 text-white hover:bg-gray-800 px-5 py-2.5 rounded-xl text-xs font-black transition-all cursor-pointer shadow-sm active:scale-95"
              title="Open Chat Panel"
            >
              <Send className="h-3.5 w-3.5" />
              Chat
            </button>
          )}
          <button
            onClick={() => { fetchNotices(); onRefreshRecords(); }}
            className="flex items-center gap-1.5 bg-white border border-gray-100 hover:bg-gray-50 px-3 py-1.5 rounded-xl text-[11px] font-bold text-gray-600 transition-colors cursor-pointer shadow-xs"
          >
            <RefreshCw className={`h-3.95 w-3.5 ${isNoticesLoading ? 'animate-spin' : ''}`} />
            Refresh Lists
          </button>
        </div>
      </div>

      <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-50 pb-3 mb-3">
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Disputes Notice Board</span>
          
          {/* CHIP FILTERS */}
          <div className="flex gap-1.5">
            {(['all', 'reported', 'resolved', 'payments'] as const).map(type => (
              <button
                key={type}
                onClick={() => setFilterType(type)}
                className={`flex items-center gap-2 px-2.5 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                  filterType === type 
                    ? 'bg-gray-900 text-white' 
                    : 'bg-gray-50 text-gray-500 hover:bg-gray-100'
                }`}
              >
                {type}
              </button>
            ))}
          </div>
        </div>

        {/* NOTICES LIST */}
        {isNoticesLoading ? (
          <div className="py-12 text-center text-xs text-gray-400 flex flex-col items-center justify-center">
            <RefreshCw className="h-5 w-5 animate-spin mb-2.5 text-gray-300" />
            Retrieving reported disputes...
          </div>
        ) : displayedNotices.length > 0 ? (
          <div className="space-y-3 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-3 lg:items-start">
            {displayedNotices.map((notice) => {
              const isPayment = notice.kind === 'payment';
              const isPending = !isPayment && notice.status === 'reported';
              const received = notice.paymentDirection === 'received';
              if (isPayment) {
                return (
                  <div key={notice.id} id={`notice-card-${notice.id}`}
                    className={`p-4 border rounded-2xl ${received ? 'bg-emerald-50/40 border-emerald-100' : 'bg-indigo-50/40 border-indigo-100'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded-full tracking-wider flex items-center gap-1 ${received ? 'bg-emerald-100 text-emerald-800' : 'bg-indigo-100 text-indigo-800'}`}>
                            {received ? <ArrowDownLeft className="h-2.5 w-2.5" /> : <ArrowUpRight className="h-2.5 w-2.5" />}
                            {received ? 'Payment Received' : 'Payment Done'}
                          </span>
                          <span className="text-[9px] font-mono font-bold text-gray-400">Ref: {notice.recordId.slice(-8).toUpperCase()}</span>
                        </div>
                        <h4 className="text-xs font-extrabold text-gray-900 leading-tight">{notice.recordPurpose}</h4>
                        <p className={`text-xs font-black ${received ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {received ? '+' : '-'}₹{notice.recordAmount.toLocaleString('en-IN')}
                        </p>
                        <p className="text-[11px] text-gray-700 pt-1">{notice.reason}</p>
                        <div className="pt-2 text-[9px] text-gray-400 flex flex-wrap gap-x-3 gap-y-1 font-medium">
                          <span className="flex items-center gap-1"><User className="h-3 w-3" />By: {notice.reporterName} ({notice.reportedBy})</span>
                          <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />On: {new Date(notice.createdAt).toLocaleString()}</span>
                        </div>
                      </div>
                      {canDelete && (
                        <button onClick={() => setDeleteId(notice.id)} title="Delete"
                          className="bg-white border border-gray-200 hover:bg-rose-50 hover:border-rose-200 hover:text-rose-700 transition-all p-2 rounded-xl shrink-0 cursor-pointer flex flex-col items-center gap-1">
                          <Trash2 className="h-4 w-4 text-gray-400" />
                          <span className="text-[8px] font-black uppercase tracking-wider text-gray-500">Delete</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              }
              return (
                <div 
                  key={notice.id} 
                  id={`notice-card-${notice.id}`}
                  className={`p-4 border rounded-2xl transition-all duration-200 ${
                    isPending 
                      ? 'bg-amber-50/40 border-amber-100/70 shadow-2xs hover:bg-amber-50/60' 
                      : 'bg-gray-50/50 border-gray-100 hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded-full tracking-wider ${
                          isPending 
                            ? 'bg-amber-100 text-amber-800' 
                            : 'bg-emerald-100 text-emerald-800'
                        }`}>
                          {isPending ? '⚠️ Active Dispute' : '✅ Resolved'}
                        </span>
                        <span className="text-[9px] font-mono font-bold text-gray-400">
                          Report ID: {notice.id.slice(-6).toUpperCase()}
                        </span>
                      </div>

                      <h4 className="text-xs font-extrabold text-gray-900 leading-tight">
                        {notice.recordPurpose}
                      </h4>
                      
                      <p className="text-xs font-black text-rose-600">
                        Amount in Question: ₹{notice.recordAmount.toLocaleString('en-IN')}
                      </p>

                      <div className="mt-3 pt-2 border-t border-gray-100/50 space-y-1.5 text-[11px]">
                        <p className="text-gray-700">
                          <strong className="text-gray-900 font-bold">Discrepancy Category:</strong> {notice.reason}
                        </p>
                        {notice.customReason && (
                          <p className="text-gray-600 bg-white/70 border border-gray-100 p-2 rounded-lg italic">
                            "{notice.customReason}"
                          </p>
                        )}
                      </div>

                      <div className="pt-2 text-[9px] text-gray-400 flex flex-wrap gap-x-3 gap-y-1 font-medium">
                        <span className="flex items-center gap-1">
                          <User className="h-3 w-3" />
                          By: {notice.reporterName} ({notice.reportedBy})
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          On: {new Date(notice.createdAt).toLocaleString()}
                        </span>
                      </div>
                    </div>

                    {/* RESOLUTION ACTIONS */}
                    <div className="flex flex-col gap-2 shrink-0">
                    {isPending && (
                      <button
                        onClick={() => handleResolveNotice(notice.id)}
                        className="bg-white border border-gray-200 hover:bg-emerald-50 hover:border-emerald-200 hover:text-emerald-700 transition-all p-2 rounded-xl shrink-0 cursor-pointer flex flex-col items-center justify-center text-center gap-1 shadow-2xs"
                        title="Mark dispute resolved/rectified"
                      >
                        <CheckCircle className="h-4.5 w-4.5 text-gray-400 hover:text-emerald-600 transition-colors" />
                        <span className="text-[8px] font-black uppercase tracking-wider text-gray-500">Resolve</span>
                      </button>
                    )}
                    {canDelete && (
                      <button
                        onClick={() => setDeleteId(notice.id)}
                        className="bg-white border border-gray-200 hover:bg-rose-50 hover:border-rose-200 hover:text-rose-700 transition-all p-2 rounded-xl cursor-pointer flex flex-col items-center justify-center text-center gap-1 shadow-2xs"
                        title="Delete this dispute"
                      >
                        <Trash2 className="h-4 w-4 text-gray-400" />
                        <span className="text-[8px] font-black uppercase tracking-wider text-gray-500">Delete</span>
                      </button>
                    )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="py-16 text-center text-xs text-gray-400 flex flex-col items-center justify-center">
            <CheckCircle className="h-8 w-8 text-emerald-100 mb-3" />
            {filterType === 'payments' ? 'No payments made yet.' : 'Nothing on the notice board yet.'}
          </div>
        )}
      </div>

      {deleteId && (
        <div className="fixed inset-0 z-[100000000] flex items-center justify-center p-4 ios-blur" onClick={() => setDeleteId(null)}>
          <div className="bg-white rounded-2xl p-5 max-w-xs w-full shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <div>
              <h3 className="text-sm font-bold text-gray-900">Delete this notice?</h3>
              <p className="text-xs text-gray-500 mt-1">This permanently removes it from the notice board for everyone.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setDeleteId(null)} className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-2.5 rounded-xl text-xs cursor-pointer">Cancel</button>
              <button onClick={handleDeleteNotice} className="flex-1 bg-rose-600 hover:bg-rose-700 text-white font-bold py-2.5 rounded-xl text-xs cursor-pointer">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
