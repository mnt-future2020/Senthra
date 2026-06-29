"use client";

// ScannerInput — three-in-one barcode entry for the Goods Management flow:
//   1. Hardware/manual: a focused text input that fires onCode on Enter.
//   2. Camera live scan: toggle opens a <video> element via useBarcodeScanner.startCamera.
//   3. Photo upload: hidden file input → useBarcodeScanner.decodeImageFile → onCode.
//      Follows the DocPicker pattern (DeliveryDocuments.tsx) for the hidden-input wiring.

import * as React from "react";
import { Camera, CameraOff, CornerDownLeft, ImageUp, Loader2, ScanLine } from "lucide-react";

import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useDashboard } from "@/hooks/useDashboard";
import { ghostBtn } from "@/components/ui/styles";

interface ScannerInputProps {
  onCode: (code: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ScannerInput({
  onCode,
  disabled = false,
  placeholder = "Scan or type a barcode / code…",
}: ScannerInputProps) {
  const { pushToast } = useDashboard();
  const { startCamera, stop, decodeImageFile } = useBarcodeScanner();

  const [value, setValue] = React.useState("");
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [cameraActive, setCameraActive] = React.useState(false); // true once the stream is live
  const [uploading, setUploading] = React.useState(false);

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const textInputRef = React.useRef<HTMLInputElement>(null);

  // Focus the text input on mount so a connected scanner can type straight in.
  React.useEffect(() => {
    textInputRef.current?.focus();
  }, []);

  // Start/stop camera on toggle. The <video> is kept hidden behind a "Starting…" placeholder until
  // the stream actually attaches (cameraActive), so a failed start (e.g. no camera) never flashes a
  // black box — it just shows the placeholder for a moment, then the error toast.
  React.useEffect(() => {
    if (cameraOpen && videoRef.current) {
      startCamera(videoRef.current, (code) => {
        onCode(code);
        // Keep camera running — warehouse staff often scan many items in sequence.
      })
        .then(() => setCameraActive(true))
        .catch((e) => {
          pushToast(
            e instanceof Error ? e.message : "Camera unavailable.",
            "alert",
          );
          setCameraOpen(false);
        });
    } else {
      stop();
    }
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOpen]);

  // Hardware / manual entry: submit the typed code — fired by Enter or the inline "Add" button.
  const submit = () => {
    const code = value.trim();
    if (!code || disabled) return;
    onCode(code);
    setValue("");
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  // Camera toggle. Reset "active" so the preview stays hidden until the stream really starts.
  const toggleCamera = () => {
    if (disabled) return;
    setCameraActive(false);
    setCameraOpen((prev) => !prev);
  };

  // Image-file decode (hidden input pattern from DocPicker / DeliveryDocuments).
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so the same file can be re-selected if needed.
    if (fileInputRef.current) fileInputRef.current.value = "";
    setUploading(true);
    try {
      const code = await decodeImageFile(file);
      onCode(code);
    } catch (err) {
      pushToast(
        err instanceof Error ? err.message : "Could not decode the image.",
        "alert",
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Row 1: text input + action buttons */}
      <div className="flex items-center gap-2">
        {/* Scan field: left scan-icon for affordance + a clear Enter cue (becomes a clickable "Add"
            button while typing) so it's obvious a typed code is submitted with Enter. */}
        <div className="relative flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] transition-all focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent)]/15">
          <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
          <input
            ref={textInputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-xl bg-transparent py-2.5 pl-9 pr-24 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--faint)] disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Barcode entry"
          />
          {value.trim() ? (
            <button
              type="button"
              onClick={submit}
              disabled={disabled}
              className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[11px] font-extrabold text-white transition-all hover:opacity-90 disabled:opacity-60"
            >
              Add <CornerDownLeft className="h-3 w-3" />
            </button>
          ) : (
            <span className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1 text-[10px] font-bold text-[var(--faint)]">
              <CornerDownLeft className="h-3 w-3" /> Enter
            </span>
          )}
        </div>

        {/* Camera toggle */}
        <button
          type="button"
          onClick={toggleCamera}
          disabled={disabled}
          title={cameraOpen ? "Stop camera" : "Scan with camera"}
          aria-pressed={cameraOpen}
          className={ghostBtn}
        >
          {cameraOpen ? (
            <CameraOff className="h-4 w-4" />
          ) : (
            <Camera className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">
            {cameraOpen ? "Stop camera" : "Scan with camera"}
          </span>
        </button>

        {/* Upload photo */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          title="Upload a photo of a barcode"
          className={ghostBtn}
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ImageUp className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">Upload photo</span>
        </button>

        {/* Hidden file input — accepts common image formats */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onFileChange}
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>

      {/* Row 2: live camera preview. The <video> stays invisible behind a neutral "Starting camera…"
          placeholder until the stream attaches — so a failed start never flashes a black box. */}
      {cameraOpen && (
        <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]">
          <div className="relative min-h-[12rem]">
            <video
              ref={videoRef}
              className={`max-h-64 w-full bg-black object-cover transition-opacity ${cameraActive ? "opacity-100" : "opacity-0"}`}
              autoPlay
              playsInline
              muted
            />
            {!cameraActive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[var(--muted)]">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-xs font-semibold">Starting camera…</span>
              </div>
            )}
          </div>
          <p className="px-3 py-2 text-center text-[11px] text-[var(--faint)]">
            Point the camera at a barcode. It will scan automatically.
          </p>
        </div>
      )}

      {/* Hint */}
      {!cameraOpen && (
        <p className="text-[11px] text-[var(--faint)]">
          Connect a USB/Bluetooth scanner and scan directly, or type a code and
          press Enter.
        </p>
      )}
    </div>
  );
}
