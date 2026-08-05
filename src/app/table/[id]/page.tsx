"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

// Backward-compatible redirect: /table/5 → /menu?table=5
export default function TableRedirect() {
  const params = useParams();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/menu?table=${params.id}`);
  }, [params.id, router]);

  return (
    <div className="min-h-screen bg-[#FAF6F0] flex items-center justify-center text-[#4E342E] text-sm font-bold">
      Opening your table menu...
    </div>
  );
}
