import React, { useCallback, useRef, useState } from "react";
import { Keyboard, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  createTransfer,
  searchCompanyCandidates,
  searchCustomerCandidates,
  uploadAttachment,
} from "@/services/transfer.service";
import { useDebouncedCallback } from "@/lib/useDebounced";
import { useToast } from "@/lib/toast";
import { AttachmentPicker } from "@/components/AttachmentPicker";
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  InfoRow,
  Input,
  Screen,
  SearchInput,
  SectionTitle,
  Stepper,
} from "@/components/ui";
import { colors } from "@/lib/theme";
import type { CompanyCandidate, CustomerCandidate, TransferOwnership } from "@/types";

type Candidate = CompanyCandidate | CustomerCandidate;

interface DraftLine {
  key: string;
  ownership: TransferOwnership;
  irmItemId?: string;
  customerStockEntryId?: string;
  itemName: string;
  code: string | null;
  quantity: number;
  max: number;
  engineerId: string;
  engineerName: string;
}

const isCompany = (c: Candidate): c is CompanyCandidate => "irmItemId" in c;
const candidateKey = (c: Candidate) =>
  isCompany(c) ? `irm-${c.irmItemId}-${c.engineerId}` : `cse-${c.customerStockEntryId}-${c.engineerId}`;

// Request stock from another engineer's van, mirroring the web TransferComposer:
// company (IRM) and customer holdings are searched together; all lines must come
// from ONE van — the first selected holder locks the source until "Start over".
export default function NewTransferScreen() {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const searchSeq = useRef(0);

  const lockedFrom = lines[0]?.engineerId ?? null;
  const lockedFromName = lines[0]?.engineerName ?? null;

  const runSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      setSearchFailed(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    try {
      // Both ownership legs in parallel, merged and sorted — like the web picker.
      const [company, customer] = await Promise.allSettled([
        searchCompanyCandidates(q.trim()),
        searchCustomerCandidates(q.trim()),
      ]);
      if (seq !== searchSeq.current) return;
      if (company.status === "rejected" && customer.status === "rejected") {
        setResults([]);
        setSearchFailed(true);
        return;
      }
      const merged: Candidate[] = [
        ...(company.status === "fulfilled" ? company.value : []),
        ...(customer.status === "fulfilled" ? customer.value : []),
      ].sort((a, b) => a.itemName.localeCompare(b.itemName));
      setResults(merged);
      setSearchFailed(false);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, []);

  const debouncedSearch = useDebouncedCallback(runSearch);

  const clearSearch = () => {
    // Both callers (adding a candidate, Start over) end the searching phase, and what comes next —
    // the quantity steppers, the reason box, Send request — is all BELOW the keyboard. Leaving it up
    // over a box that is now empty hides the very thing the tap just changed.
    Keyboard.dismiss();
    setQuery("");
    setResults([]);
    setSearchFailed(false);
    searchSeq.current++; // drop any in-flight search so it can't repopulate results
    debouncedSearch(""); // supersede any pending debounce tick
  };

  const startOver = () => {
    setLines([]);
    setError(null);
    clearSearch();
  };

  const addCandidate = (c: Candidate) => {
    setError(null);
    const key = candidateKey(c);
    if (lines.some((l) => l.key === key)) return;
    setLines((prev) => [
      ...prev,
      {
        key,
        ownership: isCompany(c) ? "company" : "customer",
        irmItemId: isCompany(c) ? c.irmItemId : undefined,
        customerStockEntryId: isCompany(c) ? undefined : (c as CustomerCandidate).customerStockEntryId,
        itemName: c.itemName,
        code: isCompany(c) ? c.code : (c.code ?? (c as CustomerCandidate).barcode ?? c.sku),
        quantity: 1,
        max: c.available,
        engineerId: c.engineerId,
        engineerName: c.engineerName,
      },
    ]);
    clearSearch();
  };

  const submit = async () => {
    Keyboard.dismiss();
    if (lines.length === 0) {
      setError("Add at least one item.");
      return;
    }
    if (!reason.trim()) {
      setError("Reason is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createTransfer({
        fromEngineerId: lines[0]!.engineerId,
        reason: reason.trim(),
        notes: notes.trim() || undefined,
        attachments: attachments.length ? attachments : undefined,
        lines: lines.map((l) => ({
          ownership: l.ownership,
          irmItemId: l.irmItemId,
          customerStockEntryId: l.customerStockEntryId,
          quantity: l.quantity,
        })),
      });
      toast.success("Transfer request sent.");
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create transfer.");
    } finally {
      setBusy(false);
    }
  };

  // Once locked, only the source engineer's matches are offered; a match on
  // another van drives the "use Start over" hint instead.
  const visibleResults = lockedFrom ? results.filter((c) => c.engineerId === lockedFrom) : results;
  const hiddenMatches = lockedFrom ? results.length - visibleResults.length : 0;
  const searched = query.trim().length >= 2 && !searching;
  const totalQty = lines.reduce((sum, l) => sum + l.quantity, 0);

  return (
    // The action is pinned rather than sitting at the foot of the scroll: with a full cart it was
    // several screens below the summary the engineer had just read, and a validation error meant
    // scrolling back down to press it again. The error rides with it for the same reason — a
    // message about why the send failed belongs beside the control that failed.
    <Screen
      footer={
        <>
          <ErrorText message={error} />
          <Button title="Send request" onPress={() => void submit()} loading={busy} />
        </>
      }
    >
      <Text style={s.hint}>
        Search items other engineers hold, pick what you need, and send a hand-over request. The
        holder approves it before stock moves.
      </Text>

      {lockedFrom ? (
        <Card style={s.lockedBanner}>
          <View style={s.lockedRow}>
            <View style={s.flex1}>
              <Text style={s.lockedLabel}>Transfer from</Text>
              <Text style={s.lockedName}>{lockedFromName}</Text>
            </View>
            <Button title="Start over" variant="ghost" small onPress={startOver} />
          </View>
        </Card>
      ) : null}

      <SearchInput
        placeholder={lockedFromName ? `Search ${lockedFromName}'s stock…` : "Search the item you need…"}
        value={query}
        onChangeText={(v) => {
          setQuery(v);
          debouncedSearch(v);
        }}
        // Runs the search NOW rather than waiting out the 300ms the engineer just decided not to
        // wait for. A single-line input blurs on submit by default, so the keyboard clears itself
        // and the results land on screen instead of behind it.
        onSubmitEditing={() => void runSearch(query)}
      />
      {searching ? <Text style={s.hint}>Searching…</Text> : null}
      {searchFailed ? (
        <Text style={s.hint}>Couldn&rsquo;t run the search just now. Check your connection and try again.</Text>
      ) : null}
      {searched && !searchFailed && visibleResults.length === 0 && results.length === 0 && !lockedFrom ? (
        <Text style={s.hint}>No engineer holds a matching item.</Text>
      ) : null}
      {searched && !searchFailed && lockedFrom && visibleResults.length === 0 ? (
        <Text style={s.hint}>
          {hiddenMatches > 0
            ? `${lockedFromName} doesn't hold a match, but another engineer does — use "Start over" to switch source.`
            : `${lockedFromName} holds no matching stock. Use "Start over" to request from someone else.`}
        </Text>
      ) : null}
      {visibleResults.map((c) => (
        <Card key={candidateKey(c)} onPress={() => addCandidate(c)}>
          <View style={s.resultTop}>
            <Text style={s.lineName} numberOfLines={2}>
              {c.itemName}
            </Text>
            <Text style={s.avail}>{c.available} avail.</Text>
          </View>
          {c.code ? <Text style={s.codeText}>{c.code}</Text> : null}
          <Text style={s.meta}>
            {isCompany(c)
              ? "IRM"
              : `Customer${(c as CustomerCandidate).customerName ? ` · ${(c as CustomerCandidate).customerName}` : ""}`}
            {" · held by "}
            {c.engineerName}
          </Text>
        </Card>
      ))}

      <SectionTitle>{lines.length ? `Selected items (${lines.length})` : "Selected items"}</SectionTitle>
      {lines.length === 0 ? (
        <EmptyState title="No items added yet" subtitle="Add one or more items above to build the transfer." />
      ) : (
        lines.map((line) => (
          <Card key={line.key}>
            <View style={s.lineRow}>
              <View style={s.lineMain}>
                <Text style={s.lineName} numberOfLines={2}>
                  {line.itemName}
                </Text>
                {line.code ? <Text style={s.codeText}>{line.code}</Text> : null}
                <Text style={s.meta}>
                  {line.ownership === "company" ? "IRM" : "Customer"} · max {line.max}
                </Text>
              </View>
              <Stepper
                value={line.quantity}
                min={1}
                max={line.max}
                onChange={(next) =>
                  setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, quantity: next } : l)))
                }
              />
            </View>
            <Button
              title="Remove"
              variant="ghost"
              small
              onPress={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
            />
          </Card>
        ))
      )}

      <Input label="Reason" required value={reason} onChangeText={setReason} multiline placeholder="Why is this stock being moved?" />
      <Input label="Notes (optional)" value={notes} onChangeText={setNotes} multiline placeholder="Any additional context…" />
      <SectionTitle>Attachments (optional)</SectionTitle>
      <AttachmentPicker attachments={attachments} onChange={setAttachments} upload={uploadAttachment} />
      <SectionTitle>Summary</SectionTitle>
      <Card>
        <InfoRow label="From" value={lockedFromName ?? ""} />
        <InfoRow label="Items" value={lines.length} />
        <InfoRow label="Total quantity" value={totalQty} />
      </Card>
    </Screen>
  );
}

const s = StyleSheet.create({
  hint: { fontSize: 13, color: colors.muted },
  lineName: { fontSize: 14, fontWeight: "700", color: colors.text, flex: 1 },
  meta: { fontSize: 12, color: colors.muted },
  codeText: { fontSize: 12, color: colors.faint },
  avail: { fontSize: 12, fontWeight: "700", color: colors.text },
  resultTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  lineRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  lineMain: { flex: 1, gap: 2 },
  lockedBanner: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  lockedRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  lockedLabel: { fontSize: 11, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  lockedName: { fontSize: 15, fontWeight: "800", color: colors.text },
  flex1: { flex: 1 },
});
