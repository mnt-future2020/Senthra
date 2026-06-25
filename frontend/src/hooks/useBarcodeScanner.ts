"use client";

import { useRef, useCallback } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import type { IScannerControls } from "@zxing/browser";

import { readFileAsDataUrl } from "@/lib/image";

// Hook wrapping @zxing/browser's BrowserMultiFormatReader for three scan modes:
//   1. Hardware / manual entry  — handled by the text input in ScannerInput (not this hook)
//   2. Live camera             — startCamera(videoEl, onCode)
//   3. Image-file upload       — decodeImageFile(file) → Promise<string> (the decoded text)
//
// Call stop() to tear down an active camera session before unmounting.

export function useBarcodeScanner() {
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);

  function getReader(): BrowserMultiFormatReader {
    if (!readerRef.current) {
      readerRef.current = new BrowserMultiFormatReader();
    }
    return readerRef.current;
  }

  const stop = useCallback(() => {
    if (controlsRef.current) {
      try {
        controlsRef.current.stop();
      } catch {
        // ignore errors on teardown
      }
      controlsRef.current = null;
    }
  }, []);

  const startCamera = useCallback(
    async (
      videoEl: HTMLVideoElement,
      onCode: (code: string) => void,
    ): Promise<void> => {
      // Stop any existing session first.
      stop();
      const reader = getReader();
      const controls = await reader.decodeFromVideoDevice(
        undefined,
        videoEl,
        (result) => {
          if (result) {
            onCode(result.getText());
          }
        },
      );
      controlsRef.current = controls;
    },
    [stop],
  );

  const decodeImageFile = useCallback(async (file: File): Promise<string> => {
    const dataUrl = await readFileAsDataUrl(file);
    const reader = getReader();
    try {
      const result = await reader.decodeFromImageUrl(dataUrl);
      return result.getText();
    } catch {
      throw new Error("Couldn't read a barcode from that image.");
    }
  }, []);

  return { startCamera, stop, decodeImageFile };
}
