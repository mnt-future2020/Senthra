"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { GoodsOutDetail } from "@/components/dashboard/goods-out/GoodsOutDetail";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as goodsOutService from "@/services/goods-out.service";
import type { GoodsOut } from "@/types/goods-out";

// :id may be a database id OR a GDN code (the list links by code).
export default function ViewGoodsOutPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  return (
    <PermissionGate anyOf={["goods_out.view"]}>
      <Loader key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}

function Loader({ idOrCode }: { idOrCode: string }) {
  const [gdn, setGdn] = React.useState<GoodsOut | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    goodsOutService
      .getGoodsOut(idOrCode)
      .then((g) => active && setGdn(g))
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load this dispatch."))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [idOrCode]);

  if (loading) return <FormPageSkeleton />;
  if (error || !gdn) return <FormError message={error ?? "Dispatch not found."} />;
  // Suspense satisfies useSearchParams (the ?tab= seed) during prerender.
  return <React.Suspense fallback={<FormPageSkeleton />}><GoodsOutDetail initial={gdn} /></React.Suspense>;
}
