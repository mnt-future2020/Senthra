"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { GoodsReceiptForm } from "@/components/dashboard/goods-in/GoodsReceiptForm";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as grnService from "@/services/goods-in.service";
import type { GoodsReceipt } from "@/types/goods-in";

// :id may be a database id OR a GRN code (the list/detail link by code).
export default function EditGoodsReceiptPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  return (
    <PermissionGate anyOf={["goods_in.edit"]}>
      <Loader key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}

function Loader({ idOrCode }: { idOrCode: string }) {
  const router = useRouter();
  const [grn, setGrn] = React.useState<GoodsReceipt | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    grnService
      .getGoodsReceipt(idOrCode)
      .then((g) => active && setGrn(g))
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load this goods receipt."))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [idOrCode]);

  if (loading) return <FormPageSkeleton />;
  if (error || !grn) return <FormError message={error ?? "Goods receipt not found."} />;

  // Only draft goods receipts are editable. Once completed/cancelled it's locked.
  if (grn.status !== "draft") {
    return (
      <div className="mx-auto w-full max-w-lg py-16 text-center">
        <p className="text-sm font-extrabold text-[var(--ink)]">This goods receipt can&apos;t be edited.</p>
        <p className="mt-1.5 text-xs text-[var(--muted)]">Only draft receipts are editable. {grn.code} is {grn.status}.</p>
        <button type="button" onClick={() => router.push(`/dashboard/goods-in/${grn.code}`)} className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90">
          View goods receipt
        </button>
      </div>
    );
  }

  return <GoodsReceiptForm mode="edit" order={grn} />;
}
