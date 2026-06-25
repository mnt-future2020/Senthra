"use client";

// ScannerInput — three-in-one barcode entry for the Goods Management flow:
//   1. Hardware/manual: a focused text input that fires onCode on Enter.
//   2. Camera live scan: toggle opens a <video> element via useBarcodeScanner.startCamera.
//   3. Photo upload: hidden file input → useBarcodeScanner.decodeImageFile → onCode.
//      Follows the DocPicker pattern (DeliveryDocuments.tsx) for the hidden-input wiring.

import * as React from "react";
import { Camera, CameraOff, ImageUp, Loader2 } from "lucide-react";

import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useDashboard } from "@/hooks/useDashboard";
import { inputCls, ghostBtn } from "@/components/ui/styles";

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
  const [uploading, setUploading] = React.useState(false);

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const textInputRef = React.useRef<HTMLInputElement>(null);

  // Focus the text input on mount so a connected scanner can type straight in.
  React.useEffect(() => {
    textInputRef.current?.focus();
  }, []);

  // Start/stop camera on toggle.
  React.useEffect(() => {
    if (cameraOpen && videoRef.current) {
      startCamera(videoRef.current, (code) => {
        onCode(code);
        // Keep camera running — warehouse staff often scan many items in sequence.
      }).catch((e) => {
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

  // Hardware / manual entry: fire on Enter, then clear.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const code = value.trim();
      if (code) {
        onCode(code);
        setValue("");
      }
    }
  };

  // Camera toggle.
  const toggleCamera = () => {
    if (disabled) return;
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
          className={inputCls}
          aria-label="Barcode entry"
        />

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

      {/* Row 2: live camera preview (only rendered when open) */}
      {cameraOpen && (
        <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-black">
          <video
            ref={videoRef}
            className="w-full max-h-64 object-cover"
            autoPlay
            playsInline
            muted
          />
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
