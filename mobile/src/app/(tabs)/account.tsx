import React, { useCallback, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  changeOwnPassword,
  getMyProfile,
  getSessions,
  removeMySignature,
  revokeOtherSessions,
  updateMyProfile,
  uploadMySignature,
} from "@/services/account.service";
import { lookupPostcode } from "@/services/geo.service";
import { principalName, useAuth } from "@/lib/auth";
import { useLoad } from "@/lib/useLoad";
import { useToast } from "@/lib/toast";
import {
  Badge,
  Button,
  Card,
  ErrorText,
  InfoRow,
  ListSkeleton,
  PasswordInput,
  Screen,
  SectionTitle,
  Skeleton,
  Input,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import type { SessionInfo } from "@/types";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// ── Web AccountPanel helpers, ported ──────────────────────────────────────────

function scorePassword(pw: string): number {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^a-zA-Z0-9]/.test(pw)) score++;
  return score;
}
const STRENGTH_LABELS = ["Too short", "Weak", "Fair", "Good", "Strong"];
const STRENGTH_COLORS = [colors.danger, colors.danger, colors.warn, colors.accent, colors.success];

function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad|iOS/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

const isMobileUa = (ua: string | null) => !!ua && /Android|iPhone|iPad|iOS|Mobile/.test(ua);

function relativeTime(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const STATUS_LABELS: Record<string, string> = { active: "Active", inactive: "Inactive", suspended: "Suspended" };

/** Pick a PNG/JPG from the library, validated like the web (≤ 2 MB); null if cancelled. */
async function pickImage(): Promise<{ dataUri: string; fileName: string } | { error: string } | null> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: "images", quality: 0.8, base64: true });
  const asset = result.canceled ? null : result.assets[0];
  const base64 = asset?.base64;
  if (!asset || !base64) return null;
  const mime = asset.mimeType ?? "image/jpeg";
  if (mime !== "image/png" && mime !== "image/jpeg") return { error: "Use a PNG or JPG image." };
  if ((asset.fileSize ?? base64.length * 0.75) > MAX_IMAGE_BYTES) return { error: "Image must be under 2 MB." };
  return { dataUri: `data:${mime};base64,${base64}`, fileName: asset.fileName ?? "image.jpg" };
}

export default function AccountScreen() {
  const router = useRouter();
  const toast = useToast();
  const { principal, logout } = useAuth();

  // ── Profile (summary + edit) ────────────────────────────────────────────────
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [postcode, setPostcode] = useState("");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarData, setAvatarData] = useState<string | null>(null);
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [pcMsg, setPcMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  // The city value the postcode lookup filled — editing the postcode clears it again.
  const autofilledCity = useRef<string | null>(null);
  const seeded = useRef(false);

  const {
    data: profile,
    setData: setProfile,
    loading,
    refreshing,
    refresh: refreshProfile,
    error: profileError,
    reload: reloadProfile,
  } = useLoad(
    useCallback(async () => {
      const p = await getMyProfile();
      // Seed the edit form once — a focus refetch must not clobber edits in progress.
      if (!seeded.current) {
        seeded.current = true;
        setPhone(p.phone ?? "");
        setCity(p.city ?? "");
        setAddress1(p.addressLine1 ?? "");
        setAddress2(p.addressLine2 ?? "");
        setPostcode(p.postcode ?? "");
        setAvatarPreview(p.profileImageUrl);
      }
      return p;
    }, []),
  );

  const pickAvatar = async () => {
    setProfileMsg(null);
    const picked = await pickImage();
    if (!picked) return;
    if ("error" in picked) {
      setProfileMsg({ ok: false, text: picked.error });
      return;
    }
    setAvatarPreview(picked.dataUri);
    setAvatarData(picked.dataUri);
    setAvatarRemoved(false);
  };

  // Web's PostcodeField: uppercase as typed; editing after an autofill clears the
  // city it filled, so a stale lookup can't linger behind a changed postcode.
  const onPostcodeChange = (v: string) => {
    setPostcode(v.toUpperCase());
    setPcMsg(null);
    if (autofilledCity.current && city === autofilledCity.current) {
      setCity("");
      autofilledCity.current = null;
    }
  };

  const findAddress = async () => {
    const trimmed = postcode.trim();
    if (!trimmed) {
      setPcMsg({ ok: false, text: "Enter a postcode first." });
      return;
    }
    setLookingUp(true);
    setPcMsg(null);
    try {
      const found = await lookupPostcode(trimmed);
      if (!found) {
        setPcMsg({ ok: false, text: "Couldn't find that postcode — enter the address manually." });
        return;
      }
      if (found.city) {
        setCity(found.city);
        autofilledCity.current = found.city;
      }
      setPcMsg({ ok: true, text: "Filled from postcode — check and adjust if needed." });
    } catch {
      setPcMsg({ ok: false, text: "Couldn't look up that postcode right now." });
    } finally {
      setLookingUp(false);
    }
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    setProfileMsg(null);
    try {
      const updated = await updateMyProfile({
        phone: phone.trim(),
        addressLine1: address1.trim(),
        addressLine2: address2.trim(),
        city: city.trim(),
        postcode: postcode.trim(),
        ...(avatarData ? { profileImage: avatarData } : {}),
        ...(avatarRemoved ? { removeProfileImage: true } : {}),
      });
      setProfile(updated);
      setAvatarPreview(updated.profileImageUrl);
      setAvatarData(null);
      setAvatarRemoved(false);
      setProfileMsg(null);
      toast.success("Profile updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSavingProfile(false);
    }
  };

  // ── Password ────────────────────────────────────────────────────────────────
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const strength = scorePassword(newPassword);
  const mismatch = confirm.length > 0 && newPassword !== confirm;

  const changePassword = async () => {
    if (!currentPassword) {
      setPwError("Enter your current password.");
      return;
    }
    if (newPassword.length < 8) {
      setPwError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setPwError("Passwords don't match.");
      return;
    }
    setPwBusy(true);
    setPwError(null);
    try {
      await changeOwnPassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      toast.success("Password updated.");
      // The backend signs every OTHER device out on a password change — refetch so
      // the Devices card doesn't keep listing sessions that are already dead.
      void reloadSessions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change your password.");
    } finally {
      setPwBusy(false);
    }
  };

  // ── Signature ───────────────────────────────────────────────────────────────
  const [sigMsg, setSigMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sigBusy, setSigBusy] = useState(false);
  const signatureUrl = profile?.signatureUrl ?? null;

  const uploadSignature = async () => {
    setSigMsg(null);
    const picked = await pickImage();
    if (!picked) return;
    if ("error" in picked) {
      setSigMsg({ ok: false, text: picked.error });
      return;
    }
    setSigBusy(true);
    try {
      const updated = await uploadMySignature(picked.dataUri, picked.fileName);
      setProfile(updated);
      setSigMsg(null);
      toast.success("Signature saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setSigBusy(false);
    }
  };

  const deleteSignature = async () => {
    setSigMsg(null);
    setSigBusy(true);
    try {
      const updated = await removeMySignature();
      setProfile(updated);
      setSigMsg(null);
      toast.success("Signature removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Remove failed.");
    } finally {
      setSigBusy(false);
    }
  };

  // ── Devices ─────────────────────────────────────────────────────────────────
  const {
    data: sessions,
    loading: sessionsLoading,
    error: sessionsError,
    reload: reloadSessions,
  } = useLoad(useCallback(() => getSessions(), []));
  const [revoking, setRevoking] = useState(false);
  const others = (sessions ?? []).filter((x) => !x.current).length;

  const revokeOthers = async () => {
    setRevoking(true);
    try {
      await revokeOtherSessions();
      await reloadSessions();
      toast.success("Signed out other devices.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't sign out the other devices.");
    } finally {
      setRevoking(false);
    }
  };

  if (loading)
    return (
      <Screen>
        <Card>
          <View style={s.summaryRow}>
            <Skeleton width={52} height={52} radius={999} />
            <View style={[s.flex1, { gap: 6 }]}>
              <Skeleton width="55%" height={15} />
              <Skeleton width="70%" height={11} />
            </View>
          </View>
        </Card>
        <ListSkeleton count={3} />
      </Screen>
    );

  const user = principal?.type === "user" ? principal : null;
  const perms = user?.permissions ?? [];
  const access = perms.includes("*")
    ? "Full access"
    : perms.length === 0
      ? "No modules yet"
      : `${perms.length} permission${perms.length === 1 ? "" : "s"}`;
  const initials = principalName(principal)
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={() => {
        void refreshProfile();
        void reloadSessions();
      }}
    >
      {/* Summary (web's sticky aside ProfileCard) */}
      <Card>
        <View style={s.summaryRow}>
          {profile?.profileImageUrl ? (
            <Image source={{ uri: profile.profileImageUrl }} style={s.avatar} contentFit="cover" />
          ) : (
            <View style={s.avatarFallback}>
              <Text style={s.avatarInitials}>{initials || "?"}</Text>
            </View>
          )}
          <View style={s.flex1}>
            <Text style={s.summaryName}>{principalName(principal)}</Text>
            <Text style={s.summaryEmail}>{principal?.email ?? "—"}</Text>
          </View>
          {profile ? (
            <Badge status={profile.status} label={STATUS_LABELS[profile.status] ?? profile.status} />
          ) : null}
        </View>
        <InfoRow label="Role" value={user?.role?.name ?? "No role assigned"} />
        <InfoRow label="Access" value={access} />
        <Text style={s.note}>
          Your name, photo and role are managed by an administrator. Ask them if anything looks wrong.
        </Text>
      </Card>

      <SectionTitle>Edit profile</SectionTitle>
      {profileError && !profile ? (
        <Card>
          <ErrorText message={profileError ?? "Could not load your profile."} />
          <Button title="Retry" variant="secondary" small onPress={() => void reloadProfile()} />
        </Card>
      ) : (
      <Card>
        <Text style={s.desc}>
          Update your photo, phone and address. Your name, role and email are managed by an
          administrator.
        </Text>
        <View style={s.summaryRow}>
          {avatarPreview ? (
            <Image source={{ uri: avatarPreview }} style={s.avatar} contentFit="cover" />
          ) : (
            <View style={s.avatarFallback}>
              <Text style={s.avatarInitials}>{initials || "?"}</Text>
            </View>
          )}
          <Button
            title={avatarPreview ? "Replace" : "Upload"}
            variant="secondary"
            small
            onPress={() => void pickAvatar()}
          />
          {avatarPreview ? (
            <Button
              title="Remove"
              variant="ghost"
              small
              onPress={() => {
                setAvatarPreview(null);
                setAvatarData(null);
                setAvatarRemoved(true);
              }}
            />
          ) : null}
        </View>
        <Input label="Phone" value={phone} onChangeText={setPhone} placeholder="+44 …" keyboardType="phone-pad" />
        <Input label="City" value={city} onChangeText={setCity} />
        <Input label="Address line 1" value={address1} onChangeText={setAddress1} />
        <Input label="Address line 2" value={address2} onChangeText={setAddress2} />
        <View style={s.postcodeRow}>
          <View style={s.flex1}>
            <Input
              label="Postcode"
              value={postcode}
              onChangeText={onPostcodeChange}
              autoCapitalize="characters"
              placeholder="e.g. LS1 4DY"
              maxLength={12}
            />
          </View>
          <Button
            title="Find"
            variant="secondary"
            small
            loading={lookingUp}
            disabled={!postcode.trim()}
            onPress={() => void findAddress()}
          />
        </View>
        {pcMsg ? <Text style={pcMsg.ok ? s.okText : s.errText}>{pcMsg.text}</Text> : null}
        {profileMsg ? (
          <Text style={profileMsg.ok ? s.okText : s.errText}>{profileMsg.text}</Text>
        ) : null}
        <Button title="Save" onPress={() => void saveProfile()} loading={savingProfile} />
      </Card>
      )}

      <SectionTitle>Password</SectionTitle>
      <Card>
        <Text style={s.desc}>
          Change the password you sign in with. Your current password confirms it&rsquo;s really you.
        </Text>
        <PasswordInput
          label="Current password"
          value={currentPassword}
          onChangeText={setCurrentPassword}
          placeholder="Your current password"
        />
        <PasswordInput
          label="New password"
          value={newPassword}
          onChangeText={setNewPassword}
          placeholder="At least 8 characters"
        />
        {newPassword.length > 0 ? (
          <View style={s.strengthWrap}>
            <View style={s.strengthBars}>
              {[1, 2, 3, 4].map((i) => (
                <View
                  key={i}
                  style={[
                    s.strengthBar,
                    { backgroundColor: strength >= i ? STRENGTH_COLORS[strength] : colors.mutedSoft },
                  ]}
                />
              ))}
            </View>
            <Text style={[s.strengthLabel, { color: STRENGTH_COLORS[strength] }]}>
              {STRENGTH_LABELS[strength]}
            </Text>
          </View>
        ) : null}
        <PasswordInput
          label="Confirm new password"
          value={confirm}
          onChangeText={setConfirm}
          placeholder="Re-enter new password"
        />
        {confirm.length > 0 ? (
          <View style={s.matchRow}>
            <Ionicons
              name={mismatch ? "close-circle" : "checkmark-circle"}
              size={14}
              color={mismatch ? colors.danger : colors.success}
            />
            <Text style={[s.matchText, { color: mismatch ? colors.danger : colors.success }]}>
              {mismatch ? "Doesn't match" : "Passwords match"}
            </Text>
          </View>
        ) : null}
        <ErrorText message={pwError} />
        <Button
          title="Update password"
          onPress={() => void changePassword()}
          loading={pwBusy}
          disabled={mismatch}
        />
      </Card>

      <SectionTitle>Signature</SectionTitle>
      <Card>
        <Text style={s.desc}>
          Printed on documents you issue — like the Purchase Orders you send to suppliers. Optional.
        </Text>
        <View style={s.sigBox}>
          {signatureUrl ? (
            <Image source={{ uri: signatureUrl }} style={s.sigImage} contentFit="contain" />
          ) : (
            <Text style={s.sigPlaceholder}>No signature</Text>
          )}
        </View>
        <View style={s.buttonRow}>
          <Button
            title={signatureUrl ? "Replace" : "Upload"}
            variant="secondary"
            small
            loading={sigBusy}
            onPress={() => void uploadSignature()}
          />
          {signatureUrl ? (
            <Button title="Remove" variant="ghost" small onPress={() => void deleteSignature()} />
          ) : null}
        </View>
        <Text style={s.hintSmall}>PNG or JPG, max 2 MB. A transparent PNG looks best on documents.</Text>
        {sigMsg ? <Text style={sigMsg.ok ? s.okText : s.errText}>{sigMsg.text}</Text> : null}
      </Card>

      <SectionTitle>Devices</SectionTitle>
      <Card>
        <View style={s.devicesHeader}>
          <Text style={[s.desc, s.flex1]}>
            Where you&rsquo;re signed in. Up to 2 devices — a new sign-in drops the oldest.
          </Text>
          {(sessions ?? []).length > 0 ? (
            <View style={s.countPill}>
              <Text style={s.countPillText}>{(sessions ?? []).length}/2</Text>
            </View>
          ) : null}
        </View>
        {sessionsLoading ? (
          <View style={s.sessionRow}>
            <Skeleton width={18} height={18} radius={6} />
            <View style={[s.flex1, { gap: 5 }]}>
              <Skeleton width="45%" height={12} />
              <Skeleton width="65%" height={10} />
            </View>
          </View>
        ) : sessionsError ? (
          <ErrorText message={sessionsError} />
        ) : (sessions ?? []).length === 0 ? (
          <Text style={s.desc}>No active devices.</Text>
        ) : (
          (sessions ?? []).map((session: SessionInfo) => (
            <View key={session.id} style={s.sessionRow}>
              <Ionicons
                name={isMobileUa(session.userAgent) ? "phone-portrait" : "desktop-outline"}
                size={18}
                color={session.current ? colors.accent : colors.muted}
              />
              <View style={s.flex1}>
                <View style={s.sessionTop}>
                  <Text style={s.sessionAgent} numberOfLines={1}>
                    {deviceLabel(session.userAgent)}
                  </Text>
                  {session.current ? (
                    <View style={s.currentPill}>
                      <Text style={s.currentPillText}>This device</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={s.sessionMeta}>
                  {session.ip || "Unknown IP"} · Active {relativeTime(session.lastUsedAt)}
                </Text>
              </View>
            </View>
          ))
        )}
        {others > 0 ? (
          <Button
            title={`Sign out other device${others === 1 ? "" : "s"} (${others})`}
            variant="secondary"
            small
            loading={revoking}
            onPress={() => void revokeOthers()}
          />
        ) : null}
      </Card>

      <Button
        title="Sign Out"
        variant="danger"
        onPress={() => {
          void logout().then(() => router.replace("/login"));
        }}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  flex1: { flex: 1 },
  desc: { fontSize: 13, color: colors.muted },
  note: { fontSize: 12, color: colors.faint },
  hintSmall: { fontSize: 12, color: colors.faint },
  okText: { fontSize: 13, color: colors.success },
  errText: { fontSize: 13, color: colors.danger },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  summaryName: { fontSize: 16, fontWeight: "800", color: colors.text },
  summaryEmail: { fontSize: 13, color: colors.muted },
  avatar: { width: 52, height: 52, borderRadius: 999, backgroundColor: colors.mutedSoft },
  avatarFallback: {
    width: 52,
    height: 52,
    borderRadius: 999,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitials: { fontSize: 18, fontWeight: "800", color: colors.accent },
  strengthWrap: { flexDirection: "row", alignItems: "center", gap: 10 },
  strengthBars: { flexDirection: "row", gap: 4, flex: 1 },
  strengthBar: { flex: 1, height: 4, borderRadius: 2 },
  strengthLabel: { fontSize: 12, fontWeight: "700" },
  matchRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  matchText: { fontSize: 12, fontWeight: "600" },
  sigBox: {
    height: 90,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  sigImage: { width: "100%", height: "100%" },
  sigPlaceholder: { fontSize: 13, color: colors.faint },
  buttonRow: { flexDirection: "row", gap: 10 },
  postcodeRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  devicesHeader: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  countPill: { backgroundColor: colors.mutedSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  countPillText: { fontSize: 11, fontWeight: "700", color: colors.muted },
  sessionRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  sessionTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  sessionAgent: { fontSize: 13, fontWeight: "600", color: colors.text, flexShrink: 1 },
  sessionMeta: { fontSize: 12, color: colors.muted },
  currentPill: { backgroundColor: colors.accentSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  currentPillText: { fontSize: 11, fontWeight: "700", color: colors.accent },
});
