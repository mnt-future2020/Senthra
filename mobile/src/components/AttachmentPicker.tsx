import React, { useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors } from "../lib/theme";
import { MAX_UPLOAD_BYTES, shrinkImage } from "../lib/image";

// Image attachments for composers, mirroring the web's 64×64 thumbnail grid with
// an upload tile: pick from the photo library, upload as a data URI through the
// given endpoint, keep the returned URL.

export function AttachmentPicker({
  attachments,
  onChange,
  upload,
  max,
}: {
  attachments: string[];
  onChange: (next: string[]) => void;
  upload: (image: string) => Promise<string>;
  max?: number;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const full = max !== undefined && attachments.length >= max;

  const pick = async () => {
    setError(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "images",
      quality: 0.7,
      base64: true,
    });
    if (result.canceled) return;
    // Taken and tested in one step so `base64` narrows to a string for the call below — the previous
    // shape checked `result.assets[0]?.base64` and then re-read the asset, which TypeScript cannot
    // connect back to the guard.
    const asset = result.assets[0];
    if (!asset?.base64) return;
    setUploading(true);
    try {
      // `quality` alone re-encodes but keeps every pixel, so a phone capture still arrives at
      // several MB and the endpoint — which measures the base64, 4/3 of the file — refuses it.
      // Resizing is what makes an ordinary photo fit, and it happens before the upload so the
      // spinner covers it.
      const { dataUri, bytes } = await shrinkImage(
        asset.uri,
        asset.base64,
        asset.width ?? 0,
        asset.height ?? 0,
        asset.mimeType ?? "image/jpeg",
      );
      // Only reachable when shrinking could not run — a format the decoder refused, or a device that
      // would not hold the bitmap — because a resized photo lands far under this. Saying so here
      // beats a round trip that comes back with the server's own size error and no way forward.
      if (bytes > MAX_UPLOAD_BYTES) {
        setError("That image is too large to upload. Try taking a new photo.");
        return;
      }
      const url = await upload(dataUri);
      onChange([...attachments, url]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload the image.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <View style={s.wrap}>
      <View style={s.grid}>
        {attachments.map((url) => (
          <View key={url} style={s.thumbWrap}>
            <Image source={{ uri: url }} style={s.thumb} contentFit="cover" />
            <Pressable style={s.remove} hitSlop={6} onPress={() => onChange(attachments.filter((u) => u !== url))}>
              <Ionicons name="close" size={12} color="#ffffff" />
            </Pressable>
          </View>
        ))}
        {!full ? (
          <Pressable style={s.addTile} onPress={() => void pick()} disabled={uploading}>
            {uploading ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Ionicons name="camera" size={20} color={colors.muted} />
            )}
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
    </View>
  );
}

/** Read-only attachment thumbnails for detail screens — tap to open full size. */
export function AttachmentThumbs({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <View style={s.grid}>
      {urls.map((url) => (
        <Pressable key={url} onPress={() => void Linking.openURL(url)}>
          <Image source={{ uri: url }} style={s.thumb} contentFit="cover" />
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: 6 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  thumbWrap: { position: "relative" },
  thumb: { width: 64, height: 64, borderRadius: 10, backgroundColor: colors.mutedSoft },
  remove: {
    position: "absolute",
    top: -5,
    right: -5,
    backgroundColor: colors.danger,
    borderRadius: 999,
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  addTile: {
    width: 64,
    height: 64,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  error: { fontSize: 12, color: colors.danger },
});
