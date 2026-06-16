"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { GoodsReceiptDetail } from "@/components/dashboard/goods-in/GoodsReceiptDetail";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as grnService from "@/services/goods-in.service";
import type { GoodsReceipt } from "@/types/goods-in";

// :id may be a database id OR a GRN code (the list links by code).
export default function ViewGoodsReceiptPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  return (
    <PermissionGate anyOf={["goods_in.view"]}>
      <Loader key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}

function Loader({ idOrCode }: { idOrCode: string }) {
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
  return <GoodsReceiptDetail initial={grn} />;
}
