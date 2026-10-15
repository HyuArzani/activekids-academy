"use client";

import { useState, useRef } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  AlertCircle,
  Loader2,
  User,
  Phone,
  Mail,
  MessageSquare,
  Calendar,
  FileText,
  Rocket,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// ============================================================================
// Types
// ============================================================================

interface RegistrationFormData {
  parentFullName: string;
  parentPhone: string;
  parentEmail: string;
  preferredContact: "phone" | "email" | "whatsapp" | "";
  childFullName: string;
  childDateOfBirth: string;
  classPreference: string;
  preferredDay: string;
  notes: string;
}

const INITIAL_DATA: RegistrationFormData = {
  parentFullName: "",
  parentPhone: "",
  parentEmail: "",
  preferredContact: "",
  childFullName: "",
  childDateOfBirth: "",
  classPreference: "",
  preferredDay: "",
  notes: "",
};

type Step = 1 | 2 | 3 | "success";
type SubmitState = "idle" | "submitting" | "error";

// ============================================================================
// Component
// ============================================================================

interface PublicRegistrationFormProps {
  academyId: string;
  academyName: string;
  onBack: () => void;
}

export function PublicRegistrationForm({ academyId, academyName, onBack }: PublicRegistrationFormProps) {
  const [step, setStep] = useState<Step>(1);
  const [data, setData] = useState<RegistrationFormData>(INITIAL_DATA);
  const [errors, setErrors] = useState<Partial<Record<keyof RegistrationFormData, string>>>({});
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const idempotencyKeyRef = useRef<string>("");

  const update = (field: keyof RegistrationFormData, value: string) => {
    setData((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validateStep1 = (): boolean => {
    const e: Partial<Record<keyof RegistrationFormData, string>> = {};
    if (!data.parentFullName.trim()) e.parentFullName = "Nama orang tua wajib diisi";
    if (!data.parentPhone.trim()) e.parentPhone = "Nomor telepon wajib diisi";
    if (data.parentEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.parentEmail)) {
      e.parentEmail = "Format email tidak valid";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const validateStep2 = (): boolean => {
    const e: Partial<Record<keyof RegistrationFormData, string>> = {};
    if (!data.childFullName.trim()) e.childFullName = "Nama anak wajib diisi";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleNext = () => {
    if (step === 1 && validateStep1()) setStep(2);
    else if (step === 2 && validateStep2()) setStep(3);
  };

  const handleBack = () => {
    if (step === 3) setStep(2);
    else if (step === 2) setStep(1);
  };

  const handleSubmit = async () => {
    setSubmitState("submitting");
    setSubmitError(null);
    try {
      if (!idempotencyKeyRef.current) {
        idempotencyKeyRef.current = crypto.randomUUID();
      }
      const body: Record<string, unknown> = {
        academyId,
        parentFullName: data.parentFullName.trim(),
        parentPhone: data.parentPhone.trim(),
        childFullName: data.childFullName.trim(),
        idempotencyKey: idempotencyKeyRef.current,
      };
      if (data.parentEmail.trim()) body.parentEmail = data.parentEmail.trim();
      if (data.preferredContact) body.preferredContact = data.preferredContact;
      if (data.childDateOfBirth) body.childDateOfBirth = data.childDateOfBirth;
      if (data.classPreference.trim()) body.classPreference = data.classPreference.trim();
      if (data.preferredDay.trim()) body.preferredDay = data.preferredDay.trim();
      if (data.notes.trim()) body.notes = data.notes.trim();

      const res = await fetch("/api/public/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok || res.status === 201) {
        const json = (await res.json()) as { applicationId: string };
        setApplicationId(json.applicationId);
        setStep("success");
        return;
      }

      const errData = (await res.json()) as { error?: { message?: string; detail?: string } };
      if (res.status === 429) {
        setSubmitError("Terlalu banyak percobaan pendaftaran. Silakan coba lagi nanti.");
      } else if (res.status === 422) {
        setSubmitError(errData.error?.detail ?? errData.error?.message ?? "Silakan periksa data yang dimasukkan.");
      } else if (res.status === 409) {
        setSubmitError("Pendaftaran dengan data ini mungkin sudah ada. Silakan hubungi akademi.");
      } else {
        setSubmitError(errData.error?.message ?? `Kesalahan ${res.status}`);
      }
      setSubmitState("error");
    } catch {
      setSubmitError("Kesalahan jaringan. Silakan periksa koneksi dan coba lagi.");
      setSubmitState("error");
    } finally {
      if (step !== "success") setSubmitState("idle");
    }
  };

  // ===== Success state =====
  if (step === "success") {
    return (
      <div className="min-h-screen bg-background">
        <div className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3 sm:px-6">
            <p className="text-sm font-semibold">{academyName}</p>
            <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
              <ArrowLeft className="h-4 w-4" aria-hidden /> Kembali ke akademi
            </Button>
          </div>
        </div>
        <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
          <Card className="border-emerald-200 dark:border-emerald-900">
            <CardContent className="p-8 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
                <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" aria-hidden />
              </div>
              <h2 className="mt-4 text-xl font-bold">Pendaftaran Terkirim!</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Terima kasih, {data.parentFullName.split(" ")[0]}. Kami telah menerima pendaftaran untuk{" "}
                <span className="font-medium text-foreground">{data.childFullName}</span>.
              </p>
              <div className="mt-4 rounded-lg bg-muted/50 p-3 text-left">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Nomor Referensi
                </p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{applicationId}</p>
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                Tim kami akan meninjau pendaftaran dan menghubungi Anda dalam 1–2 hari kerja di{" "}
                <span className="font-medium text-foreground">{data.parentPhone}</span>
                {data.parentEmail && <> atau <span className="font-medium text-foreground">{data.parentEmail}</span></>}.
              </p>
              <Button variant="outline" className="mt-6 gap-2" onClick={onBack}>
                <ArrowLeft className="h-4 w-4" aria-hidden /> Kembali ke Halaman Akademi
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const steps = [
    { num: 1, label: "Orang Tua/Wali", icon: User },
    { num: 2, label: "Anak", icon: Calendar },
    { num: 3, label: "Preferensi", icon: FileText },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* ===== Top Bar ===== */}
      <div className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3 sm:px-6">
          <p className="text-sm font-semibold">{academyName}</p>
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
            <ArrowLeft className="h-4 w-4" aria-hidden /> Batal
          </Button>
        </div>
      </div>

      {/* ===== Progress Steps ===== */}
      <div className="mx-auto max-w-2xl px-4 pt-8 sm:px-6">
        <div className="flex items-center justify-center gap-2 sm:gap-4">
          {steps.map((s, i) => {
            const Icon = s.icon;
            const isActive = step === s.num;
            const isComplete = typeof step === "number" && step > s.num;
            return (
              <div key={s.num} className="flex items-center">
                <div className="flex flex-col items-center gap-1">
                  <div
                    className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors ${
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : isComplete
                          ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isComplete ? <Check className="h-5 w-5" aria-hidden /> : <Icon className="h-5 w-5" aria-hidden />}
                  </div>
                  <span className={`text-xs ${isActive ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                    {s.label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div className={`mx-2 h-px w-8 sm:w-16 ${isComplete ? "bg-emerald-300 dark:bg-emerald-800" : "bg-muted"}`} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ===== Form ===== */}
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {step === 1 && "Informasi Orang Tua/Wali"}
              {step === 2 && "Informasi Anak"}
              {step === 3 && "Preferensi Kelas"}
            </CardTitle>
            <CardDescription>
              {step === 1 && "Beritahu kami tentang diri Anda agar kami dapat menghubungi Anda."}
              {step === 2 && "Beritahu kami tentang anak Anda yang ingin bergabung."}
              {step === 3 && "Bantu kami mencocokkan anak Anda dengan kelas yang tepat."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Step 1: Parent */}
            {step === 1 && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="parent-name">
                    Nama Lengkap <span className="text-destructive">*</span>
                  </Label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      id="parent-name"
                      value={data.parentFullName}
                      onChange={(e) => update("parentFullName", e.target.value)}
                      placeholder="mis. Budi Santoso"
                      className="pl-9"
                      aria-invalid={!!errors.parentFullName}
                    />
                  </div>
                  {errors.parentFullName && <p className="text-xs text-destructive">{errors.parentFullName}</p>}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="parent-phone">
                    Nomor Telepon <span className="text-destructive">*</span>
                  </Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      id="parent-phone"
                      value={data.parentPhone}
                      onChange={(e) => update("parentPhone", e.target.value)}
                      placeholder="+62 812 3456 7890"
                      className="pl-9"
                      aria-invalid={!!errors.parentPhone}
                    />
                  </div>
                  {errors.parentPhone && <p className="text-xs text-destructive">{errors.parentPhone}</p>}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="parent-email">Email (opsional)</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      id="parent-email"
                      type="email"
                      value={data.parentEmail}
                      onChange={(e) => update("parentEmail", e.target.value)}
                      placeholder="orangtua@contoh.com"
                      className="pl-9"
                      aria-invalid={!!errors.parentEmail}
                    />
                  </div>
                  {errors.parentEmail && <p className="text-xs text-destructive">{errors.parentEmail}</p>}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="preferred-contact">Metode Kontak yang Disukai</Label>
                  <Select
                    value={data.preferredContact}
                    onValueChange={(v) => update("preferredContact", v)}
                  >
                    <SelectTrigger id="preferred-contact">
                      <SelectValue placeholder="Pilih…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="phone">Telepon</SelectItem>
                      <SelectItem value="email">Email</SelectItem>
                      <SelectItem value="whatsapp">WhatsApp</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            {/* Step 2: Child */}
            {step === 2 && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="child-name">
                    Nama Lengkap Anak <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="child-name"
                    value={data.childFullName}
                    onChange={(e) => update("childFullName", e.target.value)}
                    placeholder="mis. Andi Santoso"
                    aria-invalid={!!errors.childFullName}
                  />
                  {errors.childFullName && <p className="text-xs text-destructive">{errors.childFullName}</p>}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="child-dob">Tanggal Lahir (opsional)</Label>
                  <Input
                    id="child-dob"
                    type="date"
                    value={data.childDateOfBirth}
                    onChange={(e) => update("childDateOfBirth", e.target.value)}
                    max={new Date().toISOString().split("T")[0]}
                  />
                  <p className="text-xs text-muted-foreground">Membantu kami menempatkan anak di kelompok usia yang tepat.</p>
                </div>
              </>
            )}

            {/* Step 3: Preferences */}
            {step === 3 && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="class-pref">Kelas yang Diinginkan (opsional)</Label>
                  <Input
                    id="class-pref"
                    value={data.classPreference}
                    onChange={(e) => update("classPreference", e.target.value)}
                    placeholder="mis. Semangat, Membara"
                  />
                  <p className="text-xs text-muted-foreground">Kosongkan jika tidak yakin — kami dapat membantu memilih.</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="preferred-day">Hari Latihan yang Diinginkan (opsional)</Label>
                  <Select
                    value={data.preferredDay}
                    onValueChange={(v) => update("preferredDay", v === "none" ? "" : v)}
                  >
                    <SelectTrigger id="preferred-day">
                      <SelectValue placeholder="Pilih…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Tidak ada preferensi</SelectItem>
                      <SelectItem value="Sunday">Minggu</SelectItem>
                      <SelectItem value="Monday">Senin</SelectItem>
                      <SelectItem value="Tuesday">Selasa</SelectItem>
                      <SelectItem value="Wednesday">Rabu</SelectItem>
                      <SelectItem value="Thursday">Kamis</SelectItem>
                      <SelectItem value="Friday">Jumat</SelectItem>
                      <SelectItem value="Saturday">Sabtu</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="notes">Catatan Tambahan (opsional)</Label>
                  <Textarea
                    id="notes"
                    value={data.notes}
                    onChange={(e) => update("notes", e.target.value)}
                    placeholder="Permintaan khusus, kondisi medis, atau pertanyaan?"
                    rows={3}
                  />
                </div>
              </>
            )}

            {/* Submit error */}
            {submitError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" aria-hidden />
                <p className="text-sm text-destructive">{submitError}</p>
              </div>
            )}

            {/* Navigation buttons */}
            <div className="flex items-center justify-between border-t pt-4">
              {step > 1 ? (
                <Button variant="outline" onClick={handleBack} className="gap-2">
                  <ArrowLeft className="h-4 w-4" aria-hidden /> Kembali
                </Button>
              ) : (
                <span />
              )}
              {step < 3 ? (
                <Button onClick={handleNext} className="gap-2">
                  Lanjut <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
              ) : (
                <Button
                  onClick={handleSubmit}
                  disabled={submitState === "submitting"}
                  className="gap-2 bg-emerald-600 hover:bg-emerald-700"
                >
                  {submitState === "submitting" ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Mengirim…
                    </>
                  ) : (
                    <>
                      <Rocket className="h-4 w-4" aria-hidden /> Kirim Pendaftaran
                    </>
                  )}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Trust indicators */}
        <p className="mt-4 text-center text-xs text-muted-foreground">
          🔒 Data Anda aman. Kami hanya menggunakannya untuk memproses pendaftaran Anda.
        </p>
      </div>
    </div>
  );
}
