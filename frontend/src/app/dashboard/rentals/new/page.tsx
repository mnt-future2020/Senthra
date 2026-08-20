import { PermissionGate } from "@/components/auth/PermissionGate";
import { RentalItemForm } from "@/components/dashboard/rentals/RentalItemForm";

export default function NewRentalItemPage() {
  return (
    <PermissionGate anyOf={["rentals.create"]}>
      <RentalItemForm />
    </PermissionGate>
  );
}
