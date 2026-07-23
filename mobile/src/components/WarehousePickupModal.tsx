import React from "react";
import { Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button } from "./ui";
import { colors } from "../lib/theme";
import { joinAddress } from "../lib/format";
import type { JobKitWarehouse } from "../types";

// Where to collect a kit line: warehouse name/code, pickup address, contact
// phone (tap to call) and an Open in Maps action — mirrors the web dashboard's
// WarehousePickupModal.

export function WarehousePickupModal({
  warehouse,
  onClose,
}: {
  warehouse: JobKitWarehouse | null;
  onClose: () => void;
}) {
  if (!warehouse) return null;
  const address = joinAddress([
    warehouse.addressLine1,
    warehouse.addressLine2,
    warehouse.city,
    warehouse.county,
    warehouse.postcode,
    warehouse.country,
  ]);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || warehouse.name)}`;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable style={s.sheet} onPress={() => undefined}>
          <View style={s.header}>
            <View style={s.headerMain}>
              <Text style={s.title}>{warehouse.name}</Text>
              {warehouse.code ? <Text style={s.code}>{warehouse.code}</Text> : null}
            </View>
            <Pressable onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.muted} />
            </Pressable>
          </View>

          <Text style={s.label}>Pickup address</Text>
          <Text style={s.value}>{address || "No address on file."}</Text>

          {warehouse.contactPhone ? (
            <>
              <Text style={s.label}>Contact</Text>
              <Pressable onPress={() => void Linking.openURL(`tel:${warehouse.contactPhone}`)}>
                <Text style={s.phone}>{warehouse.contactPhone}</Text>
              </Pressable>
            </>
          ) : null}

          <Button title="Open in Maps" variant="secondary" onPress={() => void Linking.openURL(mapsUrl)} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(23,23,28,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  sheet: {
    alignSelf: "stretch",
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 18,
    gap: 8,
  },
  header: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  headerMain: { flex: 1, gap: 2 },
  title: { fontSize: 16, fontWeight: "800", color: colors.text },
  code: { fontSize: 12, fontWeight: "700", color: colors.accent },
  label: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 6,
  },
  value: { fontSize: 14, color: colors.text },
  phone: { fontSize: 14, fontWeight: "600", color: colors.accent },
});
