"use client";

import { Suspense } from "react";
import CustomerMenuApp from "@/components/rms/CustomerMenuApp";

export default function CustomerMenuPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#FAF6F0] flex items-center justify-center text-[#4E342E] text-sm font-bold">
          Loading menu...
        </div>
      }
    >
      <CustomerMenuApp />
    </Suspense>
  );
}
