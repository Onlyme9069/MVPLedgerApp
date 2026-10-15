import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { X, ScanLine, QrCode, ArrowUpRight, ArrowDownLeft, CheckCircle2, Loader2, ImageUp, Wand2, ArrowLeft, ShieldCheck, Delete, Landmark, Link2Off, ChevronRight } from 'lucide-react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import RecordForm from './RecordForm';
import { dbService } from '../services/dbService';
import { TransactionRecord, User, Notice } from '../types';
import { triggerHapticFeedback } from '../utils/haptics';

const ORG_NAME = 'Mission Vikram Prakalp';
// Every payment goes through the organisation account, whoever is logged in.
const ORG_VPA = 'Mvp.Org@bankupi';
const BANK_KEY = 'mvp_linked_bank';
const DEMO_BANK = 'BANK OF NAPTUNE'; // demo only

interface LinkedBank { bankName: string; accountNumber: string; pin: string } // demo only: PIN kept locally for simulation

const loadBank = (): LinkedBank | null => {
  try { const v = localStorage.getItem(BANK_KEY); return v ? JSON.parse(v) : null; } catch { return null; }
};
const maskAcc = (n: string) => 'XXXX' + n.slice(-4);

function Keypad({ onKey }: { onKey: (k: string) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2 max-w-[260px] mx-auto">
      {['1','2','3','4','5','6','7','8','9','','0','del'].map((k, i) => k === '' ? <div key={i} /> : (
        <button key={i} onClick={() => onKey(k)} className="h-12 rounded-xl bg-slate-100 hover:bg-slate-200 active:scale-95 text-lg font-bold text-slate-800 flex items-center justify-center cursor-pointer">
          {k === 'del' ? <Delete className="h-5 w-5" /> : k}
        </button>
      ))}
    </div>
  );
}

function PinDots({ n }: { n: number }) {
  return (
    <div className="flex justify-center gap-3">
      {[0, 1, 2, 3].map(i => <div key={i} className={`h-3.5 w-3.5 rounded-full border-2 ${n > i ? 'bg-slate-900 border-slate-900' : 'border-slate-300'}`} />)}
    </div>
  );
}

type Step = 'bankList' | 'bankDetails' | 'setPin' | 'bankSuccess' | 'home' | 'scan' | 'payAmount' | 'pin' | 'processing' | 'success' | 'receive' | 'form';
type Flow = 'pay' | 'receive';

interface Payee { vpa: string; name: string; amount?: string; note?: string }
interface Prefill {
  transactionNature: 'Income' | 'Expense';
  moneySender: string;
  moneyReceiver: string;
  transactionType: 'UPI';
  amount: string;
  purpose: string;
  transactionDate: string;
  notes: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentUser: User;
  onRecorded: () => void;
}

// Simulated counter-parties are taken from the ledger in the database (past expense receivers / income senders)
const vpaFor = (name: string) => name.replace(/[^a-z0-9]/gi, '').toLowerCase() + '@okaxis';
async function pickDemoParty(nature: 'Expense' | 'Income'): Promise<string> {
  try {
    const recs = (await dbService.getRecords()).filter(r => r.status !== 'deleted' && r.transactionNature === nature);
    const names = Array.from(new Set(recs.map(r => (nature === 'Expense' ? r.moneyReceiver : r.moneySender).trim()).filter(n => n && n !== ORG_NAME)));
    if (names.length) return names[Math.floor(Math.random() * names.length)];
  } catch { /* fall through */ }
  return nature === 'Expense' ? 'Demo Vendor' : 'Demo Donor';
}

const makeRef = () => 'UPI' + Date.now().toString().slice(-9) + Math.floor(Math.random() * 90 + 10);
const todayStr = () => new Date().toLocaleDateString('en-CA');

function parseUpi(text: string): Payee | null {
  try {
    if (!text.toLowerCase().startsWith('upi://')) return null;
    const q = new URL(text.replace(/^upi:\/\//i, 'https://upi/')).searchParams;
    const vpa = q.get('pa');
    if (!vpa) return null;
    return { vpa, name: q.get('pn') || vpa, amount: q.get('am') || undefined, note: q.get('tn') || undefined };
  } catch {
    return null;
  }
}

export default function PayReceiveModal({ isOpen, onClose, currentUser, onRecorded }: Props) {
  const [step, setStep] = useState<Step>('home');
  const [flow, setFlow] = useState<Flow | null>(null);
  const [payee, setPayee] = useState<Payee | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState('');
  const [txnRef, setTxnRef] = useState('');
  const [payerName, setPayerName] = useState('');
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [bank, setBank] = useState<LinkedBank | null>(loadBank);
  const [accNo, setAccNo] = useState('');
  const [atm6, setAtm6] = useState('');
  const [newPin, setNewPin] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const payTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const myVpa = ORG_VPA;

  // Every completed payment is logged on the Notice Board (separate from disputes)
  const logPaymentNotice = (dir: 'paid' | 'received', party: string, amt: number, purpose: string, ref: string) => {
    const notice: Notice = {
      id: `notice_pay_${Date.now()}`,
      recordId: ref,
      recordPurpose: purpose || (dir === 'paid' ? 'UPI Payment' : 'UPI Receipt'),
      recordAmount: amt,
      reason: dir === 'paid' ? `Paid to ${party}` : `Received from ${party}`,
      customReason: `UPI Ref: ${ref} · ${ORG_VPA}`,
      reportedBy: currentUser.userId,
      reporterName: currentUser.name,
      status: 'resolved',
      createdAt: new Date().toISOString(),
      kind: 'payment',
      paymentDirection: dir,
      paymentParty: party,
    };
    dbService.createNotice(notice).catch(e => console.error('Failed to log payment notice', e));
  };

  const reset = useCallback(() => {
    if (payTimerRef.current) { clearTimeout(payTimerRef.current); payTimerRef.current = null; }
    setStep('home'); setFlow(null); setPayee(null); setAmount(''); setNote(''); setPin('');
    setError(null); setCamError(null); setAccNo(''); setAtm6(''); setNewPin(''); setQrUrl(''); setTxnRef(''); setPayerName(''); setPrefill(null); setSaveError(null);
  }, []);

  useEffect(() => () => { if (payTimerRef.current) clearTimeout(payTimerRef.current); }, []);

  useEffect(() => { if (isOpen) { reset(); setBank(loadBank()); } }, [isOpen, reset]);

  const handleClose = () => { reset(); onClose(); };

  const onScanned = useCallback((text: string) => {
    const p = parseUpi(text);
    if (!p) { setError('This is not a valid UPI QR code.'); return false; }
    triggerHapticFeedback('medium');
    setError(null);
    setPayee(p);
    setAmount(p.amount || '');
    setNote(p.note || '');
    setStep('payAmount');
    return true;
  }, []);

  // ---- Camera scanner ----
  useEffect(() => {
    if (step !== 'scan') return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    setCamError(null);

    const tick = () => {
      if (stopped) return;
      const v = videoRef.current, c = canvasRef.current;
      if (v && c && v.readyState === v.HAVE_ENOUGH_DATA && v.videoWidth) {
        c.width = v.videoWidth; c.height = v.videoHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(v, 0, 0, c.width, c.height);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const code = jsQR(img.data, img.width, img.height);
          if (code?.data && onScanned(code.data)) return;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera is not supported in this browser.');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        raf = requestAnimationFrame(tick);
      } catch (e: any) {
        setCamError(e?.message?.includes('Permission') || e?.name === 'NotAllowedError'
          ? 'Camera permission denied. Allow camera access, or use the options below.'
          : (e?.message || 'Unable to open camera.') + ' Use the options below instead.');
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach(t => t.stop());
    };
  }, [step, onScanned]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const code = jsQR(d.data, d.width, d.height);
      if (!code) setError('No QR code found in that image.');
      else onScanned(code.data);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  };

  // ---- Pay flow ----
  const startPay = () => {
    triggerHapticFeedback('light'); setError(null);
    if (!bank) { setStep('bankList'); return; }
    setFlow('pay'); setStep('scan');
  };

  const submitAmount = () => {
    const n = parseFloat(amount);
    if (isNaN(n) || n <= 0) { setError('Enter a valid amount greater than 0.'); return; }
    setError(null); setPin(''); setStep('pin');
  };

  const pressKey = (k: string) => {
    triggerHapticFeedback('light');
    if (k === 'del') return setPin(p => p.slice(0, -1));
    setPin(p => (p.length < 4 ? p + k : p));
  };

  useEffect(() => {
    if (step === 'pin' && pin.length === 4) {
      if (bank && pin !== bank.pin) {
        setError('Incorrect UPI PIN. Please try again.');
        triggerHapticFeedback('medium');
        const t = setTimeout(() => setPin(''), 400);
        return () => clearTimeout(t);
      }
      setError(null);
      setStep('processing');
      payTimerRef.current = setTimeout(() => {
        payTimerRef.current = null;
        const ref = makeRef();
        setTxnRef(ref);
        setPrefill({
          transactionNature: 'Expense',
          moneySender: ORG_NAME,
          moneyReceiver: payee?.name || '',
          transactionType: 'UPI',
          amount: amount,
          purpose: note || '',
          transactionDate: todayStr(),
          notes: `UPI Ref: ${ref} | Paid to: ${payee?.vpa} | Paid from: ${myVpa} (${bank?.bankName} ${bank ? maskAcc(bank.accountNumber) : ''}) | Entered by: ${currentUser.name}`,
        });
        logPaymentNotice('paid', payee?.name || 'Unknown payee', parseFloat(amount), note, ref);
        triggerHapticFeedback('heavy');
        setStep('success');
      }, 1000);
    }
  }, [step, pin, payee, amount, note, myVpa, currentUser.name, bank]);

  // ---- Receive flow ----
  const startReceive = () => {
    triggerHapticFeedback('light'); setError(null);
    if (!bank) { setStep('bankList'); return; }
    setFlow('receive'); setAmount(''); setNote(''); setStep('receive');
  };

  // ---- Bank linking ----
  const submitBankDetails = () => {
    if (!/^\d{9,18}$/.test(accNo)) { setError('Enter a valid account number (9 to 18 digits).'); return; }
    if (!/^\d{6}$/.test(atm6)) { setError('Enter the last 6 digits of your ATM card.'); return; }
    setError(null); setNewPin(''); setStep('setPin');
  };

  const pressNewPinKey = (k: string) => {
    triggerHapticFeedback('light');
    if (k === 'del') return setNewPin(p => p.slice(0, -1));
    setNewPin(p => (p.length < 4 ? p + k : p));
  };

  useEffect(() => {
    if (step === 'setPin' && newPin.length === 4) {
      const t = setTimeout(() => {
        const b: LinkedBank = { bankName: DEMO_BANK, accountNumber: accNo, pin: newPin };
        try { localStorage.setItem(BANK_KEY, JSON.stringify(b)); } catch { /* ignore */ }
        setBank(b);
        triggerHapticFeedback('heavy');
        setStep('bankSuccess');
      }, 300);
      return () => clearTimeout(t);
    }
  }, [step, newPin, accNo]);

  const handleUnlink = () => {
    if (!window.confirm('Unlink the bank account? You will need to link it again to pay or receive.')) return;
    try { localStorage.removeItem(BANK_KEY); } catch { /* ignore */ }
    setBank(null);
    reset();
  };

  useEffect(() => {
    if (step !== 'receive') return;
    const params = new URLSearchParams({ pa: myVpa, pn: ORG_NAME, cu: 'INR' });
    const n = parseFloat(amount);
    if (!isNaN(n) && n > 0) params.set('am', n.toFixed(2));
    if (note.trim()) params.set('tn', note.trim());
    QRCode.toDataURL('upi://pay?' + params.toString(), { width: 512, margin: 1 }).then(setQrUrl).catch(() => setQrUrl(''));
  }, [step, amount, note, myVpa]);

  const simulateReceived = () => {
    const n = parseFloat(amount);
    if (isNaN(n) || n <= 0) { setError('Enter the amount to receive first, then simulate the payment.'); return; }
    setError(null);
    setStep('processing');
    pickDemoParty('Income').then(name => {
      const ref = makeRef();
      setPayerName(name);
      setTxnRef(ref);
      setPrefill({
        transactionNature: 'Income',
        moneySender: name,
        moneyReceiver: ORG_NAME,
        transactionType: 'UPI',
        amount: String(n),
        purpose: note.trim(),
        transactionDate: todayStr(),
        notes: `UPI Ref: ${ref} | Received on: ${myVpa} (${bank?.bankName} ${bank ? maskAcc(bank.accountNumber) : ''}) | Payer: ${name} | Entered by: ${currentUser.name}`,
      });
      logPaymentNotice('received', name, n, note.trim(), ref);
      triggerHapticFeedback('heavy');
      setStep('success');
    });
  };

  // ---- Save ----
  const handleSave = async (data: any) => {
    try {
      const now = new Date().toISOString();
      const rec: TransactionRecord = {
        id: `rec_${Date.now()}`,
        transactionNature: data.transactionNature,
        moneySender: data.moneySender,
        moneyReceiver: data.moneyReceiver,
        transactionType: data.transactionType,
        amount: data.amount,
        purpose: data.purpose,
        transactionDate: data.transactionDate,
        notes: data.notes,
        createdBy: currentUser.userId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      await dbService.createRecord(rec);
      onRecorded();
      handleClose();
    } catch (e) {
      console.error(e);
      setSaveError('Failed to save record. Please try again.');
    }
  };

  const back = () => {
    setError(null);
    if (step === 'scan' || step === 'receive') setStep('home');
    else if (step === 'payAmount') setStep('scan');
    else if (step === 'pin') { setPin(''); setStep('payAmount'); }
    else if (step === 'bankList') setStep('home');
    else if (step === 'bankDetails') setStep('bankList');
    else if (step === 'setPin') { setNewPin(''); setStep('bankDetails'); }
  };

  const title = step.startsWith('bank') || step === 'setPin' ? 'Link Bank Account' : step === 'form' ? 'Add to Ledger' : step === 'scan' ? 'Scan & Pay' : step === 'receive' ? 'Receive Money' : 'Pay & Receive';
  const inputCls = 'w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-300 text-slate-800';

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div style={{ zIndex: 100000000 }} className="fixed inset-0 flex items-end sm:items-center justify-center">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={step === 'form' ? undefined : handleClose}
            className="absolute inset-0 ios-blur" />

          <motion.div
            initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }}
            transition={{ type: 'spring', damping: 26, stiffness: 280 }}
            className="relative w-full sm:max-w-md bg-white sm:rounded-3xl rounded-t-3xl shadow-2xl flex flex-col max-h-[94vh] overflow-hidden"
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/80 shrink-0">
              <div className="flex items-center gap-2">
                {['scan', 'receive', 'payAmount', 'pin', 'bankList', 'bankDetails', 'setPin'].includes(step) && (
                  <button onClick={back} className="p-1.5 text-slate-500 hover:bg-slate-200/60 rounded-lg cursor-pointer"><ArrowLeft className="h-4 w-4" /></button>
                )}
                <h3 className="text-sm font-bold text-slate-900">{title}</h3>
                <span className="text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Simulation</span>
              </div>
              <div className="flex flex-col items-end gap-1">
                <button onClick={handleClose} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded-xl cursor-pointer"><X className="h-4 w-4" /></button>
                {bank && step === 'home' && (
                  <button onClick={handleUnlink} className="text-[10px] font-bold text-rose-600 hover:text-rose-700 hover:bg-rose-50 px-1.5 py-0.5 rounded-md flex items-center gap-1 cursor-pointer">
                    <Link2Off className="h-3 w-3" /> Unlink account
                  </button>
                )}
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-4">
              {error && <div className="bg-red-50 text-red-600 text-xs font-semibold p-3 rounded-xl border border-red-100 mb-3">{error}</div>}

              {step === 'home' && (
                <div className="py-8 text-center space-y-3">
                  <div className="mx-auto h-16 w-16 rounded-full bg-black text-white flex items-center justify-center"><QrCode className="h-8 w-8" /></div>
                  <h4 className="text-base font-bold text-slate-900">UPI Payments</h4>
                  <p className="text-xs text-slate-500 max-w-xs mx-auto">Scan a QR to pay a vendor, or show your QR to receive a donation. Details are auto-filled into the ledger entry afterwards.</p>
                  {bank ? (
                    <p className="text-[11px] text-slate-400">UPI ID: <span className="font-semibold text-slate-600">{myVpa}</span><br />{bank.bankName} · {maskAcc(bank.accountNumber)}</p>
                  ) : (
                    <p className="text-[11px] text-amber-600 font-semibold">No bank account linked. Tap Pay or Receive to link one.</p>
                  )}
                </div>
              )}

              {step === 'scan' && (
                <div className="space-y-3">
                  <div className="relative aspect-square w-full bg-slate-900 rounded-2xl overflow-hidden">
                    <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-cover" />
                    <canvas ref={canvasRef} className="hidden" />
                    {!camError && (
                      <div className="absolute inset-8 border-2 border-white/80 rounded-2xl pointer-events-none">
                        <motion.div animate={{ top: ['0%', '100%', '0%'] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
                          className="absolute left-0 right-0 h-0.5 bg-emerald-400 shadow-[0_0_10px_2px_rgba(52,211,153,0.8)]" />
                      </div>
                    )}
                    {camError && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-xs text-slate-200">{camError}</div>}
                  </div>
                  <p className="text-[11px] text-slate-500 text-center">Point the camera at a UPI QR code</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={() => fileRef.current?.click()} className="py-2.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs font-bold text-slate-700 flex items-center justify-center gap-1.5 cursor-pointer">
                      <ImageUp className="h-4 w-4" /> Upload QR image
                    </button>
                    <button onClick={async () => { const n = await pickDemoParty('Expense'); onScanned(`upi://pay?pa=${vpaFor(n)}&pn=${encodeURIComponent(n)}&cu=INR`); }}
                      className="py-2.5 rounded-xl border border-amber-200 bg-amber-50 hover:bg-amber-100 text-xs font-bold text-amber-800 flex items-center justify-center gap-1.5 cursor-pointer">
                      <Wand2 className="h-4 w-4" /> Simulate scan
                    </button>
                  </div>
                  <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                </div>
              )}

              {step === 'payAmount' && payee && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 bg-slate-50 border border-slate-200 rounded-2xl">
                    <div className="h-11 w-11 rounded-full bg-black text-white font-bold flex items-center justify-center">{payee.name.charAt(0).toUpperCase()}</div>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-900 truncate">{payee.name}</p>
                      <p className="text-[11px] text-slate-500 truncate">{payee.vpa}</p>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Amount (₹)</label>
                    <input type="number" inputMode="decimal" autoFocus value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00"
                      className={inputCls + ' text-2xl font-bold'} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Purpose / Note</label>
                    <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Study material printing" className={inputCls} />
                  </div>
                  <button onClick={submitAmount} className="w-full bg-black hover:bg-black/20 text-white font-bold py-3 rounded-3xl border-black cursor-pointer">Proceed to Pay</button>
                </div>
              )}

              {step === 'pin' && payee && (
                <div className="text-center space-y-4">
                  <div>
                    <p className="text-xs text-slate-500">Paying {payee.name}</p>
                    <p className="text-3xl font-black text-slate-900">₹{parseFloat(amount).toLocaleString('en-IN')}</p>
                  </div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center justify-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> Enter your 4-digit UPI PIN</p>
                  <PinDots n={pin.length} />
                  <Keypad onKey={pressKey} />
                </div>
              )}

              {step === 'bankList' && (
                <div className="space-y-3">
                  <p className="text-xs text-slate-500">Select your bank to link an account for UPI payments.</p>
                  <button onClick={() => { setError(null); setStep('bankDetails'); }}
                    className="w-full p-3 bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 rounded-xl flex items-center justify-between cursor-pointer text-left">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-black text-white rounded-3xl"><Landmark className="h-5 w-5" /></div>
                      <div>
                        <span className="text-sm font-bold text-slate-800 block">{DEMO_BANK}</span>
                        <span className="text-[10px] text-slate-500">Inter palnet bank</span>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  </button>
                </div>
              )}

              {step === 'bankDetails' && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 bg-slate-50 border border-slate-200 rounded-2xl">
                    <div className="p-2 bg-black text-white rounded-3xl"><Landmark className="h-5 w-5" /></div>
                    <span className="text-sm font-bold text-slate-800">{DEMO_BANK}</span>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Account Number</label>
                    <input type="text" inputMode="numeric" maxLength={18} value={accNo} onChange={e => setAccNo(e.target.value.replace(/\D/g, ''))}
                      placeholder="Enter account number" className={inputCls + ' tracking-wider'} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">ATM Card - Last 6 Digits</label>
                    <input type="text" inputMode="numeric" maxLength={6} value={atm6} onChange={e => setAtm6(e.target.value.replace(/\D/g, ''))}
                      placeholder="6 digits" className={inputCls + ' tracking-widest'} />
                  </div>
                  <button onClick={submitBankDetails} className="w-full bg-black hover:bg-black/20 text-white font-bold py-3 rounded-3xl border-1 border-black cursor-pointer">Add Account</button>
                </div>
              )}

              {step === 'setPin' && (
                <div className="text-center space-y-4 py-2">
                  <div>
                    <h4 className="text-base font-bold text-slate-900">Set UPI PIN</h4>
                    <p className="text-[11px] text-slate-500 mt-1">Choose a 4-digit PIN to authorise payments</p>
                  </div>
                  <PinDots n={newPin.length} />
                  <Keypad onKey={pressNewPinKey} />
                </div>
              )}

              {step === 'bankSuccess' && bank && (
                <div className="py-6 text-center space-y-4">
                  <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }}
                    className="mx-auto h-20 w-20 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
                    <CheckCircle2 className="h-11 w-11" />
                  </motion.div>
                  <div>
                    <h4 className="text-lg font-bold text-slate-900">Account Added Successfully</h4>
                    <p className="text-xs text-slate-500 mt-1">{bank.bankName} · {maskAcc(bank.accountNumber)}</p>
                    <p className="text-[11px] text-slate-400 mt-1">UPI ID: {myVpa}</p>
                  </div>
                  <button onClick={reset} className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-3 rounded-xl cursor-pointer">Done</button>
                </div>
              )}

              {step === 'processing' && (
                <div className="py-16 text-center space-y-3">
                  <Loader2 className="h-10 w-10 animate-spin mx-auto text-indigo-600" />
                  <p className="text-sm font-bold text-slate-800">Processing transaction…</p>
                </div>
              )}

              {step === 'success' && prefill && (
                <div className="py-6 text-center space-y-4">
                  <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }}
                    className="mx-auto h-20 w-20 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
                    <CheckCircle2 className="h-11 w-11" />
                  </motion.div>
                  <div>
                    <h4 className="text-lg font-bold text-slate-900">{flow === 'pay' ? 'Payment Successful' : 'Payment Received'}</h4>
                    <p className="text-3xl font-black text-slate-900 mt-1">₹{parseFloat(prefill.amount).toLocaleString('en-IN')}</p>
                    <p className="text-xs text-slate-500 mt-1">{flow === 'pay' ? `to ${prefill.moneyReceiver}` : `from ${payerName}`}</p>
                    <p className="text-[10px] text-slate-400 mt-2">Ref: {txnRef}</p>
                  </div>
                  <button onClick={() => setStep('form')} className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-3 rounded-xl cursor-pointer">Add to Ledger</button>
                </div>
              )}

              {step === 'receive' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Amount (₹)</label>
                      <input type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="Any" className={inputCls + ' font-bold'} />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">Purpose</label>
                      <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Donation" className={inputCls} />
                    </div>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-2xl p-4 flex flex-col items-center">
                    {qrUrl ? <img src={qrUrl} alt="UPI QR" className="w-56 h-56" /> : <div className="w-56 h-56 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>}
                    <p className="text-sm font-bold text-slate-900 mt-2">{ORG_NAME}</p>
                    <p className="text-[11px] text-slate-500">{myVpa}</p>
                  </div>
                  <button onClick={simulateReceived} className="w-full py-3 rounded-xl border border-amber-200 bg-amber-50 hover:bg-amber-100 text-xs font-bold text-amber-800 flex items-center justify-center gap-1.5 cursor-pointer">
                    <Wand2 className="h-4 w-4" /> Simulate payment received
                  </button>
                </div>
              )}

              {step === 'form' && prefill && (
                <div>
                  {saveError && <div className="bg-red-50 text-red-600 text-xs font-semibold p-3 rounded-xl border border-red-100 mb-3">{saveError}</div>}
                  <RecordForm prefill={prefill} embedded onSave={handleSave} onCancel={handleClose} />
                </div>
              )}
            </div>

            {/* Bottom action bar: Pay | Receive */}
            {step === 'home' && (
              <div className="grid grid-cols-2 gap-3 p-4 m-4 border-t border-slate-100 shrink-0 safe-bottom">
                <button onClick={startPay} className="py-3.5 rounded-2xl bg-rose-600 hover:bg-white hover:text-rose-600 text-white hover:border hover:border-rose-600 font-bold text-sm flex items-center justify-center gap-2 shadow-sm cursor-pointer">
                  <ScanLine className="h-4 w-4" /> Pay <ArrowUpRight className="h-4 w-4" />
                </button>
                <button onClick={startReceive} className="py-3.5 rounded-2xl bg-emerald-600 hover:bg-white hover:text-emerald-600 text-white hover:border hover:border-emerald-600 font-bold text-sm flex items-center justify-center gap-2 shadow-sm cursor-pointer">
                  <QrCode className="h-4 w-4" /> Receive <ArrowDownLeft className="h-4 w-4" />
                </button>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}
