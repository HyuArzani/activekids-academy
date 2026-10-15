"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Wallet,
  Plus,
  AlertCircle,
  Loader2,
  RefreshCw,
  ArrowDownCircle,
  ArrowUpCircle,
  TrendingUp,
  TrendingDown,
  Calendar,
  Receipt,
  MessageCircle,
  Copy,
  Check,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CSRF_HEADER } from "@/lib/auth/csrf";
import { toast } from "@/hooks/use-toast";

// ============================================================================
// Types
// ============================================================================

interface AcademyPayment {
  id: string;
  studentId: string;
  studentName: string;
  payerName: string | null;
  paymentMethod: string;
  amount: string; // numeric(12,2) as string
  paymentDate: string;
  referenceNumber: string | null;
  notes: string | null;
  status: string;
  packageId: string | null;
  packageName: string | null;
  sessionCount: number | null;
  recordedAt: string;
}

interface ExpenseRow {
  id: string;
  amount: string;
  category: string;
  incurredOn: string;
  note: string | null;
  relatedPaymentId: string | null;
  createdBy: string;
  createdAt: string;
}

interface PackagePlan {
  id: string;
  name: string;
  sessionCount: number;
  isActive: boolean;
}

interface Student {
  id: string;
  full_name: string;
}

/** Raw shape returned by GET /api/admin/package-plans (snake_case from DB). */
interface PackagePlanApi {
  id: string;
  name: string;
  session_count: number;
  is_active: boolean;
}

function mapPlan(p: PackagePlanApi): PackagePlan {
  return {
    id: p.id,
    name: p.name,
    sessionCount: p.session_count,
    isActive: p.is_active,
  };
}

interface DashboardSummary {
  finances: {
    monthPaymentTotal: string;
    monthExpenseTotal: string;
  };
  monthStart: string;
  monthEnd: string;
}

type PaymentsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: AcademyPayment[] };

type ExpensesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: ExpenseRow[] };

// ============================================================================
// Helpers
// ============================================================================

/** Today's date in Asia/Jakarta (UTC+7), as YYYY-MM-DD. */
function jakartaTodayYmd(): string {
  const shifted = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** First day of the current month in Jakarta, YYYY-MM-DD. */
function jakartaMonthStart(): string {
  const shifted = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/** First day of next month in Jakarta (exclusive upper bound). */
function jakartaMonthEnd(): string {
  const shifted = new Date(Date.now() + 7 * 60 * 60 * 1000);
  let y = shifted.getUTCFullYear();
  let m = shifted.getUTCMonth() + 1; // 1-12
  if (m === 12) {
    m = 1;
    y += 1;
  } else {
    m += 1;
  }
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** Format an IDR amount string (e.g. "500000.00") as "Rp 500.000". */
function formatRupiah(amountStr: string): string {
  const n = Number(amountStr);
  if (Number.isNaN(n)) return `Rp ${amountStr}`;
  return `Rp ${n.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`;
}

/** Format a YYYY-MM-DD as "DD Mon YYYY" using Indonesian locale. */
function formatDateShort(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/** Map a payment status (API enum value) to an Indonesian display label. */
function paymentStatusLabel(status: string): string {
  if (status === "submitted") return "Menunggu";
  if (status === "confirmed") return "Dikonfirmasi";
  return status;
}

async function adminFetch(url: string, method: string, body?: unknown): Promise<Response> {
  const csrfMatch = document.cookie.split("; ").find((c) => c.startsWith("futsal_csrf="));
  const csrfToken = csrfMatch?.split("=")[1] ?? "";
  return fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      [CSRF_HEADER]: csrfToken,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ============================================================================
// Main component
// ============================================================================

export function PaymentsManagement({ academyId }: { academyId: string }) {
  const [fromDate, setFromDate] = useState<string>(jakartaMonthStart());
  const [toDate, setToDate] = useState<string>(jakartaTodayYmd());
  const [payments, setPayments] = useState<PaymentsState>({ status: "loading" });
  const [expenses, setExpenses] = useState<ExpensesState>({ status: "loading" });
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [showRecordPayment, setShowRecordPayment] = useState(false);
  const [showRecordExpense, setShowRecordExpense] = useState(false);
  const academyIdRef = useRef(academyId);
  useEffect(() => {
    academyIdRef.current = academyId;
  }, [academyId]);

  // Request-ordering token: incremented on each fetchAll/effect-fetch
  // call. Before applying a response, check if this token still matches
  // the latest value. If a newer request has started, the stale response
  // is discarded. This prevents an older (slower) request from
  // overwriting newer data — e.g., a post-mutation refetch racing a
  // date-range change, or a manual Refresh racing the deps-change fetch.
  // Mirrors the RegistrationsManagement pattern (Phase B3.3.2).
  const requestIdRef = useRef(0);

  const fetchAll = useCallback(async () => {
    const aid = academyId;
    const from = fromDate;
    const to = toDate;
    const myRequestId = ++requestIdRef.current;
    setPayments({ status: "loading" });
    setExpenses({ status: "loading" });
    try {
      const [payRes, expRes, sumRes] = await Promise.all([
        fetch(`/api/admin/payments?academyId=${aid}&fromDate=${from}&toDate=${to}`, { credentials: "same-origin" }),
        fetch(`/api/admin/expenses?academyId=${aid}&fromDate=${from}&toDate=${to}`, { credentials: "same-origin" }),
        fetch(`/api/admin/dashboard/summary?academyId=${aid}`, { credentials: "same-origin" }),
      ]);
      // Stale-response guard: if a newer request started, discard this.
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      const payData = (await payRes.json()) as { payments?: AcademyPayment[]; error?: { message?: string } };
      if (!payRes.ok || !payData.payments) {
        setPayments({ status: "error", message: payData.error?.message ?? `Error ${payRes.status}` });
      } else {
        setPayments({ status: "success", data: payData.payments });
      }
      const expData = (await expRes.json()) as { expenses?: ExpenseRow[]; error?: { message?: string } };
      if (!expRes.ok || !expData.expenses) {
        setExpenses({ status: "error", message: expData.error?.message ?? `Error ${expRes.status}` });
      } else {
        setExpenses({ status: "success", data: expData.expenses });
      }
      if (sumRes.ok) {
        const sumData = (await sumRes.json()) as DashboardSummary;
        if (myRequestId === requestIdRef.current && aid === academyIdRef.current) setSummary(sumData);
      }
    } catch {
      if (myRequestId !== requestIdRef.current) return;
      if (aid !== academyIdRef.current) return;
      setPayments({ status: "error", message: "Kesalahan jaringan" });
      setExpenses({ status: "error", message: "Kesalahan jaringan" });
    }
  }, [academyId, fromDate, toDate]);

  useEffect(() => {
    if (!academyId) return;
    const myRequestId = ++requestIdRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const [payRes, expRes, sumRes] = await Promise.all([
          fetch(`/api/admin/payments?academyId=${academyId}&fromDate=${fromDate}&toDate=${toDate}`, { credentials: "same-origin" }),
          fetch(`/api/admin/expenses?academyId=${academyId}&fromDate=${fromDate}&toDate=${toDate}`, { credentials: "same-origin" }),
          fetch(`/api/admin/dashboard/summary?academyId=${academyId}`, { credentials: "same-origin" }),
        ]);
        if (cancelled || myRequestId !== requestIdRef.current) return;
        const payData = (await payRes.json()) as { payments?: AcademyPayment[]; error?: { message?: string } };
        if (!payRes.ok || !payData.payments) {
          setPayments({ status: "error", message: payData.error?.message ?? `Error ${payRes.status}` });
        } else {
          setPayments({ status: "success", data: payData.payments });
        }
        const expData = (await expRes.json()) as { expenses?: ExpenseRow[]; error?: { message?: string } };
        if (!expRes.ok || !expData.expenses) {
          setExpenses({ status: "error", message: expData.error?.message ?? `Error ${expRes.status}` });
        } else {
          setExpenses({ status: "success", data: expData.expenses });
        }
        if (sumRes.ok) {
          const sumData = (await sumRes.json()) as DashboardSummary;
          if (!cancelled && myRequestId === requestIdRef.current) setSummary(sumData);
        }
      } catch {
        if (cancelled || myRequestId !== requestIdRef.current) return;
        setPayments({ status: "error", message: "Kesalahan jaringan" });
        setExpenses({ status: "error", message: "Kesalahan jaringan" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [academyId, fromDate, toDate]);

  // Compute net total from the loaded payments + expenses in the selected range.
  const totalIncome =
    payments.status === "success"
      ? payments.data.reduce((sum, p) => sum + Number(p.amount), 0)
      : 0;
  const totalExpense =
    expenses.status === "success"
      ? expenses.data.reduce((sum, e) => sum + Number(e.amount), 0)
      : 0;
  const net = totalIncome - totalExpense;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-muted-foreground">Pembayaran & Pengeluaran</h3>
          <p className="text-xs text-muted-foreground">
            Catat pembayaran tunai / transfer bank, lacak pengeluaran, dan lihat ringkasan keuangan bulanan.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="payments-from" className="text-xs text-muted-foreground">
              Dari
            </Label>
            <Input id="payments-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-36" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="payments-to" className="text-xs text-muted-foreground">
              Sampai
            </Label>
            <Input id="payments-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-36" />
          </div>
          <Button variant="outline" size="sm" onClick={() => void fetchAll()} className="gap-2">
            <RefreshCw className="h-4 w-4" aria-hidden /> Segarkan
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowRecordExpense(true)} className="gap-2">
            <ArrowDownCircle className="h-4 w-4" aria-hidden /> Pengeluaran
          </Button>
          <Button size="sm" onClick={() => setShowRecordPayment(true)} className="gap-2">
            <Plus className="h-4 w-4" aria-hidden /> Catat Pembayaran
          </Button>
        </div>
      </div>

      {/* Financial summary cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          label="Pemasukan (rentang)"
          value={formatRupiah(String(totalIncome))}
          icon={TrendingUp}
          color="emerald"
          subtitle={`${payments.status === "success" ? payments.data.length : 0} pembayaran`}
        />
        <SummaryCard
          label="Pengeluaran (rentang)"
          value={formatRupiah(String(totalExpense))}
          icon={TrendingDown}
          color="rose"
          subtitle={`${expenses.status === "success" ? expenses.data.length : 0} pengeluaran`}
        />
        <SummaryCard
          label="Bersih (rentang)"
          value={formatRupiah(String(net))}
          icon={Wallet}
          color={net >= 0 ? "emerald" : "rose"}
          subtitle={net >= 0 ? "Surplus" : "Defisit"}
        />
        {summary && (
          <SummaryCard
            label="Pemasukan bulan ini"
            value={formatRupiah(summary.finances.monthPaymentTotal)}
            icon={Calendar}
            color="primary"
            subtitle={`${formatDateShort(summary.monthStart)} → ${formatDateShort(summary.monthEnd)}`}
          />
        )}
      </div>

      {/* Payments section */}
      <div className="space-y-2">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <ArrowUpCircle className="h-4 w-4 text-emerald-600" aria-hidden />
          Pembayaran
          {payments.status === "success" && (
            <Badge variant="outline" className="text-xs font-normal">
              {payments.data.length}
            </Badge>
          )}
        </h4>

        {payments.status === "loading" && (
          <Card>
            <CardContent className="flex items-center gap-3 p-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
              <p className="text-sm text-muted-foreground">Memuat pembayaran…</p>
            </CardContent>
          </Card>
        )}
        {payments.status === "error" && (
          <Card className="border-destructive/30">
            <CardContent className="p-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
                <div>
                  <p className="text-sm font-medium text-destructive">Gagal memuat pembayaran</p>
                  <p className="mt-1 text-sm text-muted-foreground">{payments.message}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
        {payments.status === "success" && payments.data.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center">
              <Wallet className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
              <p className="mt-3 text-sm font-medium">Tidak ada pembayaran pada periode ini</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Klik &ldquo;Catat Pembayaran&rdquo; untuk mencatat pembayaran tunai atau transfer bank baru.
              </p>
            </CardContent>
          </Card>
        )}
        {payments.status === "success" && payments.data.length > 0 && (
          <div className="space-y-2">
            {payments.data.map((p) => (
              <PaymentCard key={p.id} payment={p} academyId={academyId} />
            ))}
          </div>
        )}
      </div>

      {/* Expenses section */}
      <div className="space-y-2">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <ArrowDownCircle className="h-4 w-4 text-rose-600" aria-hidden />
          Pengeluaran
          {expenses.status === "success" && (
            <Badge variant="outline" className="text-xs font-normal">
              {expenses.data.length}
            </Badge>
          )}
        </h4>

        {expenses.status === "loading" && (
          <Card>
            <CardContent className="flex items-center gap-3 p-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
              <p className="text-sm text-muted-foreground">Memuat pengeluaran…</p>
            </CardContent>
          </Card>
        )}
        {expenses.status === "error" && (
          <Card className="border-destructive/30">
            <CardContent className="p-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
                <p className="text-sm text-muted-foreground">{expenses.message}</p>
              </div>
            </CardContent>
          </Card>
        )}
        {expenses.status === "success" && expenses.data.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center">
              <Receipt className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
              <p className="mt-3 text-sm font-medium">Tidak ada pengeluaran pada periode ini</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Klik &ldquo;Pengeluaran&rdquo; untuk mencatat pengembalian dana, pembelian peralatan, atau biaya lain.
              </p>
            </CardContent>
          </Card>
        )}
        {expenses.status === "success" && expenses.data.length > 0 && (
          <div className="space-y-2">
            {expenses.data.map((e) => (
              <ExpenseCard key={e.id} expense={e} academyId={academyId} />
            ))}
          </div>
        )}
      </div>

      {/* Dialogs */}
      {showRecordPayment && (
        <RecordPaymentDialog
          open={showRecordPayment}
          onClose={() => setShowRecordPayment(false)}
          academyId={academyId}
          onRecorded={() => {
            setShowRecordPayment(false);
            void fetchAll();
          }}
        />
      )}
      {showRecordExpense && (
        <RecordExpenseDialog
          open={showRecordExpense}
          onClose={() => setShowRecordExpense(false)}
          academyId={academyId}
          onRecorded={() => {
            setShowRecordExpense(false);
            void fetchAll();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Summary Card
// ============================================================================

function SummaryCard({
  label,
  value,
  icon: Icon,
  color,
  subtitle,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  color: "emerald" | "rose" | "primary" | "amber";
  subtitle: string;
}) {
  const colors: Record<typeof color, string> = {
    emerald: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
    rose: "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400",
    primary: "bg-primary/10 text-primary",
    amber: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  };
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
          <div className={`flex h-7 w-7 items-center justify-center rounded-md ${colors[color]}`}>
            <Icon className="h-4 w-4" aria-hidden />
          </div>
        </div>
        <p className="mt-2 text-xl font-semibold">{value}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Payment Card
// ============================================================================

function PaymentCard({ payment, academyId }: { payment: AcademyPayment; academyId: string }) {
  const [showMessage, setShowMessage] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleShowMessage = async () => {
    if (message) {
      setShowMessage(true);
      return;
    }
    try {
      const res = await fetch(`/api/admin/payments/${payment.id}/message?academyId=${academyId}`, {
        credentials: "same-origin",
      });
      const data = (await res.json()) as { message?: string; error?: { message?: string } };
      if (res.ok && data.message) {
        setMessage(data.message);
        setShowMessage(true);
      }
    } catch {
      // ignore
    }
  };

  const handleCopy = async () => {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <Card className="transition-all hover:border-primary/40">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400">
              <ArrowUpCircle className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium leading-tight">{payment.studentName}</p>
                <Badge variant="secondary" className="text-xs">
                  {payment.paymentMethod === "cash" ? "Tunai" : "Transfer Bank"}
                </Badge>
                <Badge
                  variant="outline"
                  className={
                    payment.status === "confirmed"
                      ? "border-emerald-200 text-emerald-700 dark:border-emerald-900 dark:text-emerald-400"
                      : payment.status === "submitted"
                        ? "border-amber-200 text-amber-700 dark:border-amber-900 dark:text-amber-400"
                        : "border-muted-foreground/30 text-muted-foreground"
                  }
                >
                  {paymentStatusLabel(payment.status)}
                </Badge>
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {payment.packageName ?? "—"}
                {payment.sessionCount ? ` · ${payment.sessionCount} sesi` : ""}
                {payment.payerName ? ` · dibayar oleh ${payment.payerName}` : ""}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatDateShort(payment.paymentDate)}
                {payment.referenceNumber ? ` · No. Ref: ${payment.referenceNumber}` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <p className="text-lg font-semibold tabular-nums">{formatRupiah(payment.amount)}</p>
            <Button variant="ghost" size="sm" onClick={handleShowMessage} className="h-7 gap-1.5 text-xs">
              <MessageCircle className="h-3.5 w-3.5" aria-hidden /> Konfirmasi
            </Button>
          </div>
        </div>
        {showMessage && message && (
          <div className="mt-3 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Pesan konfirmasi WhatsApp
              </p>
              <Button variant="ghost" size="sm" onClick={handleCopy} className="h-7 gap-1.5 text-xs">
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden /> Tersalin
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden /> Salin
                  </>
                )}
              </Button>
            </div>
            <pre className="mt-2 whitespace-pre-wrap text-xs leading-relaxed">{message}</pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Expense Card
// ============================================================================

function ExpenseCard({ expense, academyId: _academyId }: { expense: ExpenseRow; academyId: string }) {
  const isRefund = expense.category.toLowerCase() === "refund";
  return (
    <Card className="transition-all hover:border-primary/40">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-lg ${
                isRefund
                  ? "bg-amber-50 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400"
                  : "bg-rose-50 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400"
              }`}
            >
              <ArrowDownCircle className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium leading-tight">{expense.category}</p>
                {isRefund && (
                  <Badge variant="outline" className="border-amber-200 text-amber-700 dark:border-amber-900 dark:text-amber-400">
                    Pengembalian
                  </Badge>
                )}
              </div>
              {expense.note && <p className="mt-0.5 text-sm text-muted-foreground">{expense.note}</p>}
              <p className="mt-0.5 text-xs text-muted-foreground">{formatDateShort(expense.incurredOn)}</p>
            </div>
          </div>
          <p className="text-lg font-semibold tabular-nums">{formatRupiah(expense.amount)}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Record Payment Dialog
// ============================================================================

function RecordPaymentDialog({
  open,
  onClose,
  academyId,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  academyId: string;
  onRecorded: () => void;
}) {
  const [students, setStudents] = useState<Student[]>([]);
  const [plans, setPlans] = useState<PackagePlan[]>([]);
  const [studentId, setStudentId] = useState("");
  const [packagePlanId, setPackagePlanId] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "bank_transfer">("cash");
  const [paymentDate, setPaymentDate] = useState(jakartaTodayYmd());
  const [payerName, setPayerName] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeyRef = useRef<string>("");
  useEffect(() => {
    idempotencyKeyRef.current = "";
  }, [open]);

  // Load students + plans when the dialog opens.
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const [stuRes, planRes] = await Promise.all([
          fetch(`/api/admin/students?academyId=${academyId}`, { credentials: "same-origin" }),
          fetch(`/api/admin/package-plans?academyId=${academyId}`, { credentials: "same-origin" }),
        ]);
        const stuData = (await stuRes.json()) as { students?: Student[] };
        const planData = (await planRes.json()) as { plans?: PackagePlanApi[] };
        setStudents(stuData.students ?? []);
        // Only show active plans in the picker.
        setPlans((planData.plans ?? []).filter((p) => p.is_active).map(mapPlan));
      } catch {
        // ignore — the form will show an empty-list state
      }
    })();
  }, [open, academyId]);

  // Amount is NOT auto-filled from the package plan. The package_plans
  // table has no authoritative price field (only session_count), so
  // deriving an amount from sessionCount would fabricate a misleading
  // default (the old code did `sessionCount * 50000`, implying a fixed
  // per-session price of IDR 50,000 that does not exist in the data
  // model). The admin MUST enter the actual amount paid — partial
  // payments, overpayments, and discounts are all supported by the
  // server-side recordPayment model (payments.submitted_amount is a
  // plain numeric, validated > 0).
  // See Phase B5.2 for the full rationale.

  const handleSubmit = async () => {
    if (!studentId) {
      setError("Pilih siswa.");
      return;
    }
    if (!packagePlanId) {
      setError("Pilih paket latihan.");
      return;
    }
    const amt = Number(amount);
    if (!amt || amt <= 0) {
      setError("Jumlah harus lebih dari nol.");
      return;
    }
    if (!paymentDate) {
      setError("Tanggal pembayaran wajib diisi.");
      return;
    }
    if (!payerName.trim()) {
      setError("Nama pembayar wajib diisi.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (!idempotencyKeyRef.current) {
        idempotencyKeyRef.current = crypto.randomUUID();
      }
      const body: Record<string, unknown> = {
        studentId,
        packagePlanId,
        amount: amt,
        paymentMethod,
        paymentDate,
        payerName: payerName.trim(),
        idempotencyKey: idempotencyKeyRef.current,
      };
      if (referenceNumber.trim()) body.referenceNumber = referenceNumber.trim();
      if (notes.trim()) body.notes = notes.trim();
      const res = await adminFetch(`/api/admin/payments?academyId=${academyId}`, "POST", body);
      if (res.ok || res.status === 201) {
        toast({ title: "Pembayaran dicatat" });
        onRecorded();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Error ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal mencatat pembayaran", description: failMsg, variant: "destructive" });
    } catch {
      setError("Kesalahan jaringan");
      toast({ title: "Gagal mencatat pembayaran", description: "Kesalahan jaringan", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Catat Pembayaran Manual</DialogTitle>
          <DialogDescription>
            Mencatat pembayaran tunai atau transfer bank yang sudah dikonfirmasi dan secara otomatis membelikan paket serta membuat hak sesi.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pay-student">Siswa *</Label>
            <Select value={studentId} onValueChange={setStudentId} disabled={submitting}>
              <SelectTrigger id="pay-student">
                <SelectValue placeholder="Pilih siswa" />
              </SelectTrigger>
              <SelectContent>
                {students.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pay-plan">Paket Latihan *</Label>
            <Select value={packagePlanId} onValueChange={setPackagePlanId} disabled={submitting}>
              <SelectTrigger id="pay-plan">
                <SelectValue placeholder="Pilih paket" />
              </SelectTrigger>
              <SelectContent>
                {plans.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} ({p.sessionCount} sesi)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="pay-amount">Jumlah (IDR) *</Label>
              <Input
                id="pay-amount"
                type="number"
                min={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={submitting}
                placeholder="Masukkan jumlah dibayar (tanpa isi otomatis)"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pay-method">Metode *</Label>
              <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as "cash" | "bank_transfer")} disabled={submitting}>
                <SelectTrigger id="pay-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Tunai</SelectItem>
                  <SelectItem value="bank_transfer">Transfer Bank</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="pay-date">Tanggal Pembayaran *</Label>
              <Input id="pay-date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} disabled={submitting} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pay-ref">No. Referensi</Label>
              <Input id="pay-ref" value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} disabled={submitting} placeholder="Opsional" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pay-payer">Nama Pembayar *</Label>
            <Input id="pay-payer" value={payerName} onChange={(e) => setPayerName(e.target.value)} disabled={submitting} placeholder="Nama Orang Tua / Wali" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pay-notes">Catatan</Label>
            <Textarea id="pay-notes" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={submitting} placeholder="Opsional" rows={2} />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>
            Batal
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Mencatat…
              </>
            ) : (
              "Catat Pembayaran"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Record Expense Dialog
// ============================================================================

function RecordExpenseDialog({
  open,
  onClose,
  academyId,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  academyId: string;
  onRecorded: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [incurredOn, setIncurredOn] = useState(jakartaTodayYmd());
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setAmount("");
      setCategory("");
      setIncurredOn(jakartaTodayYmd());
      setNote("");
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  const handleSubmit = async () => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) {
      setError("Jumlah harus bilangan tidak negatif.");
      return;
    }
    if (!category.trim()) {
      setError("Kategori wajib diisi (mis. 'Peralatan', 'Sewa', 'Pengembalian').");
      return;
    }
    if (!incurredOn) {
      setError("Tanggal pengeluaran wajib diisi.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        amount: amt,
        category: category.trim(),
        incurredOn,
      };
      if (note.trim()) body.note = note.trim();
      const res = await adminFetch(`/api/admin/expenses?academyId=${academyId}`, "POST", body);
      if (res.status === 201) {
        toast({ title: "Pengeluaran dicatat" });
        onRecorded();
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      const failMsg = data.error?.message ?? `Error ${res.status}`;
      setError(failMsg);
      toast({ title: "Gagal mencatat pengeluaran", description: failMsg, variant: "destructive" });
    } catch {
      setError("Kesalahan jaringan");
      toast({ title: "Gagal mencatat pengeluaran", description: "Kesalahan jaringan", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Catat Pengeluaran</DialogTitle>
          <DialogDescription>
            Catat pengeluaran kas — peralatan, sewa, pengembalian, dll. Jumlah, kategori, dan tanggal tidak dapat diubah setelah dibuat.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="exp-amount">Jumlah (IDR) *</Label>
            <Input id="exp-amount" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} disabled={submitting} placeholder="0" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="exp-category">Kategori *</Label>
            <Input id="exp-category" value={category} onChange={(e) => setCategory(e.target.value)} disabled={submitting} placeholder="mis. Peralatan, Sewa, Pengembalian, Transport" />
            <p className="text-xs text-muted-foreground">Bebas teks. Gunakan &ldquo;Pengembalian&rdquo; untuk pengeluaran pengembalian dana.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="exp-date">Tanggal Pengeluaran *</Label>
            <Input id="exp-date" type="date" value={incurredOn} onChange={(e) => setIncurredOn(e.target.value)} disabled={submitting} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="exp-note">Catatan</Label>
            <Textarea id="exp-note" value={note} onChange={(e) => setNote(e.target.value)} disabled={submitting} placeholder="Deskripsi opsional" rows={2} />
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={submitting}>
            Batal
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Mencatat…
              </>
            ) : (
              "Catat Pengeluaran"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Silence unused-import warnings for icons that may be tree-shaken in dev.
void RefreshCw;
void Calendar;
void MessageCircle;
