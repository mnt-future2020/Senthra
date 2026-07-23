import React, { useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors } from "../lib/theme";

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
    if (result.canceled || !result.assets[0]?.base64) return;
    const asset = result.assets[0];
    const dataUri = `data:${asset.mimeType ?? "image/jpeg"};base64,${asset.base64}`;
    setUploading(true);
    try {
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
